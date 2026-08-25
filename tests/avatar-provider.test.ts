import { describe, expect, it } from "vitest";
import {
  createAvatarProfile,
  requestAvatarTalkingHead
} from "@/lib/services/avatar-provider";
import { createMockProvider } from "@/lib/services/providers/mock";

describe("avatar provider abstraction", () => {
  it("requires explicit likeness and voice consent before creating an avatar", async () => {
    const provider = createMockProvider();

    await expect(
      createAvatarProfile({
        ownerId: "user_1",
        storeId: "store_1",
        provider,
        trainingVideoAssetId: "asset_training",
        consentAccepted: false
      })
    ).rejects.toThrow("肖像和声音授权");
  });

  it("stores third-party identifiers without coupling render projects to a vendor", async () => {
    const provider = createMockProvider({
      avatarId: "heygen-avatar-1",
      voiceId: "heygen-voice-1"
    });

    const avatar = await createAvatarProfile({
      ownerId: "user_1",
      storeId: "store_1",
      provider,
      trainingVideoAssetId: "asset_training",
      consentAccepted: true
    });

    expect(avatar.provider).toBe("mock-avatar");
    expect(avatar.providerAvatarId).toBe("heygen-avatar-1");
    expect(avatar.providerVoiceId).toBe("heygen-voice-1");
    expect(avatar.trainingStatus).toBe("processing");
  });

  it("returns talking_head mode with the provider storage key on success", async () => {
    const provider = createMockProvider();

    const result = await requestAvatarTalkingHead({
      provider,
      avatarProfileId: "avatar_1",
      providerAvatarId: "external_avatar",
      providerVoiceId: "external_voice",
      scriptText: "今天来店里尝尝刚出炉的招牌蛋糕"
    });

    expect(result.mode).toBe("talking_head");
    expect(result.videoAssetId).toMatch(/^avatar_video/);
    expect(result.durationSeconds).toBe(15);
  });

  it("throws when talking-head generation fails (no fake fallback — b3)", async () => {
    const provider = createMockProvider({ failTalkingHead: true });

    await expect(
      requestAvatarTalkingHead({
        provider,
        avatarProfileId: "avatar_1",
        providerAvatarId: "external_avatar",
        scriptText: "今天来店里尝尝刚出炉的招牌蛋糕"
      })
    ).rejects.toThrow();
  });
});

describe("digital twin provider contract (mock)", () => {
  it("createDigitalTwin returns a group id and a consent url", async () => {
    const provider = createMockProvider();
    const result = await provider.createDigitalTwin({
      name: "店主",
      footageUrl: "https://cdn.example.com/footage.mp4",
    });
    expect(result.groupId).toMatch(/^avatar_group/);
    expect(result.consentUrl).toContain(result.groupId);
  });

  it("getDigitalTwinStatus is ready by default with provider ids", async () => {
    const provider = createMockProvider();
    const status = await provider.getDigitalTwinStatus({ groupId: "g1" });
    expect(status).toMatchObject({
      consentStatus: "approved",
      trainingStatus: "ready",
    });
    expect(status.providerAvatarId).toBeTruthy();
    expect(status.providerVoiceId).toBeTruthy();
  });

  it("getDigitalTwinStatus follows an injected status sequence (consent state machine tests)", async () => {
    const provider = createMockProvider({
      twinStatusSequence: [
        { consentStatus: "awaiting_user", trainingStatus: "pending", consentUrl: "https://consent.example.com/g1" },
        { consentStatus: "approved", trainingStatus: "processing" },
        { consentStatus: "approved", trainingStatus: "ready", providerAvatarId: "look_9", providerVoiceId: "voice_9" },
      ],
    });
    expect((await provider.getDigitalTwinStatus({ groupId: "g1" })).consentStatus).toBe("awaiting_user");
    expect((await provider.getDigitalTwinStatus({ groupId: "g1" })).trainingStatus).toBe("processing");
    expect((await provider.getDigitalTwinStatus({ groupId: "g1" })).providerAvatarId).toBe("look_9");
    // 序列耗尽后保持最后一个状态
    expect((await provider.getDigitalTwinStatus({ groupId: "g1" })).providerAvatarId).toBe("look_9");
  });

  it("refreshConsent returns a fresh consent url", async () => {
    const provider = createMockProvider();
    const { consentUrl } = await provider.refreshConsent({ groupId: "g1" });
    expect(consentUrl).toContain("g1");
  });

  it("synthesizeSpeech returns duration + per-word timestamps; failTts throws", async () => {
    const provider = createMockProvider();
    const speech = await provider.synthesizeSpeech({
      providerVoiceId: "voice_1",
      text: "你好欢迎",
    });
    expect(speech.audioStorageKey).toMatch(/^voice_audio/);
    expect(speech.durationSeconds).toBeGreaterThan(0);
    expect(speech.words).toHaveLength(Array.from("你好欢迎").length);
    expect(speech.words[0]).toMatchObject({ word: "你", startSec: 0 });
    expect(speech.words.at(-1)!.endSec).toBeCloseTo(speech.durationSeconds, 5);

    await expect(
      createMockProvider({ failTts: true }).synthesizeSpeech({ providerVoiceId: "v", text: "x" }),
    ).rejects.toThrow();
  });
});
