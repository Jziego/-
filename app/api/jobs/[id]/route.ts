import { jsonError, jsonOk } from "@/lib/api-response";
import { getJobRepository } from "@/lib/repositories";
import { getOwnerId } from "@/lib/auth-helpers";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ownerId = await getOwnerId();
  const job = await getJobRepository().findById(id);

  // IDOR guard: job must belong to the requesting owner. Missing and foreign
  // both resolve to 404 so existence is not leaked.
  if (!job || job.ownerId !== ownerId) {
    return jsonError("Job not found", 404);
  }

  return jsonOk({ job });
}
