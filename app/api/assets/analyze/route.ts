import { jsonError, jsonOk } from "@/lib/api-response";
import { applyRateLimit } from "@/lib/rate-limit";
import { getOwnerId } from "@/lib/auth-helpers";
import { getAssetAnalysisRepository, getAssetRepository, getStoreRepository } from "@/lib/repositories";
import { classifyAsset } from "@/lib/services/assets";

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return jsonError("Request body must be valid JSON", 400);
  }
  const asset = await getAssetRepository().findById(body.assetId as string);
  const store = await getStoreRepository().findById(body.storeId as string);

  if (!asset || !store) {
    return jsonError("Asset or store not found", 404);
  }

  const ownerId = await getOwnerId();
  const limited = await applyRateLimit(request, ownerId);
  if (limited) return limited;
  // IDOR guard: asset and store must belong to the requesting user
  if (asset.ownerId !== ownerId || store.ownerId !== ownerId) {
    return jsonError("Asset or store not found", 404);
  }

  const analysis = await classifyAsset({
    asset,
    store,
    visualLabels: body.visualLabels as string[] | undefined,
    transcript: body.transcript as string | undefined,
    manualTags: body.manualTags as string[] | undefined,
    analysisUnavailable: body.analysisUnavailable as boolean | undefined
  });

  const saved = await getAssetAnalysisRepository().create(analysis);
  return jsonOk({ analysis: saved }, 201);
}
