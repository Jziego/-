import { jsonOk } from "@/lib/api-response";
import { getAssetAnalysisRepository } from "@/lib/repositories";
import { demoOwnerId } from "@/lib/runtime-store";

export async function GET() {
  const analyses = await getAssetAnalysisRepository().listByOwner(demoOwnerId);
  return jsonOk({ analyses });
}
