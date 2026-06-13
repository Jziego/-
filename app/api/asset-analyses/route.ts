import { jsonOk, jsonRateLimited } from "@/lib/api-response";
import { rateLimitApi } from "@/lib/rate-limit";
import { getAssetAnalysisRepository } from "@/lib/repositories";
import { getOwnerId } from "@/lib/auth-helpers";

export async function GET() {
  const ownerId = await getOwnerId();
  const rl = await rateLimitApi(ownerId, "GET");
  if (!rl.allowed) return jsonRateLimited(rl);

  const analyses = await getAssetAnalysisRepository().listByOwner(ownerId);
  return jsonOk({ analyses });
}
