import { jsonError, jsonOk } from "@/lib/api-response";
import { hasObjectStorage } from "@/lib/env";
import { createUploadIntent } from "@/lib/services/assets";

export async function POST(request: Request) {
  if (!hasObjectStorage()) {
    return jsonError("Object storage is not configured", 503);
  }

  const body = await request.json();

  if (!body.storeId || !body.filename || !body.contentType || !body.sizeBytes) {
    return jsonError("Missing upload intent fields");
  }

  try {
    const intent = await createUploadIntent({
      ownerId: body.ownerId ?? "demo_user",
      storeId: body.storeId,
      filename: body.filename,
      contentType: body.contentType,
      sizeBytes: Number(body.sizeBytes)
    });

    return jsonOk({ intent }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create upload intent";
    return jsonError(message, 400);
  }
}
