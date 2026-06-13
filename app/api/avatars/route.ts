import { jsonError, jsonOk, jsonRateLimited } from "@/lib/api-response";
import { rateLimitApi } from "@/lib/rate-limit";
import { getAvatarRepository } from "@/lib/repositories";
import { getOwnerId } from "@/lib/auth-helpers";
import { createAvatarProfile, createMockAvatarProvider } from "@/lib/services/avatar-provider";

export async function GET() {
  const ownerId = await getOwnerId();
  const rl = await rateLimitApi(ownerId, "GET");
  if (!rl.allowed) return jsonRateLimited(rl);
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
    const rl = await rateLimitApi(ownerId, request.method);
    if (!rl.allowed) return jsonRateLimited(rl);
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
