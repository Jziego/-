import { jsonError, jsonOk } from "@/lib/api-response";
import { getAvatarRepository } from "@/lib/repositories";
import { createProviderFromEnv, requestAvatarTalkingHead } from "@/lib/services/avatar-provider";

export async function POST(request: Request) {
  const body = await request.json();
  const avatar = await getAvatarRepository().findById(body.avatarProfileId);

  if (!avatar?.providerAvatarId) {
    return jsonError("Avatar profile not ready", 404);
  }

  const result = await requestAvatarTalkingHead({
    provider: createProviderFromEnv(),
    avatarProfileId: avatar.id,
    providerAvatarId: avatar.providerAvatarId,
    providerVoiceId: avatar.providerVoiceId,
    scriptText: body.scriptText,
    allowFallback: true
  });

  return jsonOk({ result }, 201);
}
