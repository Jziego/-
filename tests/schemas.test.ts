import { describe, expect, it } from "vitest";
import {
  assetSchema,
  avatarProfileSchema,
  renderProjectSchema,
  storeProfileSchema
} from "@/lib/schemas";

describe("core SaaS schemas", () => {
  it("validates the minimum production store profile required by AI prompts", () => {
    const profile = storeProfileSchema.parse({
      id: "store_1",
      ownerId: "user_1",
      name: "阿姨手作面馆",
      industry: "餐饮",
      location: "上海市徐汇区",
      mainProducts: ["牛肉面", "葱油拌面"],
      averageOrderValue: 38,
      targetCustomers: ["附近上班族"],
      sellingPoints: ["现熬牛骨汤", "午市出餐快"],
      promotions: ["工作日午餐第二份半价"],
      brandTone: "亲切接地气",
      forbiddenWords: ["最便宜", "全网第一"],
      contactPhone: "13800138000",
      logoAssetId: "asset_logo",
      storefrontAssetId: "asset_front",
      createdAt: "2026-06-03T10:00:00.000Z",
      updatedAt: "2026-06-03T10:00:00.000Z"
    });

    expect(profile.mainProducts).toContain("牛肉面");
    expect(profile.forbiddenWords).toContain("全网第一");
  });

  it("rejects an incomplete store profile because the render pipeline needs business context", () => {
    expect(() =>
      storeProfileSchema.parse({
        id: "store_1",
        ownerId: "user_1",
        name: "",
        industry: "",
        mainProducts: [],
        targetCustomers: [],
        sellingPoints: []
      })
    ).toThrow();
  });

  it("models uploaded assets with object storage keys and processing state", () => {
    const asset = assetSchema.parse({
      id: "asset_1",
      ownerId: "user_1",
      storeId: "store_1",
      type: "video",
      originalFilename: "noodles.mp4",
      storageKey: "stores/store_1/assets/noodles.mp4",
      mimeType: "video/mp4",
      sizeBytes: 12_000_000,
      durationSeconds: 18,
      width: 1080,
      height: 1920,
      tags: ["菜品", "制作过程"],
      businessTags: ["招牌菜"],
      status: "ready",
      createdAt: "2026-06-03T10:00:00.000Z"
    });

    expect(asset.storageKey).toContain("stores/store_1/assets");
    expect(asset.status).toBe("ready");
  });

  it("tracks avatar provider state separately from render projects", () => {
    const avatar = avatarProfileSchema.parse({
      id: "avatar_1",
      ownerId: "user_1",
      storeId: "store_1",
      provider: "heygen",
      providerAvatarId: "external-avatar-id",
      providerVoiceId: "external-voice-id",
      consentAcceptedAt: "2026-06-03T10:00:00.000Z",
      trainingStatus: "ready",
      fallbackMode: "tts_voiceover",
      createdAt: "2026-06-03T10:00:00.000Z",
      updatedAt: "2026-06-03T10:00:00.000Z"
    });

    expect(avatar.trainingStatus).toBe("ready");
    expect(avatar.fallbackMode).toBe("tts_voiceover");
  });

  it("locks selected assets, script, avatar and output settings in a render project", () => {
    const project = renderProjectSchema.parse({
      id: "render_1",
      ownerId: "user_1",
      storeId: "store_1",
      scriptDraftId: "script_1",
      selectedAssetIds: ["asset_1", "asset_2"],
      avatarProfileId: "avatar_1",
      purpose: "new_product",
      aspectRatio: "9:16",
      subtitleStyle: "bold_bottom",
      bgmTrackId: "bgm_warm",
      status: "queued",
      createdAt: "2026-06-03T10:00:00.000Z",
      updatedAt: "2026-06-03T10:00:00.000Z"
    });

    expect(project.selectedAssetIds).toHaveLength(2);
    expect(project.aspectRatio).toBe("9:16");
  });
});
