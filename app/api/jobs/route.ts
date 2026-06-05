import { jsonOk } from "@/lib/api-response";
import { getRuntimeState } from "@/lib/runtime-store";

export async function GET() {
  return jsonOk({ jobs: getRuntimeState().jobs });
}
