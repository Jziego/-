import { jsonError, jsonOk, jsonRateLimited } from "@/lib/api-response";
import { rateLimitApi } from "@/lib/rate-limit";
import { createId, nowIso } from "@/lib/ids";
import { getAssetRepository } from "@/lib/repositories";
import { getOwnerId } from "@/lib/auth-helpers";
import { assetSchema } from "@/lib/schemas";

export async function GET() {
  const ownerId = await getOwnerId();
  const rl = await rateLimitApi(ownerId, "GET");
  if (!rl.allowed) return jsonRateLimited(rl);
  const assets = await getAssetRepository().listByOwner(ownerId);
  return jsonOk({ assets });
}

export async function POST(request: Request) {
  const body = await request.json();
  const ownerId = await getOwnerId();
  const rl = await rateLimitApi(ownerId, request.method);
  if (!rl.allowed) return jsonRateLimited(rl);
  const parsed = assetSchema.safeParse({
    ...body,
    id: body.id ?? createId("asset"),
    ownerId,
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
