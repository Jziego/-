import { createId, nowIso } from "@/lib/ids";
import type { AvatarProfile, AvatarProviderName } from "@/lib/types";

export interface AvatarProvider {
  name: AvatarProviderName;
  createAvatar(input: { trainingVideoAssetId: string; ownerId: string }): Promise<{
    providerAvatarId: string;
    providerVoiceId?: string;
  }>;
  generateTalkingHead(input: {
    providerAvatarId: string;
    providerVoiceId?: string;
    scriptText: string;
  }): Promise<{
    videoAssetId: string;
    durationSeconds: number;
  }>;
}

export async function createAvatarProfile(input: {
  ownerId: string;
  storeId: string;
  provider: AvatarProvider;
  trainingVideoAssetId: string;
  consentAccepted: boolean;
}): Promise<AvatarProfile> {
  if (!input.consentAccepted) {
    throw new Error("创建数字人前必须确认肖像和声音授权");
  }

  const providerAvatar = await input.provider.createAvatar({
    trainingVideoAssetId: input.trainingVideoAssetId,
    ownerId: input.ownerId
  });
  const now = nowIso();

  return {
    id: createId("avatar"),
    ownerId: input.ownerId,
    storeId: input.storeId,
    provider: input.provider.name,
    providerAvatarId: providerAvatar.providerAvatarId,
    providerVoiceId: providerAvatar.providerVoiceId,
    consentAcceptedAt: now,
    trainingStatus: "processing",
    fallbackMode: "tts_voiceover",
    createdAt: now,
    updatedAt: now
  };
}

export async function requestAvatarTalkingHead(input: {
  provider: AvatarProvider;
  avatarProfileId: string;
  providerAvatarId: string;
  providerVoiceId?: string;
  scriptText: string;
  allowFallback: boolean;
}): Promise<
  | {
      mode: "talking_head";
      avatarProfileId: string;
      videoAssetId: string;
      durationSeconds: number;
    }
  | {
      mode: "tts_voiceover";
      avatarProfileId: string;
      audioAssetId: string;
      reason: string;
    }
> {
  try {
    const result = await input.provider.generateTalkingHead({
      providerAvatarId: input.providerAvatarId,
      providerVoiceId: input.providerVoiceId,
      scriptText: input.scriptText
    });

    return {
      mode: "talking_head",
      avatarProfileId: input.avatarProfileId,
      videoAssetId: result.videoAssetId,
      durationSeconds: result.durationSeconds
    };
  } catch (error) {
    if (!input.allowFallback) {
      throw error;
    }

    return {
      mode: "tts_voiceover",
      avatarProfileId: input.avatarProfileId,
      audioAssetId: createId("tts"),
      reason: error instanceof Error ? error.message : "avatar_generation_failed"
    };
  }
}

export { createMockProvider } from "@/lib/services/providers/mock";
export { createProviderFromEnv } from "@/lib/services/providers/index";
