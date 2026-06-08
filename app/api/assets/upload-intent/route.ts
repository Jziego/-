import { jsonError, jsonOk } from "@/lib/api-response";
import { createUploadIntent } from "@/lib/services/assets";

export async function POST(request: Request) {
  try {
    const body = await request.json();

    if (!body.storeId || !body.filename || !body.contentType || !body.sizeBytes) {
      return jsonError("Missing upload intent fields");
    }

    const intent = createUploadIntent({
      ownerId: body.ownerId ?? "demo_user",
      storeId: body.storeId,
      filename: body.filename,
      contentType: body.contentType,
      sizeBytes: Number(body.sizeBytes)
    });

    return jsonOk({ intent }, 201);
  } catch (error) {
    console.error("Failed to create upload intent:", error);
    return jsonError(error instanceof Error ? error.message : "Failed to create upload intent", 500);
  }
}
