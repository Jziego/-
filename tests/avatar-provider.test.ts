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
