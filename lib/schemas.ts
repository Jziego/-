import { z } from "zod";

const isoDateString = z.string().datetime();

export const marketingPurposeSchema = z.enum([
  "store_traffic",
  "new_product",
  "promotion",
  "holiday",
  "testimonial",
  "recruiting"
]);

export const platformSchema = z.enum(["douyin", "wechat_channels", "xiaohongshu", "kuaishou"]);

export const storeProfileSchema = z.object({
  id: z.string().min(1),
  ownerId: z.string().min(1),
  name: z.string().min(1, "请填写门店名称"),
  industry: z.string().min(1, "请选择行业"),
  location: z.string().optional(),
  mainProducts: z.array(z.string().min(1)).min(1, "至少填写一个主营产品"),
  averageOrderValue: z.number().positive().optional(),
  targetCustomers: z.array(z.string().min(1)).min(1, "至少填写一个目标顾客"),
  sellingPoints: z.array(z.string().min(1)).min(1, "至少填写一个卖点"),
  promotions: z.array(z.string().min(1)).default([]),
  brandTone: z.string().min(1).default("亲切接地气"),
  forbiddenWords: z.array(z.string().min(1)).default([]),
  contactPhone: z.string().optional(),
  logoAssetId: z.string().optional(),
  storefrontAssetId: z.string().optional(),
  createdAt: isoDateString,
  updatedAt: isoDateString
});

export const confirmAssetUploadSchema = z.object({
  assetId: z.string().min(1),
  storeId: z.string().min(1),
  ownerId: z.string().min(1).optional(),
  storageKey: z.string().min(1),
  originalFilename: z.string().min(1),
  mimeType: z.string().min(1),
  type: z.enum(["video", "image", "audio"]),
  sizeBytes: z.number().positive().optional()
});

export const assetSchema = z.object({
  id: z.string().min(1),
  ownerId: z.string().min(1),
  storeId: z.string().min(1),
  type: z.enum(["video", "image", "audio"]),
  originalFilename: z.string().min(1),
  storageKey: z.string().min(1),
  mimeType: z.string().min(1),
  sizeBytes: z.number().positive(),
  durationSeconds: z.number().positive().optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  thumbnailStorageKey: z.string().optional(),
  proxyStorageKey: z.string().optional(),
  tags: z.array(z.string()).default([]),
  businessTags: z.array(z.string()).default([]),
  status: z.enum(["uploading", "uploaded", "processing", "ready", "failed"]),
  createdAt: isoDateString
});

export const assetAnalysisSchema = z.object({
  id: z.string().min(1),
  assetId: z.string().min(1),
  visualTags: z.array(z.string()).default([]),
  businessTags: z.array(z.string()).default([]),
  transcript: z.string().optional(),
  keywords: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
  recommendedUses: z.array(marketingPurposeSchema).default([]),
  createdAt: isoDateString
});

export const avatarProfileSchema = z.object({
  id: z.string().min(1),
  ownerId: z.string().min(1),
  storeId: z.string().min(1),
  provider: z.enum(["heygen", "d-id", "tavus", "synthesia", "mock-avatar"]),
  providerAvatarId: z.string().optional(),
  providerVoiceId: z.string().optional(),
  consentAcceptedAt: isoDateString,
  trainingStatus: z.enum(["pending", "processing", "ready", "failed"]),
  fallbackMode: z.enum(["template_avatar", "tts_voiceover", "broll_subtitles"]),
  createdAt: isoDateString,
  updatedAt: isoDateString
});

export const scriptSceneSchema = z.object({
  order: z.number().int().positive(),
  text: z.string().min(1),
  durationSeconds: z.number().positive(),
  assetHints: z.array(z.string()).default([])
});

export const scriptDraftSchema = z.object({
  id: z.string().min(1),
  ownerId: z.string().min(1),
  storeId: z.string().min(1),
  purpose: marketingPurposeSchema,
  platform: platformSchema,
  title: z.string().min(1),
  hook: z.string().min(1),
  scenes: z.array(scriptSceneSchema).min(1),
  voiceover: z.string().min(1),
  captions: z.array(z.string()).min(1),
  cta: z.string().min(1),
  generationMode: z.enum(["ai", "template_fallback"]),
  complianceWarnings: z.array(z.string()).default([]),
  createdAt: isoDateString
});

export const renderProjectSchema = z.object({
  id: z.string().min(1),
  ownerId: z.string().min(1),
  storeId: z.string().min(1),
  scriptDraftId: z.string().min(1),
  selectedAssetIds: z.array(z.string().min(1)).min(1),
  avatarProfileId: z.string().optional(),
  purpose: marketingPurposeSchema,
  aspectRatio: z.enum(["9:16", "1:1", "16:9"]),
  subtitleStyle: z.enum(["default", "bold_bottom", "minimal"]),
  bgmTrackId: z.string().optional(),
  status: z.enum(["draft", "queued", "processing", "ready", "failed"]),
  createdAt: isoDateString,
  updatedAt: isoDateString
});

export const jobSchema = z.object({
  id: z.string().min(1),
  ownerId: z.string().min(1),
  projectId: z.string().optional(),
  type: z.enum(["asset_analysis", "avatar_generation", "talking_head", "video_render", "subtitle_generation"]),
  status: z.enum(["queued", "processing", "completed", "failed"]),
  progress: z.number().min(0).max(100),
  payload: z.record(z.string(), z.unknown()),
  dependsOnJobIds: z.array(z.string()).default([]),
  error: z.string().optional(),
  createdAt: isoDateString,
  updatedAt: isoDateString
});

export const videoOutputSchema = z.object({
  id: z.string().min(1),
  ownerId: z.string().min(1),
  renderProjectId: z.string().min(1),
  storageKey: z.string().min(1),
  coverStorageKey: z.string().optional(),
  aspectRatio: z.enum(["9:16", "1:1", "16:9"]),
  durationSeconds: z.number().positive(),
  status: z.enum(["draft", "queued", "processing", "ready", "failed"]),
  createdAt: isoDateString
});

export type StoreProfileInput = z.infer<typeof storeProfileSchema>;
