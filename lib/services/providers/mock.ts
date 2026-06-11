import { createId } from "@/lib/ids";
import type { AvatarProvider } from "@/lib/services/avatar-provider";

interface MockProviderOptions {
  avatarId?: string;
  voiceId?: string;
  failTalkingHead?: boolean;
}

export function createMockProvider(options: MockProviderOptions = {}): AvatarProvider {
  return {
    name: "mock-avatar",
    async createAvatar() {
      return {
        providerAvatarId: options.avatarId ?? createId("provider_avatar"),
        providerVoiceId: options.voiceId ?? createId("provider_voice"),
      };
    },
    async generateTalkingHead() {
      if (options.failTalkingHead) {
        throw new Error("Mock provider talking-head generation failed");
      }
      return {
        videoAssetId: createId("avatar_video"),
        durationSeconds: 15,
      };
    },
  };
}
