import { jsonOk } from "@/lib/api-response";
import { getJobRepository } from "@/lib/repositories";
import { demoOwnerId } from "@/lib/runtime-store";

export async function GET() {
  const jobs = await getJobRepository().listByOwner(demoOwnerId);
  return jsonOk({ jobs });
}
