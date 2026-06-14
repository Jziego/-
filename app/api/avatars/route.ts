import { jsonError, jsonOk } from "@/lib/api-response";
import { applyRateLimit } from "@/lib/rate-limit";
import { getAvatarRepository } from "@/lib/repositories";
import { getOwnerId } from "@/lib/auth-helpers";
import { createAvatarProfile, createMockAvatarProvider } from "@/lib/services/avatar-provider";

export async function GET(request: Request) {
  const ownerId = await getOwnerId();
  const limited = await applyRateLimit(request, ownerId);
  if (limited) return limited;
  const avatars = await getAvatarRepository().listByOwner(ownerId);
  return jsonOk({ avatars });
}

export async function POST(request: Request) {
  let body: {
    ownerId?: string;
    storeId?: string;
    trainingVideoAssetId?: string;
    consentAccepted?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body");
  }

  try {
    const ownerId = await getOwnerId();
    const limited = await applyRateLimit(request, ownerId);
    if (limited) return limited;
    const avatar = await createAvatarProfile({
      ownerId,
      storeId: body.storeId ?? "",
      trainingVideoAssetId: body.trainingVideoAssetId ?? "",
      consentAccepted: Boolean(body.consentAccepted),
      provider: createMockAvatarProvider()
    });

    const saved = await getAvatarRepository().create(avatar);
    return jsonOk({ avatar: saved }, 201);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Avatar creation failed");
  }
}
