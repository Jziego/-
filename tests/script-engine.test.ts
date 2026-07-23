import { describe, expect, it } from "vitest";
import { createScriptDraft, createTemplateScriptDraft } from "@/lib/services/script-engine";
import type { AssetAnalysis, StoreProfile } from "@/lib/types";

const store: StoreProfile = {
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
};

const analysis: AssetAnalysis[] = [
  {
    id: "analysis_1",
    assetId: "asset_1",
    visualTags: ["食物", "热汤", "门店环境"],
    businessTags: ["招牌菜", "到店引流"],
    transcript: "牛肉面热气腾腾，午餐很快出餐",
    keywords: ["牛肉面", "午餐", "快"],
    confidence: 0.86,
    recommendedUses: ["new_product", "store_traffic"],
    createdAt: "2026-06-03T10:00:00.000Z",
    analysisStatus: "succeeded"
  }
];

describe("script engine", () => {
  it("creates structured short-video copy from store profile and asset analysis", async () => {
    const draft = await createScriptDraft({
      store,
      assetAnalyses: analysis,
      purpose: "store_traffic",
      platform: "douyin"
    });

    expect(draft.title).toContain("阿姨手作面馆");
    expect(draft.hook).toContain("牛肉面");
    expect(draft.scenes).toHaveLength(3);
    expect(draft.voiceover).toContain("现熬牛骨汤");
    expect(draft.cta).toContain("到店");
    expect(draft.complianceWarnings).not.toContain("全网第一");
  });

  it("falls back to a deterministic industry template when AI generation is unavailable", () => {
    const draft = createTemplateScriptDraft({
      store,
      assetAnalyses: analysis,
      purpose: "new_product",
      reason: "ai_unavailable"
    });

    expect(draft.generationMode).toBe("template_fallback");
    expect(draft.title).toContain("牛肉面");
    expect(draft.scenes[0]?.assetHints).toContain("招牌菜");
  });

  it("removes forbidden words from generated copy", async () => {
    const draft = await createScriptDraft({
      store,
      assetAnalyses: analysis,
      purpose: "promotion",
      platform: "wechat_channels",
      forcedRawCopy: "全网第一便宜，附近最便宜的牛肉面"
    });

    expect(draft.voiceover).not.toContain("全网第一");
    expect(draft.voiceover).not.toContain("最便宜");
    expect(draft.complianceWarnings).toContain("Removed forbidden words: 最便宜, 全网第一");
  });

  it("assigns presenter to hook+cta scenes and broll to the product scene", () => {
    const draft = createTemplateScriptDraft({
      store,
      assetAnalyses: analysis,
      purpose: "promotion",
      reason: "test"
    });

    expect(draft.scenes.map((s) => s.role)).toEqual(["presenter", "broll", "presenter"]);
  });

  it("fills matchedAssetId on generated scenes via tag overlap", async () => {
    const draft = await createScriptDraft({
      store,
      assetAnalyses: analysis,
      purpose: "store_traffic",
      platform: "douyin",
      forcedRawCopy: "现熬牛骨汤，午市出餐快",
    });
    // template scenes 的 hints 含 analysis 的 businessTags（招牌菜/到店引流）
    const matched = draft.scenes.map((s) => s.matchedAssetId ?? null);
    expect(matched).toContain("asset_1");
  });

  it("accepts targetDurationSec and threads a duration hint into the prompt", async () => {
    // forcedRawCopy 路径不依赖 AI，仅验证入参被接受且不抛错
    const draft = await createScriptDraft({
      store,
      assetAnalyses: analysis,
      purpose: "promotion",
      platform: "douyin",
      forcedRawCopy: "短文案测试",
      targetDurationSec: 15,
    });
    expect(draft.scenes.length).toBeGreaterThan(0);
  });
});
