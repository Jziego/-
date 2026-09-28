import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl, S3RequestPresigner } from "@aws-sdk/s3-request-presigner";

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
  // CDN 域名（Cloudflare R2 自定义域名）设置时：直接对 CDN 主机名签名，生成
  // https://cdn.example.com/key?X-Amz-... 形态的 URL。R2 要求签名与访问域名一致，
  // 因此不能先按源站签名再替换 host。不设该变量时行为与原来完全一致（源站 getSignedUrl）。
  const cdnBase = process.env.OBJECT_STORAGE_CDN_URL?.trim();
  if (cdnBase) {
    return presignGetViaCdnHost(key, cdnBase, expiresIn);
  }
  const command = new GetObjectCommand({
    Bucket: getObjectStorageBucket(),
    Key: key
  });

  return getSignedUrl(getS3Client(), command, { expiresIn });
}

/**
 * 对 R2 自定义域名做 GET 预签名。不走 getSignedUrl（它会把 bucket 拼进 path/host），
 * 而是直接用 S3RequestPresigner 签一个「hostname=CDN 域名、path=/key」的请求——
 * R2 自定义域名把域名映射到 bucket 根，路径里不能再带 bucket 名。
 */
async function presignGetViaCdnHost(key: string, cdnBase: string, expiresIn: number): Promise<string> {
  const base = new URL(cdnBase);
  if (base.protocol !== "https:" && base.protocol !== "http:") {
    throw new Error(`OBJECT_STORAGE_CDN_URL 协议非法：${cdnBase}`);
  }
  const client = getS3Client();
  // client.config 携带 sha256 实现（与 getSignedUrl 内部同源）
  const presigner = new S3RequestPresigner({ ...client.config });
  const request = {
    method: "GET",
    protocol: base.protocol,
    hostname: base.host,
    path: `/${key}`,
    query: {},
    headers: { host: base.host }
  };
  const signed = (await presigner.presign(request as never, { expiresIn })) as {
    path: string;
    query: Record<string, string | undefined>;
  };
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(signed.query)) {
    if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  }
  return `${base.protocol}//${base.host}${signed.path}?${qs.toString()}`;
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

/**
 * Download only the first `length` bytes of an object via a ranged GET. Used
 * by the upload-confirm flow to verify magic bytes without fetching the whole
 * file (which can be up to 200 MB). Returns an empty Uint8Array if the object
 * has no body.
 */
export async function getFirstBytes(key: string, length: number): Promise<Uint8Array> {
  const response = await getS3Client().send(
    new GetObjectCommand({
      Bucket: getObjectStorageBucket(),
      Key: key,
      Range: `bytes=0-${Math.max(0, length - 1)}`,
    }),
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

/**
 * Best-effort object deletion. Swallows "not found" so DB-record deletion is
 * never blocked by a missing/stale S3 object — the DB row is the source of
 * truth.
 *
 * CONTRACT: this function NEVER rejects. All non-config errors are logged via
 * console.warn and swallowed (NoSuchBucket included — it surfaces via warn for
 * operators). Callers MUST NOT wrap in try/catch; if this contract ever
 * changes, update all call sites (asset deletion, output deletion).
 */
export async function deleteObject(key: string): Promise<void> {
  try {
    await getS3Client().send(
      new DeleteObjectCommand({ Bucket: getObjectStorageBucket(), Key: key })
    );
  } catch (error) {
    const statusCode =
      typeof error === "object" && error !== null && "$metadata" in error
        ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
        : undefined;
    const name = typeof error === "object" && error !== null && "name" in error ? String(error.name) : "";

    // NoSuchBucket signals config drift (wrong bucket name), not a missing
    // object — warn so operators notice; still swallow (NEVER rejects contract).
    if (name === "NoSuchBucket") {
      console.warn(`[storage] deleteObject: bucket missing for ${key}:`, error);
      return;
    }
    if (statusCode === 404 || name === "NotFound" || name === "NoSuchKey") return;

    console.warn(`[storage] deleteObject failed for ${key}:`, name || error);
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
