import { handleRouteError } from "@/lib/api-errors";
import { jsonOk } from "@/lib/api-response";
import { getJobRepository } from "@/lib/repositories";
import { demoOwnerId } from "@/lib/runtime-store";

export async function GET() {
  try {
    const jobs = await getJobRepository().listByOwner(demoOwnerId);
    return jsonOk({ jobs });
  } catch (error) {
    return handleRouteError("Failed to list jobs", error);
  }
}
