import { createId, nowIso } from "@/lib/ids";
import { hasAI, chatCompletionJSON, sanitizePromptField } from "@/lib/services/ai-client";
import {
  ALLOWED_MIME_PREFIXES,
  MAX_UPLOAD_BYTES,
  PRESIGN_EXPIRES_SECONDS,
  createPresignedPutUrl,
  isAllowedMimeType
} from "@/lib/storage";
import type { Asset, AssetAnalysis, MarketingPurpose, StoreProfile } from "@/lib/types";

interface UploadIntentInput {
  ownerId: string;
  storeId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
}

export interface UploadIntent {
  assetId: string;
  storageKey: string;
  uploadUrl: string;
  headers: Record<string, string>;
  maxSizeBytes: number;
  expiresInSeconds: number;
}

interface ClassifyAssetInput {
  asset: Asset;
  store: StoreProfile;
  visualLabels?: string[];
  transcript?: string;
  manualTags?: string[];
  analysisUnavailable?: boolean;
}

interface AIClassifyResponse {
  businessTags: string[];
  keywords: string[];
  recommendedUses: MarketingPurpose[];
  reasoning: string;
}

// ── AI prompts ──────────────────────────────────────────────────────────────

const CLASSIFY_SYSTEM_PROMPT = `你是为本地商家短视频素材打标签的内容分析助手。
根据门店信息、素材文件名、视觉标签和语音转写文本，推断素材的业务标签、关键词和推荐营销用途。

规则：
- businessTags: 2-4个中文业务标签，如"新品推荐"、"门店环境"、"促销活动"、"口碑推荐"、"招聘"等
- keywords: 3-6个与素材内容相关的中文关键词
- recommendedUses: 从以下用途中选择1-3个最合适的：
  store_traffic（引流到店）、new_product（新品推荐）、promotion（促销活动）、
  holiday（节日营销）、testimonial（口碑推荐）、recruiting（招聘）
- reasoning: 一句话解释你的判断依据`;

const CLASSIFY_SCHEMA = `{
  "businessTags": ["标签1", "标签2"],
  "keywords": ["关键词1", "关键词2"],
  "recommendedUses": ["new_product", "store_traffic"],
  "reasoning": "判断依据"
}`;

function buildClassifyUserPrompt(input: ClassifyAssetInput, visualTags: string[]): string {
  const store = input.store;
  const lines = [
    "【门店信息】",
    `店名：${sanitizePromptField(store.name, 100)}`,
    `行业：${sanitizePromptField(store.industry, 50)}`,
    `主推产品：${store.mainProducts.map((p) => sanitizePromptField(p, 60)).join("、")}`,
    `卖点：${store.sellingPoints.map((p) => sanitizePromptField(p, 80)).join("、")}`,
    `品牌调性：${sanitizePromptField(store.brandTone, 100)}`,
    `当前活动：${store.promotions?.map((p) => sanitizePromptField(p, 80)).join("、") || "无"}`,
    "",
    "【素材信息】",
    `文件名：${sanitizePromptField(input.asset.originalFilename, 150)}`,
    `媒体类型：${sanitizePromptField(input.asset.type, 30)}`,
    `视觉标签：${visualTags.map((t) => sanitizePromptField(t, 40)).join("、") || "无"}`,
    input.transcript ? `语音转写：${sanitizePromptField(input.transcript, 500)}` : null,
    input.manualTags?.length ? `手动标注：${input.manualTags.map((t) => sanitizePromptField(t, 40)).join("、")}` : null,
  ].filter(Boolean);
  return lines.join("\n");
}

const purposeByBusinessTag: Record<string, MarketingPurpose> = {
  门店环境: "store_traffic",
  招牌菜: "new_product",
  新品推荐: "new_product",
  促销: "promotion",
  口碑: "testimonial",
  招聘: "recruiting"
};

export { ALLOWED_MIME_PREFIXES, MAX_UPLOAD_BYTES };

/**
 * Thrown by createUploadIntent when input fails validation. These messages are
 * safe to echo to the client. Other errors (e.g. S3 presign failures) must NOT
 * be forwarded — routes branch on this type.
 */
export class UploadValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadValidationError";
  }
}

export async function createUploadIntent(input: UploadIntentInput): Promise<UploadIntent> {
  if (!isAllowedMimeType(input.contentType)) {
    throw new UploadValidationError(`Unsupported content type. Allowed: ${ALLOWED_MIME_PREFIXES.join(", ")}`);
  }

  if (input.sizeBytes <= 0 || input.sizeBytes > MAX_UPLOAD_BYTES) {
    throw new UploadValidationError(`File size must be between 1 and ${MAX_UPLOAD_BYTES} bytes`);
  }

  const assetId = createId("asset");
  // Sanitize filename: allow only alphanumeric, dots, dashes, underscores.
  // Prevent path traversal and reserved names.
  let safeName = input.filename
    .replace(/[\\/]/g, "-")               // directory separators → dash
    .replace(/\.{2,}/g, "")               // remove ".." path traversal
    .replace(/[^a-zA-Z0-9._-]/g, "-")     // everything else unsafe → dash
    .replace(/^-+/, "")                   // strip leading dashes
    .replace(/^\.+/, "")                  // strip leading dots (hidden files)
    .replace(/-{2,}/g, "-")              // collapse repeated dashes
    .toLowerCase()
    .slice(0, 128);                       // max filename length

  // Fallback if sanitization resulted in an empty name
  if (!safeName || safeName === ".ext") {
    safeName = "upload";
  }
  const storageKey = `stores/${input.storeId}/assets/${assetId}-${safeName}`;
  const uploadUrl = await createPresignedPutUrl(storageKey, input.contentType);

  return {
    assetId,
    storageKey,
    uploadUrl,
    headers: {
      "Content-Type": input.contentType
    },
    maxSizeBytes: MAX_UPLOAD_BYTES,
    expiresInSeconds: PRESIGN_EXPIRES_SECONDS
  };
}

export async function classifyAssetWithAI(
  input: ClassifyAssetInput,
  visualTags: string[],
): Promise<Pick<AssetAnalysis, "businessTags" | "keywords" | "recommendedUses">> {
  const userPrompt = buildClassifyUserPrompt(input, visualTags);
  const result = await chatCompletionJSON<AIClassifyResponse>(
    CLASSIFY_SYSTEM_PROMPT,
    userPrompt,
    { schemaDescription: CLASSIFY_SCHEMA, temperature: 0.3, maxTokens: 800 },
  );

  if (!result) {
    throw new Error("AI returned empty classification result");
  }

  const businessTags = unique([
    ...(input.manualTags ?? []),
    ...(Array.isArray(result.businessTags) ? result.businessTags.map(String) : []),
  ]);

  const transcriptKeywords = input.store.mainProducts.filter((product) =>
    `${input.transcript ?? ""} ${input.asset.originalFilename}`.includes(product),
  );
  const keywords = unique([
    ...transcriptKeywords,
    ...(Array.isArray(result.keywords) ? result.keywords.map(String) : []),
  ]);

  const validUses: MarketingPurpose[] = [
    "store_traffic", "new_product", "promotion", "holiday", "testimonial", "recruiting",
  ];
  const recommendedUses = unique(
    (Array.isArray(result.recommendedUses) ? result.recommendedUses : [])
      .map(String)
      .filter((u): u is MarketingPurpose => validUses.includes(u as MarketingPurpose)),
  );

  return {
    businessTags: businessTags.slice(0, 6),
    keywords: keywords.slice(0, 8),
    recommendedUses: recommendedUses.length > 0 ? recommendedUses : ["store_traffic"],
  };
}

export async function classifyAsset(input: ClassifyAssetInput): Promise<AssetAnalysis> {
  const visualTags = input.analysisUnavailable
    ? inferTagsFromFilename(input.asset.originalFilename)
    : unique([...(input.visualLabels ?? []), ...inferTagsFromFilename(input.asset.originalFilename)]);

  // ── Business tags, keywords, recommended uses ──
  let businessTags: string[];
  let keywords: string[];
  let recommendedUses: MarketingPurpose[];
  let analysisStatus: string;
  let aiFailed = false;

  if (!input.analysisUnavailable && hasAI()) {
    try {
      const aiResult = await classifyAssetWithAI(input, visualTags);
      businessTags = aiResult.businessTags;
      keywords = aiResult.keywords;
      recommendedUses = aiResult.recommendedUses;
      analysisStatus = "succeeded";
    } catch (error) {
      console.warn(
        `[assets] AI classification failed, falling back to rules: ${error instanceof Error ? error.message : String(error)}`,
      );
      aiFailed = true;
      const fallback = ruleBasedClassify(input, visualTags);
      businessTags = fallback.businessTags;
      keywords = fallback.keywords;
      recommendedUses = fallback.recommendedUses;
      analysisStatus = "failed";
    }
  } else {
    const fallback = ruleBasedClassify(input, visualTags);
    businessTags = fallback.businessTags;
    keywords = fallback.keywords;
    recommendedUses = fallback.recommendedUses;
    analysisStatus = "succeeded";
  }

  const confidence = aiFailed
    ? 0.3
    : input.analysisUnavailable
      ? 0.35
      : calculateConfidence(visualTags, keywords, businessTags);

  return {
    id: createId("analysis"),
    assetId: input.asset.id,
    visualTags,
    businessTags,
    transcript: input.transcript,
    keywords,
    confidence,
    recommendedUses: recommendedUses.length > 0 ? recommendedUses : ["store_traffic"],
    createdAt: nowIso(),
    analysisStatus
  };
}

function ruleBasedClassify(
  input: ClassifyAssetInput,
  visualTags: string[],
): Pick<AssetAnalysis, "businessTags" | "keywords" | "recommendedUses"> {
  const keywords = unique([
    ...extractBusinessKeywords(input.transcript ?? ""),
    ...input.store.mainProducts.filter((product) =>
      `${input.transcript ?? ""} ${input.asset.originalFilename}`.includes(product),
    ),
  ]);

  const businessTags = unique([
    ...(input.manualTags ?? []),
    ...inferBusinessTags({
      industry: input.store.industry,
      visualTags,
      transcript: input.transcript,
      filename: input.asset.originalFilename,
    }),
  ]);

  const recommendedUses = unique(
    businessTags.map((tag) => purposeByBusinessTag[tag]).filter(Boolean),
  ) as MarketingPurpose[];

  return { businessTags, keywords, recommendedUses };
}

function inferTagsFromFilename(filename: string): string[] {
  const lower = filename.toLowerCase();
  const tags: string[] = [];

  if (lower.includes("front") || lower.includes("store") || lower.includes("door")) tags.push("门店环境");
  if (lower.includes("cake") || lower.includes("croissant") || lower.includes("food")) tags.push("食物");
  if (lower.includes("promo") || lower.includes("sale")) tags.push("促销");
  if (lower.includes("fresh") || lower.includes("new")) tags.push("新品");

  return tags;
}

function inferBusinessTags(input: {
  industry: string;
  visualTags: string[];
  transcript?: string;
  filename: string;
}): string[] {
  const text = `${input.visualTags.join(" ")} ${input.transcript ?? ""} ${input.filename}`.toLowerCase();
  const tags: string[] = [];

  if (input.industry.includes("餐饮") || input.industry.includes("烘焙")) {
    if (text.includes("croissant") || text.includes("可颂") || text.includes("蛋糕") || text.includes("牛肉面")) {
      tags.push("新品推荐");
    }
    if (text.includes("门店") || text.includes("环境") || text.includes("store")) {
      tags.push("门店环境");
    }
    if (text.includes("套餐") || text.includes("促销") || text.includes("sale")) {
      tags.push("促销");
    }
  }

  return tags;
}

function extractBusinessKeywords(text: string): string[] {
  const candidates = ["牛肉面", "可颂", "蛋糕", "午餐", "下午茶", "出炉", "促销", "到店"];
  return candidates.filter((keyword) => text.includes(keyword));
}

function calculateConfidence(visualTags: string[], keywords: string[], businessTags: string[]): number {
  const score = 0.4 + visualTags.length * 0.1 + keywords.length * 0.08 + businessTags.length * 0.12;
  return Math.min(0.95, Number(score.toFixed(2)));
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
