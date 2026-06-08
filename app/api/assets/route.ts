import { jsonError, jsonOk } from "@/lib/api-response";
import { createId, nowIso } from "@/lib/ids";
import { getAssetRepository } from "@/lib/repositories";
import { demoOwnerId } from "@/lib/runtime-store";
import { assetSchema } from "@/lib/schemas";

export async function GET() {
  try {
    const assets = await getAssetRepository().listByOwner(demoOwnerId);
    return jsonOk({ assets });
  } catch (error) {
    console.error("Failed to list assets:", error);
    return jsonError(error instanceof Error ? error.message : "Failed to list assets", 500);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = assetSchema.safeParse({
      ...body,
      id: body.id ?? createId("asset"),
      ownerId: body.ownerId ?? demoOwnerId,
      tags: body.tags ?? [],
      businessTags: body.businessTags ?? [],
      status: body.status ?? "uploaded",
      createdAt: body.createdAt ?? nowIso()
    });

    if (!parsed.success) {
      return jsonError(parsed.error.issues[0]?.message ?? "Invalid asset");
    }

    const asset = await getAssetRepository().create(parsed.data);
    return jsonOk({ asset }, 201);
  } catch (error) {
    console.error("Failed to create asset:", error);
    return jsonError(error instanceof Error ? error.message : "Failed to create asset", 500);
  }
}
