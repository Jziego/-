import { handleRouteError } from "@/lib/api-errors";
import { jsonError, jsonOk } from "@/lib/api-response";
import { getAssetAnalysisRepository, getAssetRepository, getStoreRepository } from "@/lib/repositories";
import { classifyAsset } from "@/lib/services/assets";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const asset = await getAssetRepository().findById(body.assetId);
    const store = await getStoreRepository().findById(body.storeId);

    if (!asset || !store) {
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
  } catch (error) {
    return handleRouteError("Failed to analyze asset", error);
  }
}
