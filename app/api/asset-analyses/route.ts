import { jsonError, jsonOk } from "@/lib/api-response";
import { getAssetAnalysisRepository } from "@/lib/repositories";
import { demoOwnerId } from "@/lib/runtime-store";

export async function GET() {
  try {
    const analyses = await getAssetAnalysisRepository().listByOwner(demoOwnerId);
    return jsonOk({ analyses });
  } catch (error) {
    console.error("Failed to list asset analyses:", error);
    return jsonError(error instanceof Error ? error.message : "Failed to list asset analyses", 500);
  }
}
