import { jsonError, jsonOk } from "@/lib/api-response";
import { applyRateLimit } from "@/lib/rate-limit";
import { getOwnerId } from "@/lib/auth-helpers";
import { getAssetRepository } from "@/lib/repositories";
import { createPresignedGetUrl } from "@/lib/storage";

/**
 * Short-lived presigned GET URL so the dashboard can render an asset
 * thumbnail (video first frame / image) without exposing the bucket
 * publicly. IDOR: missing or foreign assets both resolve to 404 so
 * existence is not leaked.
 */
export async function GET(
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

  try {
    const url = await createPresignedGetUrl(asset.storageKey, 300);
    return jsonOk({ url, mimeType: asset.mimeType, type: asset.type });
  } catch (error) {
    // Log the full error server-side; return a generic message to the client
    // so AWS SDK details (endpoint/host/region) are never leaked (CLAUDE.md §8).
    console.error("[preview-url] presign failed:", error);
    return jsonError("Failed to generate preview URL", 503);
  }
}
