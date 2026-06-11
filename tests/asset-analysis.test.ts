import { beforeEach, describe, expect, it, vi } from "vitest";
import { classifyAsset, createUploadIntent } from "@/lib/services/assets";
import * as storage from "@/lib/storage";
import * as aiClient from "@/lib/services/ai-client";
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
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(storage, "createPresignedPutUrl").mockResolvedValue("https://signed.example/upload");
    // Default: AI available with mock response
    vi.spyOn(aiClient, "hasAI").mockReturnValue(true);
    vi.spyOn(aiClient, "chatCompletionJSON").mockResolvedValue({
      businessTags: ["新品推荐", "门店环境"],
      keywords: ["可颂", "烘焙", "下午茶"],
      recommendedUses: ["new_product", "store_traffic"],
      reasoning: "烘焙店新品可颂，门店环境适合下午茶消费场景",
    });
  });

  it("creates direct-to-object-storage upload intents without exposing provider secrets", async () => {
    const intent = await createUploadIntent({
      ownerId: "user_1",
      storeId: "store_1",
      filename: "fresh-croissant.mp4",
      contentType: "video/mp4",
      sizeBytes: 9_000_000
    });

    expect(intent.storageKey).toMatch(/^stores\/store_1\/assets\//);
    expect(intent.uploadUrl).toBe("https://signed.example/upload");
    expect(intent.headers).toEqual({ "Content-Type": "video/mp4" });
    expect(intent.headers).not.toHaveProperty("Authorization");
    expect(intent.maxSizeBytes).toBeGreaterThan(9_000_000);
    expect(intent.expiresInSeconds).toBeGreaterThan(0);
  });

  it("uses AI classification when available", async () => {
    const analysis = await classifyAsset({
      asset,
      store,
      visualLabels: ["croissant", "bakery"],
      transcript: "今天的可颂刚出炉，下午茶很适合",
    });

    expect(aiClient.chatCompletionJSON).toHaveBeenCalled();
    expect(analysis.businessTags).toContain("新品推荐");
    expect(analysis.keywords).toContain("可颂");
    expect(analysis.recommendedUses).toContain("new_product");
    // AI mode should have higher confidence than unavailable mode
    expect(analysis.confidence).toBeGreaterThan(0.5);
  });

  it("falls back to rule engine when AI fails", async () => {
    vi.spyOn(aiClient, "chatCompletionJSON").mockRejectedValue(new Error("API timeout"));

    const analysis = await classifyAsset({
      asset,
      store,
      visualLabels: ["croissant"],
      transcript: "可颂刚出炉",
    });

    // Rule engine still detects keywords from hardcoded candidates
    expect(analysis.keywords).toContain("可颂");
    // Rule engine still infers business tags from industry + filename
    expect(analysis.businessTags).toContain("新品推荐");
  });

  it("falls back to filename and manual tag suggestions when automated analysis is unavailable", async () => {
    const analysis = await classifyAsset({
      asset,
      store,
      manualTags: ["门店环境"],
      analysisUnavailable: true,
    });

    expect(analysis.confidence).toBeLessThan(0.5);
    expect(analysis.businessTags).toContain("门店环境");
    expect(analysis.recommendedUses).toContain("store_traffic");
    // analysisUnavailable should skip AI entirely
    expect(aiClient.chatCompletionJSON).not.toHaveBeenCalled();
  });
});
