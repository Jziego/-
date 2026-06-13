import { jsonError, jsonOk, jsonRateLimited } from "@/lib/api-response";
import { rateLimitApi } from "@/lib/rate-limit";
import { getOwnerId } from "@/lib/auth-helpers";
import { getAssetAnalysisRepository, getAssetRepository, getStoreRepository } from "@/lib/repositories";
import { classifyAsset } from "@/lib/services/assets";

export async function POST(request: Request) {
  const body = await request.json();
  const asset = await getAssetRepository().findById(body.assetId);
  const store = await getStoreRepository().findById(body.storeId);

  if (!asset || !store) {
    return jsonError("Asset or store not found", 404);
  }

  const ownerId = await getOwnerId();
  const rl = await rateLimitApi(ownerId, request.method);
  if (!rl.allowed) return jsonRateLimited(rl);
  // IDOR guard: asset and store must belong to the requesting user
  if (asset.ownerId !== ownerId || store.ownerId !== ownerId) {
    return jsonError("Asset or store not found", 404);
  }

  const analysis = await classifyAsset({
    asset,
    store,
    visualLabels: body.visualLabels,
    transcript: body.transcript,
    manualTags: body.manualTags,
    analysisUnavailable: body.analysisUnavailable
  });

  const saved = await getAssetAnalysisRepository().create(analysis);
  return jsonOk({ analysis: saved }, 201);
}
