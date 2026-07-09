import { jsonError, jsonOk } from "@/lib/api-response";
import { applyRateLimit } from "@/lib/rate-limit";
import { getRenderRepository } from "@/lib/repositories";
import { getOwnerId } from "@/lib/auth-helpers";
import { createPresignedGetUrl } from "@/lib/storage";

/**
 * Returns a short-lived presigned GET URL for a single render output, so the
 * dashboard can play/download a completed video without exposing the object
 * storage bucket publicly. The output must belong to the requesting owner
 * (IDOR guard); foreign or missing outputs both resolve to a 404 so existence
 * is not leaked.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await context.params;
  const ownerId = await getOwnerId();

  const limited = await applyRateLimit(request, ownerId);
  if (limited) return limited;

  const output = await getRenderRepository().findOutputById(id);

  if (!output || output.ownerId !== ownerId) {
    return jsonError("Output not found", 404);
  }

  try {
    const url = await createPresignedGetUrl(output.storageKey);
    return jsonOk({ url });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to generate URL";
    return jsonError(message, 503);
  }
}
