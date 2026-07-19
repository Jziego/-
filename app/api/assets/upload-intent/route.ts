import { jsonError, jsonOk } from "@/lib/api-response";
import { applyRateLimit } from "@/lib/rate-limit";
import { getOwnerId } from "@/lib/auth-helpers";
import { hasObjectStorage } from "@/lib/env";
import { createUploadIntent, UploadValidationError } from "@/lib/services/assets";

export async function POST(request: Request) {
  if (!hasObjectStorage()) {
    return jsonError("Object storage is not configured", 503);
  }

  let body: { storeId?: unknown; filename?: unknown; contentType?: unknown; sizeBytes?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonError("Request body must be valid JSON", 400);
  }

  if (!body.storeId || !body.filename || !body.contentType || !body.sizeBytes) {
    return jsonError("Missing upload intent fields");
  }

  try {
    const ownerId = await getOwnerId();
    const limited = await applyRateLimit(request, ownerId);
    if (limited) return limited;
    const intent = await createUploadIntent({
      ownerId,
      storeId: String(body.storeId),
      filename: String(body.filename),
      contentType: String(body.contentType),
      sizeBytes: Number(body.sizeBytes),
    });
    return jsonOk({ intent }, 201);
  } catch (error) {
    // Validation errors carry a user-facing message — safe to forward.
    if (error instanceof UploadValidationError) {
      return jsonError(error.message, 400);
    }
    // Infrastructure errors (S3 presign) may contain endpoint/host/region —
    // log server-side, return generic message (CLAUDE.md §7/§8, matches the
    // outputs-url / preview-url pattern from 1c83e3c).
    console.error("[upload-intent] presign failed:", error);
    return jsonError("Failed to create upload intent", 503);
  }
}
