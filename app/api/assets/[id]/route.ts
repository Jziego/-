import { jsonError, jsonOk } from "@/lib/api-response";
import { applyRateLimit } from "@/lib/rate-limit";
import { getOwnerId } from "@/lib/auth-helpers";
import { getAssetRepository } from "@/lib/repositories";
import { deleteObject } from "@/lib/storage";

/**
 * Hard-delete an asset (DB row + best-effort S3 object). IDOR: a missing or
 * foreign asset both resolve to 404 so existence is not leaked. Storage
 * cleanup is best-effort — a missing object must not block the DB delete.
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await context.params;
  const ownerId = await getOwnerId();

  const limited = await applyRateLimit(request, ownerId);
  if (limited) return limited;

  const asset = await getAssetRepository().findById(id);
  if (!asset || asset.ownerId !== ownerId) {
    return jsonError("Asset not found", 404);
  }

  await getAssetRepository().deleteById(id);
  await deleteObject(asset.storageKey);

  return jsonOk({ id });
}
