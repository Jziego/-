import { handleRouteError } from "@/lib/api-errors";
import { jsonError, jsonOk } from "@/lib/api-response";
import { getAvatarRepository } from "@/lib/repositories";
import { createMockAvatarProvider, requestAvatarTalkingHead } from "@/lib/services/avatar-provider";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const avatar = await getAvatarRepository().findById(body.avatarProfileId);

    if (!avatar?.providerAvatarId) {
      return jsonError("Avatar profile not ready", 404);
    }

    const result = await requestAvatarTalkingHead({
      provider: createMockAvatarProvider({ failTalkingHead: body.forceFallback }),
      avatarProfileId: avatar.id,
      providerAvatarId: avatar.providerAvatarId,
      providerVoiceId: avatar.providerVoiceId,
      scriptText: body.scriptText,
      allowFallback: true
    });

    return jsonOk({ result }, 201);
  } catch (error) {
    return handleRouteError("Failed to request talking head", error);
  }
}
