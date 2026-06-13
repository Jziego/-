import { jsonOk, jsonRateLimited } from "@/lib/api-response";
import { rateLimitApi } from "@/lib/rate-limit";
import { getOwnerId } from "@/lib/auth-helpers";
import { getJobRepository } from "@/lib/repositories";

export async function GET() {
  const ownerId = await getOwnerId();
  const rl = await rateLimitApi(ownerId, "GET");
  if (!rl.allowed) return jsonRateLimited(rl);
  const jobs = await getJobRepository().listByOwner(ownerId);
  return jsonOk({ jobs });
}
