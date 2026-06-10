import { jsonError, jsonOk } from "@/lib/api-response";
import { getJobRepository } from "@/lib/repositories";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const job = await getJobRepository().findById(id);

  if (!job) {
    return jsonError("Job not found", 404);
  }

  return jsonOk({ job });
}
