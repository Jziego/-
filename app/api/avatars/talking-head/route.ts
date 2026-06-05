import { jsonError, jsonOk } from "@/lib/api-response";
import { getRuntimeState } from "@/lib/runtime-store";
import { createMockAvatarProvider, requestAvatarTalkingHead } from "@/lib/services/avatar-provider";

export async function POST(request: Request) {
  const body = await request.json();
  const avatar = getRuntimeState().avatars.find((item) => item.id === body.avatarProfileId);

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
}
