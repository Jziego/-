import { jsonError, jsonOk } from "@/lib/api-response";
import { applyRateLimit } from "@/lib/rate-limit";
import { createId, nowIso } from "@/lib/ids";
import { getAssetRepository } from "@/lib/repositories";
import { getOwnerId } from "@/lib/auth-helpers";
import { assetSchema } from "@/lib/schemas";

export async function GET(request: Request) {
  const ownerId = await getOwnerId();
  const limited = await applyRateLimit(request, ownerId);
  if (limited) return limited;
  const assets = await getAssetRepository().listByOwner(ownerId);
  return jsonOk({ assets });
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return jsonError("Request body must be valid JSON", 400);
  }
  const ownerId = await getOwnerId();
  const limited = await applyRateLimit(request, ownerId);
  if (limited) return limited;
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
