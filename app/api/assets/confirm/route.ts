import { jsonError, jsonOk } from "@/lib/api-response";
import { applyRateLimit } from "@/lib/rate-limit";
import { hasObjectStorage } from "@/lib/env";
import { nowIso } from "@/lib/ids";
import { getAssetRepository, getStoreRepository } from "@/lib/repositories";
import { getOwnerId } from "@/lib/auth-helpers";
import { confirmAssetUploadSchema } from "@/lib/schemas";
import { MAX_UPLOAD_BYTES, deleteObject, getFirstBytes, headObject } from "@/lib/storage";
import { MAGIC_BYTES_READ_LENGTH, detectMimeFromMagicBytes, isMimeConsistentWithMagic } from "@/lib/file-magic";

export async function POST(request: Request) {
  if (!hasObjectStorage()) {
    return jsonError("Object storage is not configured", 503);
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return jsonError("Request body must be valid JSON", 400);
  }
  const parsed = confirmAssetUploadSchema.safeParse(body);

  if (!parsed.success) {
    return jsonError(parsed.error.issues[0]?.message ?? "Invalid confirm payload");
  }

  const input = parsed.data;
  const ownerId = await getOwnerId();
  const limited = await applyRateLimit(request, ownerId);
  if (limited) return limited;
  const expectedPrefix = `stores/${input.storeId}/assets/${input.assetId}-`;

  if (!input.storageKey.startsWith(expectedPrefix)) {
    return jsonError("storageKey does not match asset and store", 400);
  }

  const store = await getStoreRepository().findById(input.storeId);
  if (!store) {
    return jsonError("Store not found", 404);
  }

  // IDOR guard: store must belong to the authenticated user
  if (store.ownerId !== ownerId) {
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

  // Server-side MIME verification: never trust the client-supplied contentType
  // (CLAUDE.md §2). Download the first N bytes and check magic bytes match the
  // declared type. Mismatch → reject and delete the orphan object so storage is
  // not polluted by attacker-uploaded HTML/JS/EXE disguised as images.
  const firstBytes = await getFirstBytes(input.storageKey, MAGIC_BYTES_READ_LENGTH);
  const detectedMime = detectMimeFromMagicBytes(firstBytes);
  const claimedMime = head.contentType ?? input.mimeType;
  if (!isMimeConsistentWithMagic(claimedMime, detectedMime)) {
    await deleteObject(input.storageKey);
    return jsonError("Uploaded content does not match the declared MIME type", 400);
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
