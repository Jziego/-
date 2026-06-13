import { createId, nowIso } from "@/lib/ids";
import { hasAI, chatCompletionJSON, sanitizePromptField } from "@/lib/services/ai-client";
import type { AssetAnalysis, MarketingPurpose, Platform, ScriptDraft, ScriptScene, StoreProfile } from "@/lib/types";

// ── Public input types ─────────────────────────────────────────────────────

interface ScriptDraftInput {
  store: StoreProfile;
  assetAnalyses: AssetAnalysis[];
  purpose: MarketingPurpose;
  platform?: Platform;
  forcedRawCopy?: string;
}

interface TemplateDraftInput {
  store: StoreProfile;
  assetAnalyses: AssetAnalysis[];
  purpose: MarketingPurpose;
  reason: string;
}

// ── AI response schema ─────────────────────────────────────────────────────

interface AIScriptResponse {
  title: string;
  hook: string;
  scenes: Array<{
    order: number;
    text: string;
    durationSeconds: number;
    assetHints: string[];
  }>;
  voiceover: string;
  captions: string[];
  cta: string;
}

// ── Purpose labels ─────────────────────────────────────────────────────────

const purposeLabels: Record<MarketingPurpose, string> = {
  store_traffic: "引流到店",
  new_product: "新品推荐",
  promotion: "促销活动",
  holiday: "节日营销",
  testimonial: "口碑推荐",
  recruiting: "招聘",
};

const purposeCta: Record<MarketingPurpose, string> = {
  store_traffic: "现在到店，直接报视频里的活动",
  new_product: "到店试试今天主推新品",
  promotion: "到店领取本期优惠",
  holiday: "节日期间到店体验限定活动",
  testimonial: "欢迎到店体验大家都在夸的招牌",
  recruiting: "欢迎来店咨询岗位",
};

const platformNames: Record<Platform, string> = {
  douyin: "抖音",
  wechat_channels: "微信视频号",
  xiaohongshu: "小红书",
  kuaishou: "快手",
};

// ── System prompt ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `你是为本地实体店创作短视频脚本的营销文案专家。
你的文案必须口语化、有网感、适合短视频配音。视频时长控制在15-30秒。

要求：
- 开头3秒内抓住注意力（hook）
- 突出产品卖点和门店特色
- 语言自然不僵硬，像真人说话
- 结尾有明确的行动号召（CTA）
- 每句配音控制在8-15个字，方便朗读
- 分3-4个场景，每个场景标注需要的画面素材提示

你会收到门店信息、素材分析结果、营销目的和发布平台，请根据这些信息创作脚本。`;

const SCHEMA_DESCRIPTION = `{
  "title": "视频标题（10字以内）",
  "hook": "开头吸引句（15字以内）",
  "scenes": [
    {
      "order": 1,
      "text": "场景描述",
      "durationSeconds": 4,
      "assetHints": ["需要的画面素材标签"]
    }
  ],
  "voiceover": "完整配音文案",
  "captions": ["字幕行1", "字幕行2"],
  "cta": "行动号召文案"
}`;

// ── Prompt builders ────────────────────────────────────────────────────────

function buildUserPrompt(input: ScriptDraftInput): string {
  const store = input.store;
  const hints = collectAssetHints(input.assetAnalyses);
  const platform = input.platform ?? "douyin";

  const lines = [
    `【门店信息】`,
    `店名：${sanitizePromptField(store.name, 100)}`,
    `行业：${sanitizePromptField(store.industry, 50)}`,
    `位置：${sanitizePromptField(store.location ?? "未填写", 100)}`,
    `主推产品：${store.mainProducts.map((p) => sanitizePromptField(p, 60)).join("、") || "未填写"}`,
    `卖点：${store.sellingPoints.map((p) => sanitizePromptField(p, 80)).join("、") || "未填写"}`,
    `目标客群：${store.targetCustomers.map((c) => sanitizePromptField(c, 40)).join("、") || "未填写"}`,
    `品牌调性：${sanitizePromptField(store.brandTone, 100)}`,
    store.promotions?.length ? `当前活动：${store.promotions.map((p) => sanitizePromptField(p, 80)).join("、")}` : null,
    ``,
    `【素材标签】${hints.length ? hints.join("、") : "无特定标签"}`,
    ``,
    `【营销目的】${purposeLabels[input.purpose]}`,
    `【发布平台】${platformNames[platform]}`,
  ].filter(Boolean);

  return lines.join("\n");
}

// ── Main entry point ───────────────────────────────────────────────────────

export async function createScriptDraft(input: ScriptDraftInput): Promise<ScriptDraft> {
  // 1. Forced raw copy bypasses AI
  if (input.forcedRawCopy) {
    const cleaned = sanitizeCopy(input.forcedRawCopy, input.store.forbiddenWords);
    return buildDraft({
      store: input.store,
      assetAnalyses: input.assetAnalyses,
      purpose: input.purpose,
      platform: input.platform ?? "douyin",
      generationMode: "ai",
      title: `${input.store.name}本期推荐`,
      hook: cleaned.copy,
      voiceover: cleaned.copy,
      scenes: buildTemplateScenes(input.store, input.assetAnalyses),
      captions: [cleaned.copy],
      cta: purposeCta[input.purpose],
      warnings: cleaned.warnings,
    });
  }

  // 2. Try AI generation
  if (hasAI()) {
    try {
      return await createScriptDraftWithAI(input);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[script-engine] AI generation failed, falling back to template: ${reason}`);
      return createTemplateScriptDraft({
        store: input.store,
        assetAnalyses: input.assetAnalyses,
        purpose: input.purpose,
        reason,
      });
    }
  }

  // 3. No AI configured — use template
  return createTemplateScriptDraft({
    store: input.store,
    assetAnalyses: input.assetAnalyses,
    purpose: input.purpose,
    reason: "AI not configured (missing OPENAI_API_KEY)",
  });
}

// ── AI generation ──────────────────────────────────────────────────────────

export async function createScriptDraftWithAI(
  input: ScriptDraftInput,
): Promise<ScriptDraft> {
  const userPrompt = buildUserPrompt(input);
  const aiResponse = await chatCompletionJSON<AIScriptResponse>(
    SYSTEM_PROMPT,
    userPrompt,
    { schemaDescription: SCHEMA_DESCRIPTION, temperature: 0.8, maxTokens: 1500 },
  );

  if (!aiResponse) {
    throw new Error("AI returned empty response");
  }

  // Validate and sanitize
  const voiceover = sanitizeCopy(
    aiResponse.voiceover || `${input.store.name}欢迎你`,
    input.store.forbiddenWords,
  );

  const scenes: ScriptScene[] = (aiResponse.scenes?.length
    ? aiResponse.scenes
    : buildTemplateScenes(input.store, input.assetAnalyses)
  ).map((s, i) => ({
    order: s.order ?? i + 1,
    text: String(s.text ?? ""),
    durationSeconds: Number(s.durationSeconds) || 5,
    assetHints: Array.isArray(s.assetHints) ? s.assetHints.map(String) : [],
  }));

  return buildDraft({
    store: input.store,
    assetAnalyses: input.assetAnalyses,
    purpose: input.purpose,
    platform: input.platform ?? "douyin",
    generationMode: "ai",
    title: String(aiResponse.title || `${input.store.name}推荐`).slice(0, 30),
    hook: String(aiResponse.hook || voiceover.copy.slice(0, 15)),
    voiceover: voiceover.copy,
    scenes,
    captions: Array.isArray(aiResponse.captions)
      ? aiResponse.captions.map(String)
      : [voiceover.copy],
    cta: String(aiResponse.cta || purposeCta[input.purpose]),
    warnings: voiceover.warnings,
  });
}

// ── Template fallback ──────────────────────────────────────────────────────

export function createTemplateScriptDraft(input: TemplateDraftInput): ScriptDraft {
  const primaryProduct = input.store.mainProducts[0] ?? "招牌产品";
  const warnings = [`AI unavailable, used template fallback: ${input.reason}`];
  const hook = `今天推荐${input.store.name}的${primaryProduct}`;
  const voiceover = `${input.store.name}今天主推${primaryProduct}，${input.store.sellingPoints[0] ?? "门店现做现卖"}。${purposeCta[input.purpose]}。`;
  const cleaned = sanitizeCopy(voiceover, input.store.forbiddenWords);

  return buildDraft({
    store: input.store,
    assetAnalyses: input.assetAnalyses,
    purpose: input.purpose,
    platform: "douyin",
    generationMode: "template_fallback",
    title: `${input.store.name}｜${primaryProduct}到店推荐`,
    hook,
    voiceover: cleaned.copy,
    scenes: buildTemplateScenes(input.store, input.assetAnalyses),
    captions: [hook, cleaned.copy, purposeCta[input.purpose]],
    cta: purposeCta[input.purpose],
    warnings: [...warnings, ...cleaned.warnings],
  });
}

// ── Shared builders ────────────────────────────────────────────────────────

function buildDraft(input: {
  store: StoreProfile;
  assetAnalyses: AssetAnalysis[];
  purpose: MarketingPurpose;
  platform: Platform;
  generationMode: "ai" | "template_fallback";
  title: string;
  hook: string;
  voiceover: string;
  scenes: ScriptScene[];
  captions: string[];
  cta: string;
  warnings: string[];
}): ScriptDraft {
  return {
    id: createId("script"),
    ownerId: input.store.ownerId,
    storeId: input.store.id,
    purpose: input.purpose,
    platform: input.platform,
    title: input.title,
    hook: input.hook,
    scenes: input.scenes,
    voiceover: input.voiceover,
    captions: input.captions,
    cta: input.cta,
    generationMode: input.generationMode,
    complianceWarnings: input.warnings,
    createdAt: nowIso(),
  };
}

function buildTemplateScenes(
  store: StoreProfile,
  assetAnalyses: AssetAnalysis[],
): ScriptScene[] {
  const hints = collectAssetHints(assetAnalyses);
  const primaryProduct = store.mainProducts[0] ?? "招牌产品";

  return [
    {
      order: 1,
      text: `开场展示${store.name}门店或招牌`,
      durationSeconds: 4,
      assetHints: hints.length ? hints : ["门店环境"],
    },
    {
      order: 2,
      text: `展示${primaryProduct}和制作/服务过程`,
      durationSeconds: 7,
      assetHints: [primaryProduct, ...hints].slice(0, 3),
    },
    {
      order: 3,
      text: "展示优惠、地址或到店 CTA",
      durationSeconds: 4,
      assetHints: ["促销", "到店引流"],
    },
  ];
}

// ── Helpers ────────────────────────────────────────────────────────────────

function collectAssetHints(assetAnalyses: AssetAnalysis[]): string[] {
  return [
    ...new Set(
      assetAnalyses.flatMap((analysis) => [
        ...analysis.businessTags,
        ...analysis.visualTags,
        ...analysis.keywords,
      ]),
    ),
  ].slice(0, 6);
}

function sanitizeCopy(
  copy: string,
  forbiddenWords: string[],
): { copy: string; warnings: string[] } {
  const removed = forbiddenWords.filter((word) => copy.includes(word));
  let cleaned = copy;

  for (const word of removed) {
    cleaned = cleaned.replaceAll(word, "");
  }

  return {
    copy: cleaned.replace(/\s+/g, " ").trim(),
    warnings: removed.length
      ? [`Removed forbidden words: ${removed.join(", ")}`]
      : [],
  };
}
