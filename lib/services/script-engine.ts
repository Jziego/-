import { createId, nowIso } from "@/lib/ids";
import type { AssetAnalysis, MarketingPurpose, Platform, ScriptDraft, StoreProfile } from "@/lib/types";

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

const purposeCta: Record<MarketingPurpose, string> = {
  store_traffic: "现在到店，直接报视频里的活动",
  new_product: "到店试试今天主推新品",
  promotion: "到店领取本期优惠",
  holiday: "节日期间到店体验限定活动",
  testimonial: "欢迎到店体验大家都在夸的招牌",
  recruiting: "欢迎来店咨询岗位"
};

export async function createScriptDraft(input: ScriptDraftInput): Promise<ScriptDraft> {
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
      warnings: cleaned.warnings
    });
  }

  const primaryProduct = input.store.mainProducts[0] ?? "招牌产品";
  const topTags = collectAssetHints(input.assetAnalyses);
  const hook = `路过${input.store.location ?? "附近"}，别错过这份${primaryProduct}`;
  const voiceover = `${input.store.name}主打${primaryProduct}，${input.store.sellingPoints.join("，")}。${purposeCta[input.purpose]}。`;
  const cleaned = sanitizeCopy(voiceover, input.store.forbiddenWords);

  return buildDraft({
    store: input.store,
    assetAnalyses: input.assetAnalyses,
    purpose: input.purpose,
    platform: input.platform ?? "douyin",
    generationMode: "ai",
    title: `${input.store.name}｜${primaryProduct}到店推荐`,
    hook: topTags.includes("招牌菜") ? `${primaryProduct}热气上桌，附近上班族可以冲` : hook,
    voiceover: cleaned.copy,
    warnings: cleaned.warnings
  });
}

export function createTemplateScriptDraft(input: TemplateDraftInput): ScriptDraft {
  const primaryProduct = input.store.mainProducts[0] ?? "招牌产品";
  const warnings = [`AI unavailable, used template fallback: ${input.reason}`];

  return buildDraft({
    store: input.store,
    assetAnalyses: input.assetAnalyses,
    purpose: input.purpose,
    platform: "douyin",
    generationMode: "template_fallback",
    title: `${primaryProduct}上新，到店尝鲜`,
    hook: `今天推荐${input.store.name}的${primaryProduct}`,
    voiceover: `${input.store.name}今天主推${primaryProduct}，${input.store.sellingPoints[0] ?? "门店现做现卖"}。${purposeCta[input.purpose]}。`,
    warnings
  });
}

function buildDraft(input: {
  store: StoreProfile;
  assetAnalyses: AssetAnalysis[];
  purpose: MarketingPurpose;
  platform: Platform;
  generationMode: "ai" | "template_fallback";
  title: string;
  hook: string;
  voiceover: string;
  warnings: string[];
}): ScriptDraft {
  const hints = collectAssetHints(input.assetAnalyses);
  const primaryProduct = input.store.mainProducts[0] ?? "招牌产品";

  return {
    id: createId("script"),
    ownerId: input.store.ownerId,
    storeId: input.store.id,
    purpose: input.purpose,
    platform: input.platform,
    title: input.title,
    hook: input.hook,
    scenes: [
      {
        order: 1,
        text: `开场展示${input.store.name}门店或招牌`,
        durationSeconds: 4,
        assetHints: hints.length ? hints : ["门店环境"]
      },
      {
        order: 2,
        text: `展示${primaryProduct}和制作/服务过程`,
        durationSeconds: 7,
        assetHints: [primaryProduct, ...hints].slice(0, 3)
      },
      {
        order: 3,
        text: `展示优惠、地址或到店 CTA`,
        durationSeconds: 4,
        assetHints: ["促销", "到店引流"]
      }
    ],
    voiceover: input.voiceover,
    captions: [input.hook, input.voiceover, purposeCta[input.purpose]],
    cta: purposeCta[input.purpose],
    generationMode: input.generationMode,
    complianceWarnings: input.warnings,
    createdAt: nowIso()
  };
}

function collectAssetHints(assetAnalyses: AssetAnalysis[]): string[] {
  return [
    ...new Set(
      assetAnalyses.flatMap((analysis) => [
        ...analysis.businessTags,
        ...analysis.visualTags,
        ...analysis.keywords
      ])
    )
  ].slice(0, 6);
}

function sanitizeCopy(copy: string, forbiddenWords: string[]): { copy: string; warnings: string[] } {
  const removed = forbiddenWords.filter((word) => copy.includes(word));
  let cleaned = copy;

  for (const word of removed) {
    cleaned = cleaned.replaceAll(word, "");
  }

  return {
    copy: cleaned.replace(/\s+/g, " ").trim(),
    warnings: removed.length ? [`Removed forbidden words: ${removed.join(", ")}`] : []
  };
}
