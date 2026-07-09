import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
export const ALLOWED_MIME_PREFIXES = ["video/", "image/", "audio/"] as const;
export const PRESIGN_EXPIRES_SECONDS = 900;

export interface ObjectStorageLocation {
  bucket: string;
  key: string;
  publicUrl?: string;
}

export interface HeadObjectResult {
  exists: boolean;
  contentLength?: number;
  contentType?: string;
}

let s3Client: S3Client | null = null;

export function getS3Client(): S3Client {
  if (s3Client) {
    return s3Client;
  }

  const endpoint = process.env.OBJECT_STORAGE_ENDPOINT?.trim();
  const region = process.env.OBJECT_STORAGE_REGION?.trim() || "us-east-1";
  const accessKeyId = process.env.OBJECT_STORAGE_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY?.trim();

  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error("Object storage is not configured");
  }

  s3Client = new S3Client({
    endpoint,
    region,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true
  });

  return s3Client;
}

export function resetS3ClientForTests(): void {
  s3Client = null;
}

export function getObjectStorageBucket(): string {
  return process.env.OBJECT_STORAGE_BUCKET?.trim() || "ai-video-assistant";
}

export function createStorageLocation(key: string): ObjectStorageLocation {
  const bucket = getObjectStorageBucket();
  const publicBase = process.env.OBJECT_STORAGE_PUBLIC_URL?.trim();

  return {
    bucket,
    key,
    publicUrl: publicBase
      ? `${publicBase.replace(/\/$/, "")}/${key}`
      : undefined
  };
}

export async function createPresignedPutUrl(
  key: string,
  contentType: string,
  expiresIn = PRESIGN_EXPIRES_SECONDS
): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: getObjectStorageBucket(),
    Key: key,
    ContentType: contentType
  });

  return getSignedUrl(getS3Client(), command, { expiresIn });
}

/**
 * Short-lived presigned GET URL so the dashboard can play/download a finished
 * render output without exposing the bucket publicly. Caller (route) enforces
 * ownership before handing the URL to the client.
 */
export async function createPresignedGetUrl(
  key: string,
  expiresIn = PRESIGN_EXPIRES_SECONDS
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: getObjectStorageBucket(),
    Key: key
  });

  return getSignedUrl(getS3Client(), command, { expiresIn });
}

/**
 * Server-side upload of raw bytes (e.g. a downloaded rendered video) to object
 * storage. Unlike {@link createPresignedPutUrl} (which is for browser uploads),
 * this is used by the worker to persist provider-generated assets we fetch
 * server-side so we own a non-expiring copy. Key must be opaque/UUID-based.
 */
export async function putObjectFromBuffer(
  key: string,
  body: Uint8Array,
  contentType: string
): Promise<void> {
  await getS3Client().send(
    new PutObjectCommand({
      Bucket: getObjectStorageBucket(),
      Key: key,
      Body: body,
      ContentType: contentType
    })
  );
}

/**
 * Download an object's bytes (worker uses this to fetch talking-head clips,
 * source assets, and BGM from R2 to a local tmp dir for ffmpeg).
 */
export async function getObjectToBuffer(key: string): Promise<Uint8Array> {
  const response = await getS3Client().send(
    new GetObjectCommand({ Bucket: getObjectStorageBucket(), Key: key })
  );
  if (!response.Body) return new Uint8Array();
  return new Uint8Array(await response.Body.transformToByteArray());
}

export async function headObject(key: string): Promise<HeadObjectResult> {
  try {
    const response = await getS3Client().send(
      new HeadObjectCommand({
        Bucket: getObjectStorageBucket(),
        Key: key
      })
    );

    return {
      exists: true,
      contentLength: response.ContentLength,
      contentType: response.ContentType
    };
  } catch (error) {
    const statusCode =
      typeof error === "object" && error !== null && "$metadata" in error
        ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
        : undefined;

    if (statusCode === 404) {
      return { exists: false };
    }

    const name = typeof error === "object" && error !== null && "name" in error ? String(error.name) : "";
    if (name === "NotFound" || name === "NoSuchKey") {
      return { exists: false };
    }

    throw error;
  }
}

export function isAllowedMimeType(contentType: string): boolean {
  return ALLOWED_MIME_PREFIXES.some((prefix) => contentType.startsWith(prefix));
}

export function inferAssetTypeFromMime(mimeType: string): "video" | "image" | "audio" {
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("image/")) return "image";
  return "audio";
}
