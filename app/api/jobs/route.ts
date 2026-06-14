import { jsonOk } from "@/lib/api-response";
import { applyRateLimit } from "@/lib/rate-limit";
import { getOwnerId } from "@/lib/auth-helpers";
import { getJobRepository } from "@/lib/repositories";

export async function GET(request: Request) {
  const ownerId = await getOwnerId();
  const limited = await applyRateLimit(request, ownerId);
  if (limited) return limited;
  const jobs = await getJobRepository().listByOwner(ownerId);
  return jsonOk({ jobs });
}
