import { createId } from "@/lib/ids";
import type { AvatarProvider, DigitalTwinStatus, WordTimestamp } from "@/lib/services/avatar-provider";
import { SPEECH_CHARS_PER_SECOND } from "@/lib/speech-rate";

interface MockProviderOptions {
  avatarId?: string;
  voiceId?: string;
  failTalkingHead?: boolean;
  failDigitalTwin?: boolean;
  failTts?: boolean;
  /** 每次 getDigitalTwinStatus 调用弹出序列头；耗尽后保持最后一个。 */
  twinStatusSequence?: DigitalTwinStatus[];
}

export function createMockProvider(options: MockProviderOptions = {}): AvatarProvider {
  const statusQueue = [...(options.twinStatusSequence ?? [])];
  return {
    name: "mock-avatar",
    async createAvatar() {
      return {
        providerAvatarId: options.avatarId ?? createId("provider_avatar"),
        providerVoiceId: options.voiceId ?? createId("provider_voice"),
      };
    },
    async generateTalkingHead(
      _input: { providerAvatarId: string; providerVoiceId?: string; scriptText: string },
      _onProgress?: (attempt: number, maxAttempts: number) => void,
    ) {
      if (options.failTalkingHead) {
        throw new Error("Mock provider talking-head generation failed");
      }
      return { videoAssetId: createId("avatar_video"), durationSeconds: 15 };
    },
    async createDigitalTwin(input) {
      if (options.failDigitalTwin) {
        throw new Error("Mock provider digital twin creation failed");
      }
      const groupId = createId("avatar_group");
      return { groupId, consentUrl: `https://consent.example.com/${groupId}?name=${encodeURIComponent(input.name)}` };
    },
    async refreshConsent(input) {
      return { consentUrl: `https://consent.example.com/${input.groupId}` };
    },
    async getDigitalTwinStatus() {
      if (statusQueue.length > 1) return statusQueue.shift() as DigitalTwinStatus;
      if (statusQueue.length === 1) return statusQueue[0] as DigitalTwinStatus;
      return {
        consentStatus: "approved",
        trainingStatus: "ready",
        providerAvatarId: options.avatarId ?? createId("provider_avatar"),
        providerVoiceId: options.voiceId ?? createId("provider_voice"),
      };
    },
    async synthesizeSpeech(input) {
      if (options.failTts) {
        throw new Error("Mock provider TTS failed");
      }
      const chars = Array.from(input.text);
      const durationSeconds = Math.max(chars.length / SPEECH_CHARS_PER_SECOND, 0.5);
      const perChar = durationSeconds / Math.max(chars.length, 1);
      const words: WordTimestamp[] = chars.map((word, i) => ({
        word,
        startSec: i * perChar,
        endSec: (i + 1) * perChar,
      }));
      return { audioStorageKey: createId("voice_audio"), durationSeconds, words };
    },
  };
}
