import { jsonError, jsonOk } from "@/lib/api-response";
import { getRuntimeState } from "@/lib/runtime-store";
import { createScriptDraft, createTemplateScriptDraft } from "@/lib/services/script-engine";
import type { MarketingPurpose, Platform } from "@/lib/types";

export async function GET() {
  return jsonOk({ scripts: getRuntimeState().scripts });
}

export async function POST(request: Request) {
  const body = await request.json();
  const state = getRuntimeState();
  const store = state.stores.find((item) => item.id === body.storeId);

  if (!store) {
    return jsonError("Store profile not found", 404);
  }

  const assetAnalyses = state.analyses.filter((analysis) => body.assetAnalysisIds?.includes(analysis.id));
  const purpose = (body.purpose ?? "store_traffic") as MarketingPurpose;

  const script = body.forceTemplate
    ? createTemplateScriptDraft({ store, assetAnalyses, purpose, reason: "manual_template_mode" })
    : await createScriptDraft({
        store,
        assetAnalyses,
        purpose,
        platform: (body.platform ?? "douyin") as Platform
      });

  state.scripts.push(script);
  return jsonOk({ script }, 201);
}
