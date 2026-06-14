import { jsonError, jsonOk } from "@/lib/api-response";
import { applyRateLimit } from "@/lib/rate-limit";
import { createId, nowIso } from "@/lib/ids";

import { getStoreRepository } from "@/lib/repositories";

import { getOwnerId } from "@/lib/auth-helpers";

import { storeProfileSchema } from "@/lib/schemas";



export async function GET(request: Request) {
  try {
    const ownerId = await getOwnerId();
    const limited = await applyRateLimit(request, ownerId);
    if (limited) return limited;
    const stores = await getStoreRepository().listByOwner(ownerId);
    return jsonOk({ stores });
  } catch {
    return jsonError("Failed to list store profiles", 500);
  }
}



export async function POST(request: Request) {

  const body = await request.json();

  const ownerId = await getOwnerId();
  const limited = await applyRateLimit(request, ownerId);
  if (limited) return limited;

  const now = nowIso();

  const parsed = storeProfileSchema.safeParse({

    ...body,

    id: body.id ?? createId("store"),

    ownerId,

    createdAt: body.createdAt ?? now,

    updatedAt: now

  });



  if (!parsed.success) {

    return jsonError(parsed.error.issues[0]?.message ?? "Invalid store profile");

  }



  const store = await getStoreRepository().upsert(parsed.data);

  return jsonOk({ store }, 201);

}

