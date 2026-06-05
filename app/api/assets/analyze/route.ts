import { jsonError, jsonOk } from "@/lib/api-response";
import { getRuntimeState } from "@/lib/runtime-store";
import { classifyAsset } from "@/lib/services/assets";

export async function POST(request: Request) {
  const body = await request.json();
  const state = getRuntimeState();
  const asset = state.assets.find((item) => item.id === body.assetId);
  const store = state.stores.find((item) => item.id === body.storeId);

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

  state.analyses.push(analysis);
  return jsonOk({ analysis }, 201);
}
