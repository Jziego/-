import { jsonOk } from "@/lib/api-response";
import { applyRateLimit } from "@/lib/rate-limit";
import { getAssetAnalysisRepository } from "@/lib/repositories";
import { getOwnerId } from "@/lib/auth-helpers";

export async function GET(request: Request) {
  const ownerId = await getOwnerId();
  const limited = await applyRateLimit(request, ownerId);
  if (limited) return limited;

  const analyses = await getAssetAnalysisRepository().listByOwner(ownerId);
  return jsonOk({ analyses });
}
