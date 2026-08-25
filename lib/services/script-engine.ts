import { createId, nowIso } from "@/lib/ids";
import { SPEECH_CHARS_PER_SECOND } from "@/lib/speech-rate";
import { hasAI, chatCompletionJSON, sanitizePromptField } from "@/lib/services/ai-client";
import {
  deriveScenesFromSegments,
  deriveSegmentsFromVoiceover,
  filterActiveHighlights,
} from "@/lib/services/scene-derive";
import type { AssetAnalysis, MarketingPurpose, Platform, ScriptDraft, ScriptSegment, StoreProfile } from "@/lib/types";

// ── Public input types ─────────────────────────────────────────────────────

interface ScriptDraftInput {
  store: StoreProfile;
  assetAnalyses: AssetAnalysis[];
  purpose: MarketingPurpose;
  platform?: Platform;
  forcedRawCopy?: string;
  /** 目标时长（秒）：30 / 45 / 60，影响 AI 文案量。 */
  targetDurationSec?: number;
  /** 可用形象人设（index 对齐 speakerAvatarIds）；≥2 时 AI 分配每句说话人。 */
  avatarPersonas?: { index: number; id: string; name: string }[];
}

interface TemplateDraftInput {
  store: StoreProfile;
  purpose: MarketingPurpose;
  reason: string;
  /** 目标时长（秒）：30 / 45 / 60，影响模板文案量。 */
  targetDurationSec?: number;
  /** speakerIndex → AvatarProfile.id 对齐表（生成时刻 personas 顺序）。 */
  speakerAvatarIds?: string[];
}

// ── AI response schema ─────────────────────────────────────────────────────

interface AIScriptResponse {
  title: string;
  hook: string;
  voiceover: string;
  /** 口播稿中需标黄的关键词原文（产品名/价格/活动/CTA）。 */
  highlights?: string[];
  /** 适合真人出镜的口播句原文（开场/CTA 优先）。 */
  onCameraSentences?: string[];
  /** 多形象时每句的说话人分配；sentences 必须逐字摘自 voiceover。 */
  speakerAssignments?: { speakerIndex: number; sentences: string[] }[];
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

const SYSTEM_PROMPT = `你是为本地实体店创作短视频口播稿的营销文案专家。
你的文案必须口语化、有网感、适合短视频配音。口播稿长度严格按用户给的【目标时长】要求的句数执行：逐句写满规定句数，不得少写（中文配音约每秒4.5字）。

要求：
- 开头3秒内抓住注意力（hook）
- 突出产品卖点和门店特色
- 语言自然不僵硬，像真人说话
- 结尾有明确的行动号召（CTA）
- 每句控制在8-15个字，方便朗读，句与句之间用中文句号分隔
- highlights：从口播稿中挑出需要字幕标黄的关键词（产品名/价格/活动/CTA），必须逐字摘自你写好的口播稿
- onCameraSentences：从口播稿中挑出适合真人出镜的句子（开场与结尾 CTA 优先），必须逐字摘自你写好的口播稿
- speakerAssignments：仅在给了【出镜形象】名单时必填；每句逐字摘自口播稿，speakerIndex 不得超过形象数量-1

你会收到门店信息、素材分析结果、营销目的和发布平台，请根据这些信息创作口播稿。`;

const SCHEMA_DESCRIPTION = `{
  "title": "视频标题（10字以内）",
  "hook": "开头吸引句（15字以内）",
  "voiceover": "完整口播文案（按目标时长控制总字数）",
  "highlights": ["口播稿中需标黄的关键词原文"],
  "onCameraSentences": ["适合真人出镜的口播句原文"],
  "speakerAssignments": [{"speakerIndex": 0, "sentences": ["逐字口播句"]}],
  "cta": "行动号召文案"
}`;

// ── Prompt builders ────────────────────────────────────────────────────────

function durationGuidance(target?: number): string {
  if (target === 45) return "约45秒：口播全文写满14-15句，每句8-15字（全文约190-210字）";
  if (target === 60) return "约60秒：口播全文写满18-20句，每句8-15字（全文约260-280字）";
  return "约30秒：口播全文写满10-12句，每句8-15字（全文约130-150字）";
}

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
    `【目标时长】${durationGuidance(input.targetDurationSec)}`,
    `【营销目的】${purposeLabels[input.purpose]}`,
    `【发布平台】${platformNames[platform]}`,
  ].filter(Boolean);

  if (input.avatarPersonas && input.avatarPersonas.length > 1) {
    lines.push(
      ``,
      `【出镜形象】本片 ${input.avatarPersonas.length} 位形象轮播出镜：`,
      ...input.avatarPersonas.map((p) => `${p.index + 1} 号：${sanitizePromptField(p.name, 20)}`),
      `请在 speakerAssignments 中把口播稿的【每一句】分配给一位形象（speakerIndex 从 0 起：0=1 号、1=2 号……），句子必须逐字摘自口播稿、覆盖全部句子且不重复；开场句与结尾 CTA 固定分配给 1 号形象。`,
    );
  }

  return lines.join("\n");
}

// ── Main entry point ───────────────────────────────────────────────────────

export async function createScriptDraft(input: ScriptDraftInput): Promise<ScriptDraft> {
  // 三条产出路径共用同一张对齐表：speakerIndex 按下标解析到生成时刻的 personas。
  const speakerAvatarIds = input.avatarPersonas?.map((p) => p.id);

  // 1. Forced raw copy bypasses AI
  if (input.forcedRawCopy) {
    const cleaned = sanitizeCopy(input.forcedRawCopy, input.store.forbiddenWords);
    return buildDraft({
      store: input.store,
      purpose: input.purpose,
      platform: input.platform ?? "douyin",
      generationMode: "ai",
      title: `${input.store.name}本期推荐`,
      hook: cleaned.copy,
      voiceover: cleaned.copy,
      highlights: storeFieldHighlights(input.store, cleaned.copy),
      segments: deriveSegmentsFromVoiceover(cleaned.copy),
      cta: purposeCta[input.purpose],
      warnings: cleaned.warnings,
      targetDurationSec: input.targetDurationSec,
      speakerAvatarIds,
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
        purpose: input.purpose,
        reason,
        targetDurationSec: input.targetDurationSec,
        speakerAvatarIds,
      });
    }
  }

  // 3. No AI configured — use template
  return createTemplateScriptDraft({
    store: input.store,
    purpose: input.purpose,
    reason: "AI not configured (missing OPENAI_API_KEY)",
    targetDurationSec: input.targetDurationSec,
    speakerAvatarIds,
  });
}

// ── AI generation ──────────────────────────────────────────────────────────

export async function createScriptDraftWithAI(
  input: ScriptDraftInput,
): Promise<ScriptDraft> {
  const userPrompt = buildUserPrompt(input);
  // 阶梯策略：先试 high 推理（字数/标黄质量更好：实测 222-300 字、标黄 5-6 个，
  // 优于 low 的 198-234 字/0-6 个）。high 推理长度不可控且计入 max_tokens（实测峰值
  // ~6.6k tokens/48s，8000 预算约 1/3 概率耗尽→空响应）→ 大预算 16000 + 超时 150s +
  // 单次尝试；失败立即回退默认 low 档（~4s，实测 7/7 稳定），避免用户等数分钟后只拿到模板。
  let aiResponse = await chatCompletionJSON<AIScriptResponse>(
    SYSTEM_PROMPT,
    userPrompt,
    {
      schemaDescription: SCHEMA_DESCRIPTION,
      temperature: 0.8,
      maxTokens: 16000,
      timeout: 150_000,
      reasoningEffort: "high",
      maxAttempts: 1,
    },
  );
  if (!aiResponse) {
    console.warn("[script-engine] high-effort generation unusable, retrying with default (low) effort");
    aiResponse = await chatCompletionJSON<AIScriptResponse>(
      SYSTEM_PROMPT,
      userPrompt,
      { schemaDescription: SCHEMA_DESCRIPTION, temperature: 0.8, maxTokens: 3000 },
    );
  }

  if (!aiResponse) {
    throw new Error("AI returned empty response");
  }

  const voiceover = sanitizeCopy(
    aiResponse.voiceover || `${input.store.name}欢迎你`,
    input.store.forbiddenWords,
  );
  warnIfVoiceoverOffTarget(voiceover.copy, input.targetDurationSec);

  // 标黄词必须逐字出现在最终口播稿中（用户改稿后同理），否则渲染端无法命中。
  const highlights = filterActiveHighlights(
    (Array.isArray(aiResponse.highlights) ? aiResponse.highlights : []).map((h) =>
      String(h).slice(0, 20),
    ),
    voiceover.copy,
  ).slice(0, 10);
  // 多形象（spec §6.4）：AI 的 speakerAssignments 逐句命中 voiceover 原文 → speakerByText。
  // 越界/非法 speakerIndex 丢弃并 warn（该组句子回落 0 号形象），绝不让脏下标进 segments。
  const personaCount = input.avatarPersonas?.length ?? 0;
  const speakerByText = new Map<string, number>();
  if (personaCount > 1 && Array.isArray(aiResponse.speakerAssignments)) {
    for (const assignment of aiResponse.speakerAssignments) {
      const idx = Number(assignment?.speakerIndex);
      if (!Number.isInteger(idx) || idx < 0 || idx >= personaCount) {
        console.warn(`[script-engine] speakerAssignments index ${String(assignment?.speakerIndex)} out of range (0..${personaCount - 1}); sentences fall back to speaker 0`);
        continue;
      }
      for (const sentence of Array.isArray(assignment.sentences) ? assignment.sentences : []) {
        const key = String(sentence).trim();
        if (key) speakerByText.set(key, idx);
      }
    }
  }
  const segments = deriveSegmentsFromVoiceover(voiceover.copy, {
    onCameraTexts: Array.isArray(aiResponse.onCameraSentences)
      ? aiResponse.onCameraSentences.map(String)
      : [],
    speakerByText,
  });

  return buildDraft({
    store: input.store,
    purpose: input.purpose,
    platform: input.platform ?? "douyin",
    generationMode: "ai",
    title: String(aiResponse.title || `${input.store.name}推荐`).slice(0, 30),
    hook: String(aiResponse.hook || voiceover.copy.slice(0, 15)),
    voiceover: voiceover.copy,
    highlights,
    segments,
    cta: String(aiResponse.cta || purposeCta[input.purpose]),
    warnings: voiceover.warnings,
    targetDurationSec: input.targetDurationSec,
    speakerAvatarIds: input.avatarPersonas?.map((p) => p.id),
  });
}

// ── Template fallback ──────────────────────────────────────────────────────

export function createTemplateScriptDraft(input: TemplateDraftInput): ScriptDraft {
  const warnings = [`AI unavailable, used template fallback: ${input.reason}`];
  const voiceover = buildTemplateVoiceover(input.store, input.purpose, input.targetDurationSec);
  const cleaned = sanitizeCopy(voiceover, input.store.forbiddenWords);
  const primaryProduct = input.store.mainProducts[0] ?? "招牌产品";

  return buildDraft({
    store: input.store,
    purpose: input.purpose,
    platform: "douyin",
    generationMode: "template_fallback",
    title: `${input.store.name}｜${primaryProduct}到店推荐`,
    hook: `今天推荐${input.store.name}的${primaryProduct}`,
    voiceover: cleaned.copy,
    highlights: storeFieldHighlights(input.store, cleaned.copy),
    segments: deriveSegmentsFromVoiceover(cleaned.copy),
    cta: purposeCta[input.purpose],
    warnings: [...warnings, ...cleaned.warnings],
    targetDurationSec: input.targetDurationSec,
    speakerAvatarIds: input.speakerAvatarIds,
  });
}

/** 模板口播：按档位拼装门店真实字段（产品/卖点/活动/客群），不虚构承诺。 */
function buildTemplateVoiceover(
  store: StoreProfile,
  purpose: MarketingPurpose,
  targetDurationSec?: number,
): string {
  const primaryProduct = store.mainProducts[0] ?? "招牌产品";
  const target = targetDurationSec ?? 30;
  const parts: string[] = [
    `${store.name}今天主推${primaryProduct}，${store.sellingPoints[0] ?? "门店现做现卖"}。`,
  ];
  if (target >= 45) {
    if (store.mainProducts[1]) parts.push(`除了${primaryProduct}，${store.mainProducts[1]}也值得一试。`);
    else if (store.sellingPoints[1]) parts.push(`${store.sellingPoints[1]}。`);
    else if (store.location) parts.push(`就在${store.location}，路过进来看看。`);
  }
  if (target >= 60) {
    if (store.promotions?.[0]) parts.push(`现在到店${store.promotions[0]}。`);
    if (store.targetCustomers[0]) parts.push(`特别适合${store.targetCustomers[0]}。`);
  }
  parts.push(`${purposeCta[purpose]}。`);
  return parts.join("");
}

// ── Shared builders ────────────────────────────────────────────────────────

function buildDraft(input: {
  store: StoreProfile;
  purpose: MarketingPurpose;
  platform: Platform;
  generationMode: "ai" | "template_fallback";
  title: string;
  hook: string;
  voiceover: string;
  highlights: string[];
  segments: ScriptSegment[];
  cta: string;
  warnings: string[];
  targetDurationSec?: number;
  speakerAvatarIds?: string[];
}): ScriptDraft {
  return {
    id: createId("script"),
    ownerId: input.store.ownerId,
    storeId: input.store.id,
    purpose: input.purpose,
    platform: input.platform,
    title: input.title,
    hook: input.hook,
    scenes: deriveScenesFromSegments(input.segments),
    voiceover: input.voiceover,
    highlights: input.highlights,
    segments: input.segments,
    speakerAvatarIds: input.speakerAvatarIds ?? [],
    captions: [input.voiceover],
    cta: input.cta,
    generationMode: input.generationMode,
    complianceWarnings: input.warnings,
    ...(input.targetDurationSec ? { targetDurationSec: input.targetDurationSec } : {}),
    createdAt: nowIso(),
  };
}

/** 模板/强制文案路径的标黄词：门店真实字段（产品/活动/卖点）命中口播稿的部分。 */
function storeFieldHighlights(store: StoreProfile, voiceover: string): string[] {
  return filterActiveHighlights(
    [...store.mainProducts, ...(store.promotions ?? []), ...store.sellingPoints],
    voiceover,
  );
}

/** AI 口播字数偏离目标档位（约 4.5 字/秒）>50% 时打警告日志（不重试，仅观测）。 */
export function warnIfVoiceoverOffTarget(voiceover: string, targetDurationSec?: number): void {
  if (!targetDurationSec) return;
  const chars = Array.from(voiceover).length;
  const expected = targetDurationSec * SPEECH_CHARS_PER_SECOND;
  if (Math.abs(chars - expected) > expected * 0.5) {
    console.warn(
      `[script-engine] voiceover ${chars} chars deviates >50% from target ${targetDurationSec}s (~${Math.round(expected)} chars)`,
    );
  }
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
