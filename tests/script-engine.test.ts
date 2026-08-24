import { describe, expect, it, vi } from "vitest";
import { createScriptDraft, createTemplateScriptDraft, warnIfVoiceoverOffTarget } from "@/lib/services/script-engine";
import * as aiClient from "@/lib/services/ai-client";
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

describe("script engine (voiceover-centric)", () => {
  it("creates structured short-video copy from store profile and asset analysis", async () => {
    const draft = await createScriptDraft({
      store,
      assetAnalyses: analysis,
      purpose: "store_traffic",
      platform: "douyin"
    });

    expect(draft.title).toContain("阿姨手作面馆");
    expect(draft.hook).toContain("牛肉面");
    expect(draft.voiceover).toContain("现熬牛骨汤");
    expect(draft.cta).toContain("到店");
    expect(draft.complianceWarnings).not.toContain("全网第一");
    // Phase 2：口播为中心——30s 模板 2 句 → 2 segments / 2 presenter scenes
    expect(draft.segments ?? []).toHaveLength(2);
    expect(draft.highlights).toEqual(expect.arrayContaining(["牛肉面", "现熬牛骨汤"]));
    expect(draft.scenes).toHaveLength(2);
    expect(draft.scenes.every((s) => s.role === "presenter")).toBe(true);
    expect(draft.scenes[0]?.text).toBe(draft.segments?.[0]?.text);
  });

  it("falls back to a deterministic industry template when AI generation is unavailable", () => {
    const draft = createTemplateScriptDraft({
      store,
      purpose: "new_product",
      reason: "ai_unavailable"
    });

    expect(draft.generationMode).toBe("template_fallback");
    expect(draft.title).toContain("牛肉面");
    expect(draft.voiceover).toContain("牛肉面");
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
    expect(draft.highlights).toEqual(["牛肉面"]);
  });

  it("derives presenter scenes from the first and last voiceover sentences", () => {
    const draft = createTemplateScriptDraft({ store, purpose: "promotion", reason: "test" });
    const segments = draft.segments ?? [];
    expect(draft.scenes.map((s) => s.role)).toEqual(["presenter", "presenter"]);
    expect(draft.scenes[0]?.text).toBe(segments[0]?.text);
    expect(draft.scenes[1]?.text).toBe(segments[segments.length - 1]?.text);
  });

  it("accepts targetDurationSec and carries it onto the draft", async () => {
    const draft = await createScriptDraft({
      store,
      assetAnalyses: analysis,
      purpose: "promotion",
      platform: "douyin",
      forcedRawCopy: "短文案测试",
      targetDurationSec: 15,
    });
    expect(draft.targetDurationSec).toBe(15);
    expect((draft.segments ?? []).length).toBeGreaterThan(0);
  });

  it("template 45s slot: 3 segments, 2 derived presenter scenes with estimated durations", () => {
    const d45 = createTemplateScriptDraft({
      store, purpose: "store_traffic", reason: "test", targetDurationSec: 45,
    });
    expect(d45.targetDurationSec).toBe(45);
    // 45s 档口播 3 句（主推 + 第二产品 + CTA）
    expect(d45.segments ?? []).toHaveLength(3);
    expect(d45.scenes).toHaveLength(2);
    // 首句 20 字 ≈ 4s；末句 15 字 ≈ 3s
    expect(d45.scenes.map((s) => s.durationSeconds)).toEqual([4, 3]);
  });

  it("template default (no target) keeps the 30s 2-sentence layout", () => {
    const d = createTemplateScriptDraft({ store, purpose: "store_traffic", reason: "test" });
    expect(d.segments ?? []).toHaveLength(2);
    expect(d.scenes).toHaveLength(2);
    expect(d.targetDurationSec).toBeUndefined();
  });

  it("template 60s slot produces more segments and store-field highlights", () => {
    const d30 = createTemplateScriptDraft({
      store, purpose: "store_traffic", reason: "test", targetDurationSec: 30,
    });
    const d60 = createTemplateScriptDraft({
      store, purpose: "store_traffic", reason: "test", targetDurationSec: 60,
    });
    expect((d60.segments ?? []).length).toBeGreaterThan((d30.segments ?? []).length);
    expect(d60.voiceover.length).toBeGreaterThan(d30.voiceover.length);
    expect(d60.voiceover).toContain("工作日午餐第二份半价");
    expect(d60.highlights).toEqual(expect.arrayContaining(["工作日午餐第二份半价", "葱油拌面"]));
  });

  it("warnIfVoiceoverOffTarget warns when voiceover length deviates >50% from the slot", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    warnIfVoiceoverOffTarget("太短了。", 45); // 4 字 vs 预期 ≈202 字
    expect(spy).toHaveBeenCalledOnce();
    spy.mockClear();
    warnIfVoiceoverOffTarget("字".repeat(200), 45); // 200 字 ≈ 预期 202 字
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("AI path filters highlights to words present in the voiceover and derives segments/scenes", async () => {
    const hasAISpy = vi.spyOn(aiClient, "hasAI").mockReturnValue(true);
    const aiSpy = vi.spyOn(aiClient, "chatCompletionJSON").mockResolvedValue({
      title: "测试标题",
      hook: "测试钩子",
      voiceover: "第一句口播内容。第二句口播内容。第三句口播内容。",
      highlights: ["口播", "稿里不存在的词"],
      onCameraSentences: ["第二句口播内容。"],
      cta: "到店体验",
    });
    try {
      const draft = await createScriptDraft({
        store, assetAnalyses: analysis, purpose: "store_traffic", platform: "douyin",
      });
      expect(draft.generationMode).toBe("ai");
      expect(draft.highlights).toEqual(["口播"]);
      const segments = draft.segments ?? [];
      expect(segments.map((s) => s.text)).toEqual(["第一句口播内容。", "第二句口播内容。", "第三句口播内容。"]);
      expect(segments.map((s) => s.onCamera)).toEqual([false, true, false]);
      expect(segments.every((s) => s.speakerIndex === 0)).toBe(true);
      expect(draft.scenes).toHaveLength(2);
      expect(draft.scenes[0]?.text).toBe("第一句口播内容。");
    } finally {
      hasAISpy.mockRestore();
      aiSpy.mockRestore();
    }
  });

  it("AI path tolerates missing highlights/onCameraSentences (defaults: first+last on-camera)", async () => {
    const hasAISpy = vi.spyOn(aiClient, "hasAI").mockReturnValue(true);
    const aiSpy = vi.spyOn(aiClient, "chatCompletionJSON").mockResolvedValue({
      title: "t",
      hook: "h",
      voiceover: "开场一句。中间一句。结尾一句。",
      cta: "到店",
    });
    try {
      const draft = await createScriptDraft({
        store, assetAnalyses: analysis, purpose: "store_traffic", platform: "douyin",
      });
      expect(draft.highlights).toEqual([]);
      expect((draft.segments ?? []).map((s) => s.onCamera)).toEqual([true, false, true]);
    } finally {
      hasAISpy.mockRestore();
      aiSpy.mockRestore();
    }
  });

  it("AI path tries high reasoning effort first with raised budget/timeout (deepseek reasoning eats max_tokens)", async () => {
    const hasAISpy = vi.spyOn(aiClient, "hasAI").mockReturnValue(true);
    const aiSpy = vi.spyOn(aiClient, "chatCompletionJSON").mockResolvedValue({
      title: "t",
      hook: "h",
      voiceover: "开场一句。中间一句。结尾一句。",
      cta: "到店",
    });
    try {
      await createScriptDraft({
        store, assetAnalyses: analysis, purpose: "store_traffic", platform: "douyin",
      });
      expect(aiSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ reasoningEffort: "high", maxTokens: 16000, timeout: 150_000, maxAttempts: 1 }),
      );
    } finally {
      hasAISpy.mockRestore();
      aiSpy.mockRestore();
    }
  });

  it("falls back to a low-effort call when the high-effort attempt returns null", async () => {
    const hasAISpy = vi.spyOn(aiClient, "hasAI").mockReturnValue(true);
    const aiSpy = vi.spyOn(aiClient, "chatCompletionJSON")
      .mockResolvedValueOnce(null) // high-effort attempt: empty/truncated
      .mockResolvedValueOnce({
        title: "t",
        hook: "h",
        voiceover: "开场一句。中间一句。结尾一句。",
        cta: "到店",
      });
    try {
      const draft = await createScriptDraft({
        store, assetAnalyses: analysis, purpose: "store_traffic", platform: "douyin",
      });
      expect(draft.generationMode).toBe("ai");
      expect(aiSpy).toHaveBeenCalledTimes(2);
      // Second call: default (low) effort, moderate budget — no high-effort overrides.
      const secondCallOptions = aiSpy.mock.calls[1]?.[2] as Record<string, unknown>;
      expect(secondCallOptions.reasoningEffort).toBeUndefined();
      expect(secondCallOptions.maxTokens).toBe(3000);
    } finally {
      hasAISpy.mockRestore();
      aiSpy.mockRestore();
    }
  });

  it("forcedRawCopy path derives segments, scenes and store-field highlights", async () => {
    const draft = await createScriptDraft({
      store, assetAnalyses: analysis, purpose: "promotion", platform: "douyin",
      forcedRawCopy: "现熬牛骨汤，午市出餐快。欢迎来尝。",
    });
    expect(draft.segments ?? []).toHaveLength(2);
    expect(draft.scenes.map((s) => s.role)).toEqual(["presenter", "presenter"]);
    expect(draft.highlights).toEqual(expect.arrayContaining(["现熬牛骨汤", "午市出餐快"]));
  });
});
