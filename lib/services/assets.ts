import { createId, nowIso } from "@/lib/ids";
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

const purposeByBusinessTag: Record<string, MarketingPurpose> = {
  门店环境: "store_traffic",
  招牌菜: "new_product",
  新品推荐: "new_product",
  促销: "promotion",
  口碑: "testimonial",
  招聘: "recruiting"
};

export { ALLOWED_MIME_PREFIXES, MAX_UPLOAD_BYTES };

export async function createUploadIntent(input: UploadIntentInput): Promise<UploadIntent> {
  if (!isAllowedMimeType(input.contentType)) {
    throw new Error(`Unsupported content type. Allowed: ${ALLOWED_MIME_PREFIXES.join(", ")}`);
  }

  if (input.sizeBytes <= 0 || input.sizeBytes > MAX_UPLOAD_BYTES) {
    throw new Error(`File size must be between 1 and ${MAX_UPLOAD_BYTES} bytes`);
  }

  const assetId = createId("asset");
  const safeName = input.filename.replace(/[^a-zA-Z0-9._-]/g, "-").toLowerCase();
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

export async function classifyAsset(input: ClassifyAssetInput): Promise<AssetAnalysis> {
  const visualTags = input.analysisUnavailable
    ? inferTagsFromFilename(input.asset.originalFilename)
    : unique([...(input.visualLabels ?? []), ...inferTagsFromFilename(input.asset.originalFilename)]);

  const keywords = unique([
    ...extractBusinessKeywords(input.transcript ?? ""),
    ...input.store.mainProducts.filter((product) =>
      `${input.transcript ?? ""} ${input.asset.originalFilename}`.includes(product)
    )
  ]);

  const businessTags = unique([
    ...(input.manualTags ?? []),
    ...inferBusinessTags({
      industry: input.store.industry,
      visualTags,
      transcript: input.transcript,
      filename: input.asset.originalFilename
    })
  ]);

  const recommendedUses = unique(
    businessTags.map((tag) => purposeByBusinessTag[tag]).filter(Boolean)
  ) as MarketingPurpose[];

  return {
    id: createId("analysis"),
    assetId: input.asset.id,
    visualTags,
    businessTags,
    transcript: input.transcript,
    keywords,
    confidence: input.analysisUnavailable ? 0.35 : calculateConfidence(visualTags, keywords, businessTags),
    recommendedUses: recommendedUses.length > 0 ? recommendedUses : ["store_traffic"],
    createdAt: nowIso()
  };
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
