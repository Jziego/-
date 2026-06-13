import { jsonOk } from "@/lib/api-response";
import { getOwnerId } from "@/lib/auth-helpers";
import { getJobRepository } from "@/lib/repositories";

export async function GET() {
  const jobs = await getJobRepository().listByOwner(await getOwnerId());
  return jsonOk({ jobs });
}
