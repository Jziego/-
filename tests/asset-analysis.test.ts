import { describe, expect, it } from "vitest";
import { classifyAsset, createUploadIntent } from "@/lib/services/assets";
import type { Asset, StoreProfile } from "@/lib/types";

const store: StoreProfile = {
  id: "store_1",
  ownerId: "user_1",
  name: "甜心烘焙",
  industry: "烘焙",
  location: "杭州市西湖区",
  mainProducts: ["生日蛋糕", "可颂"],
  averageOrderValue: 68,
  targetCustomers: ["年轻家庭", "附近白领"],
  sellingPoints: ["当日现烤", "可预约定制"],
  promotions: ["下午茶套餐"],
  brandTone: "温暖精致",
  forbiddenWords: ["包治"],
  createdAt: "2026-06-03T10:00:00.000Z",
  updatedAt: "2026-06-03T10:00:00.000Z"
};

const asset: Asset = {
  id: "asset_1",
  ownerId: "user_1",
  storeId: "store_1",
  type: "video",
  originalFilename: "fresh-croissant.mp4",
  storageKey: "stores/store_1/assets/fresh-croissant.mp4",
  mimeType: "video/mp4",
  sizeBytes: 9_000_000,
  durationSeconds: 12,
  width: 1080,
  height: 1920,
  tags: [],
  businessTags: [],
  status: "uploaded",
  createdAt: "2026-06-03T10:00:00.000Z"
};

describe("asset upload and analysis", () => {
  it("creates direct-to-object-storage upload intents without exposing provider secrets", () => {
    const intent = createUploadIntent({
      ownerId: "user_1",
      storeId: "store_1",
      filename: "fresh-croissant.mp4",
      contentType: "video/mp4",
      sizeBytes: 9_000_000
    });

    expect(intent.storageKey).toMatch(/^stores\/store_1\/assets\//);
    expect(intent.uploadUrl).toContain("signed-upload");
    expect(intent.headers).not.toHaveProperty("Authorization");
  });

  it("combines visual tags, speech keywords and store industry rules", async () => {
    const analysis = await classifyAsset({
      asset,
      store,
      visualLabels: ["bakery", "croissant", "person"],
      transcript: "今天的可颂刚出炉，下午茶很适合"
    });

    expect(analysis.visualTags).toContain("croissant");
    expect(analysis.keywords).toContain("可颂");
    expect(analysis.businessTags).toContain("新品推荐");
    expect(analysis.recommendedUses).toContain("new_product");
  });

  it("falls back to filename and manual tag suggestions when automated analysis is unavailable", async () => {
    const analysis = await classifyAsset({
      asset,
      store,
      manualTags: ["门店环境"],
      analysisUnavailable: true
    });

    expect(analysis.confidence).toBeLessThan(0.5);
    expect(analysis.businessTags).toContain("门店环境");
    expect(analysis.recommendedUses).toContain("store_traffic");
  });
});
