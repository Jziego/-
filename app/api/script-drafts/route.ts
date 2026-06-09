import { handleRouteError } from "@/lib/api-errors";
import { jsonError, jsonOk } from "@/lib/api-response";
import { getAssetAnalysisRepository, getScriptRepository, getStoreRepository } from "@/lib/repositories";
import { demoOwnerId } from "@/lib/runtime-store";
import { createScriptDraft, createTemplateScriptDraft } from "@/lib/services/script-engine";
import type { MarketingPurpose, Platform } from "@/lib/types";

export async function GET() {
  try {
    const scripts = await getScriptRepository().listByOwner(demoOwnerId);
    return jsonOk({ scripts });
  } catch (error) {
    return handleRouteError("Failed to list script drafts", error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const store = await getStoreRepository().findById(body.storeId);

    if (!store) {
      return jsonError("Store profile not found", 404);
    }

    const assetAnalyses = body.assetAnalysisIds?.length
      ? await getAssetAnalysisRepository().listByIds(body.assetAnalysisIds)
      : [];
    const purpose = (body.purpose ?? "store_traffic") as MarketingPurpose;

    const script = body.forceTemplate
      ? createTemplateScriptDraft({ store, assetAnalyses, purpose, reason: "manual_template_mode" })
      : await createScriptDraft({
          store,
          assetAnalyses,
          purpose,
          platform: (body.platform ?? "douyin") as Platform
        });

    const saved = await getScriptRepository().create(script);
    return jsonOk({ script: saved }, 201);
  } catch (error) {
    return handleRouteError("Failed to create script draft", error);
  }
}
