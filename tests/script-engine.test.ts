import { describe, expect, it, vi } from "vitest";
import { createScriptDraft, createTemplateScriptDraft, warnIfDurationOffTarget } from "@/lib/services/script-engine";
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

  it("template draft carries targetDurationSec and scales scene durations to the slot", () => {
    const d45 = createTemplateScriptDraft({
      store, assetAnalyses: analysis, purpose: "store_traffic",
      reason: "test", targetDurationSec: 45,
    });
    expect(d45.targetDurationSec).toBe(45);
    // 45s 档：4 镜（开场 presenter + 2 broll + 结尾 presenter），presenter 镜各 ≈45*0.15≈7s
    expect(d45.scenes).toHaveLength(4);
    const presenters = d45.scenes.filter((s) => s.role === "presenter");
    expect(presenters).toHaveLength(2);
    for (const p of presenters) expect(p.durationSeconds).toBe(7);
  });

  it("template default (no target) keeps the 3-scene 30s layout", () => {
    const d = createTemplateScriptDraft({
      store, assetAnalyses: analysis, purpose: "store_traffic", reason: "test",
    });
    expect(d.scenes).toHaveLength(3);
    expect(d.targetDurationSec).toBeUndefined();
  });

  it("template 60s slot produces 5 scenes and longer voiceover than 30s slot", () => {
    const d30 = createTemplateScriptDraft({
      store, assetAnalyses: analysis, purpose: "store_traffic",
      reason: "test", targetDurationSec: 30,
    });
    const d60 = createTemplateScriptDraft({
      store, assetAnalyses: analysis, purpose: "store_traffic",
      reason: "test", targetDurationSec: 60,
    });
    expect(d60.scenes).toHaveLength(5);
    expect(d60.voiceover.length).toBeGreaterThan(d30.voiceover.length);
    // 60s 档口播包含活动信息（store.promotions[0] 存在时）
    expect(d60.voiceover).toContain("工作日午餐第二份半价");
  });

  it("warnIfDurationOffTarget warns when scene sum deviates >50% from target", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    warnIfDurationOffTarget(
      [{ order: 1, text: "x", durationSeconds: 5, assetHints: [], role: "presenter" }],
      45,
    );
    expect(spy).toHaveBeenCalledOnce();
    spy.mockClear();
    warnIfDurationOffTarget(
      [
        { order: 1, text: "a", durationSeconds: 20, assetHints: [], role: "presenter" },
        { order: 2, text: "b", durationSeconds: 20, assetHints: [], role: "broll" },
      ],
      45,
    );
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
