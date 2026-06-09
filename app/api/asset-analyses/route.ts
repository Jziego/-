import { handleRouteError } from "@/lib/api-errors";
import { jsonOk } from "@/lib/api-response";
import { getAssetAnalysisRepository } from "@/lib/repositories";
import { demoOwnerId } from "@/lib/runtime-store";

export async function GET() {
  try {
    const analyses = await getAssetAnalysisRepository().listByOwner(demoOwnerId);
    return jsonOk({ analyses });
  } catch (error) {
    return handleRouteError("Failed to list asset analyses", error);
  }
}
