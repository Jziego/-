import { jsonOk } from "@/lib/api-response";
import { applyRateLimit } from "@/lib/rate-limit";
import { getOwnerId } from "@/lib/auth-helpers";
import { getJobRepository } from "@/lib/repositories";

export async function GET(request: Request) {
  const ownerId = await getOwnerId();
  const limited = await applyRateLimit(request, ownerId);
  if (limited) return limited;
  // Cap history so the dashboard's "生成进度" panel doesn't pile up with old
  // terminal jobs. Newest-first (active jobs are always recent, so they stay).
  const jobs = await getJobRepository().listByOwner(ownerId, 30);
  return jsonOk({ jobs });
}
