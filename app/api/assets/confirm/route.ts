import { jsonError, jsonOk } from "@/lib/api-response";
import { hasObjectStorage } from "@/lib/env";
import { nowIso } from "@/lib/ids";
import { getAssetRepository, getStoreRepository } from "@/lib/repositories";
import { demoOwnerId } from "@/lib/runtime-store";
import { confirmAssetUploadSchema } from "@/lib/schemas";
import { MAX_UPLOAD_BYTES, headObject } from "@/lib/storage";

export async function POST(request: Request) {
  if (!hasObjectStorage()) {
    return jsonError("Object storage is not configured", 503);
  }

  const body = await request.json();
  const parsed = confirmAssetUploadSchema.safeParse(body);

  if (!parsed.success) {
    return jsonError(parsed.error.issues[0]?.message ?? "Invalid confirm payload");
  }

  const input = parsed.data;
  const ownerId = input.ownerId ?? demoOwnerId;
  const expectedPrefix = `stores/${input.storeId}/assets/${input.assetId}-`;

  if (!input.storageKey.startsWith(expectedPrefix)) {
    return jsonError("storageKey does not match asset and store", 400);
  }

  const store = await getStoreRepository().findById(input.storeId);
  if (!store) {
    return jsonError("Store not found", 404);
  }

  const existing = await getAssetRepository().findById(input.assetId);
  if (existing) {
    return jsonError("Asset already confirmed", 409);
  }

  const head = await headObject(input.storageKey);
  if (!head.exists) {
    return jsonError("Uploaded object not found in storage", 404);
  }

  const sizeBytes = head.contentLength ?? input.sizeBytes;
  if (!sizeBytes || sizeBytes <= 0 || sizeBytes > MAX_UPLOAD_BYTES) {
    return jsonError("Uploaded object size is invalid or exceeds limit", 400);
  }

  const asset = await getAssetRepository().create({
    id: input.assetId,
    ownerId,
    storeId: input.storeId,
    type: input.type,
    originalFilename: input.originalFilename,
    storageKey: input.storageKey,
    mimeType: head.contentType ?? input.mimeType,
    sizeBytes,
    tags: [],
    businessTags: [],
    status: "uploaded",
    createdAt: nowIso()
  });

  return jsonOk({ asset }, 201);
}
