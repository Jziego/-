import { jsonOk } from "@/lib/api-response";
import { applyRateLimit } from "@/lib/rate-limit";
import { getOwnerId } from "@/lib/auth-helpers";
import { getPointsBalance } from "@/lib/points";

export async function GET(request: Request) {
  const ownerId = await getOwnerId();
  const limited = await applyRateLimit(request, ownerId);
  if (limited) return limited;
  const balance = await getPointsBalance(ownerId);
  return jsonOk({ balance });
}
