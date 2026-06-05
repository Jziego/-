import { jsonError, jsonOk } from "@/lib/api-response";
import { createId, nowIso } from "@/lib/ids";
import { demoOwnerId, getRuntimeState } from "@/lib/runtime-store";
import { storeProfileSchema } from "@/lib/schemas";

export async function GET() {
  return jsonOk({ stores: getRuntimeState().stores });
}

export async function POST(request: Request) {
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

  const state = getRuntimeState();
  const existingIndex = state.stores.findIndex((store) => store.id === parsed.data.id);

  if (existingIndex >= 0) {
    state.stores[existingIndex] = parsed.data;
  } else {
    state.stores.push(parsed.data);
  }

  return jsonOk({ store: parsed.data }, 201);
}
