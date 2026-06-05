export interface ObjectStorageLocation {
  bucket: string;
  key: string;
  publicUrl?: string;
}

export function createStorageLocation(key: string): ObjectStorageLocation {
  const bucket = process.env.OBJECT_STORAGE_BUCKET ?? "ai-video-assistant-dev";
  const endpoint = process.env.OBJECT_STORAGE_ENDPOINT;

  return {
    bucket,
    key,
    publicUrl: endpoint ? `${endpoint.replace(/\/$/, "")}/${bucket}/${key}` : undefined
  };
}

export function createSignedUploadUrl(key: string): string {
  const endpoint = process.env.OBJECT_STORAGE_ENDPOINT ?? "https://object-storage.local";
  return `${endpoint.replace(/\/$/, "")}/signed-upload/${encodeURIComponent(key)}`;
}
