import { jsonError, jsonOk } from "@/lib/api-response";
import { applyRateLimit } from "@/lib/rate-limit";
import { getOwnerId } from "@/lib/auth-helpers";
import { getAssetAnalysisRepository, getAssetRepository, getStoreRepository } from "@/lib/repositories";
import { classifyAsset } from "@/lib/services/assets";
import { hasAI } from "@/lib/services/ai-client";

/**
 * Force a fresh AI classification of an asset (reanalyze). Used to recover from
 * a `failed` analysis or upgrade rule-fallback tags to AI tags. AI failures are
 * NOT fatal: the analysis is persisted with status `failed` + rule fallback tags.
 * IDOR: a missing or foreign asset resolves to 404.
 */
export async function POST(
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

  if (!hasAI()) {
    return jsonError("未配置 AI，无法重新分析", 503);
  }

  const store = await getStoreRepository().findById(asset.storeId);
  if (!store) {
    return jsonError("Store not found", 404);
  }

  const result = await classifyAsset({ asset, store, analysisUnavailable: false });
  const patch = {
    visualTags: result.visualTags,
    businessTags: result.businessTags,
    keywords: result.keywords,
    confidence: result.confidence,
    recommendedUses: result.recommendedUses,
    transcript: result.transcript,
    analysisStatus: result.analysisStatus
  };
  const repo = getAssetAnalysisRepository();
  const existing = await repo.findByAssetId(asset.id);
  const saved = existing ? await repo.update(asset.id, patch) : await repo.create(result);
  return jsonOk({ analysis: saved });
}
