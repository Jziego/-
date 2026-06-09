import { handleRouteError } from "@/lib/api-errors";
import { jsonError, jsonOk } from "@/lib/api-response";
import { createId, nowIso } from "@/lib/ids";
import { getStoreRepository } from "@/lib/repositories";
import { demoOwnerId } from "@/lib/runtime-store";
import { storeProfileSchema } from "@/lib/schemas";

export async function GET() {
  try {
    const stores = await getStoreRepository().listByOwner(demoOwnerId);
    return jsonOk({ stores });
  } catch (error) {
    return handleRouteError("Failed to list store profiles", error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const now = nowIso();
    const parsed = storeProfileSchema.safeParse({
      ...body,
      id: body.id ?? createId("store"),
      ownerId: body.ownerId ?? demoOwnerId,
      createdAt: body.createdAt ?? now,
      updatedAt: now
    });

    if (!parsed.success) {
      return jsonError(parsed.error.issues[0]?.message ?? "Invalid store profile");
    }

    const store = await getStoreRepository().upsert(parsed.data);
    return jsonOk({ store }, 201);
  } catch (error) {
    return handleRouteError("Failed to create store profile", error);
  }
}
