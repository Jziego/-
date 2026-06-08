import { jsonError, jsonOk } from "@/lib/api-response";
import { getJobRepository } from "@/lib/repositories";
import { demoOwnerId } from "@/lib/runtime-store";

export async function GET() {
  try {
    const jobs = await getJobRepository().listByOwner(demoOwnerId);
    return jsonOk({ jobs });
  } catch (error) {
    console.error("Failed to list jobs:", error);
    return jsonError(error instanceof Error ? error.message : "Failed to list jobs", 500);
  }
}
