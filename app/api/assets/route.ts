import { jsonError, jsonOk } from "@/lib/api-response";
import { createId, nowIso } from "@/lib/ids";
import { getAssetRepository } from "@/lib/repositories";
import { demoOwnerId } from "@/lib/runtime-store";
import { assetSchema } from "@/lib/schemas";

export async function GET() {
  const assets = await getAssetRepository().listByOwner(demoOwnerId);
  return jsonOk({ assets });
}

export async function POST(request: Request) {
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
}
