export type AssetType = "video" | "image" | "audio";

export type AssetStatus = "uploading" | "uploaded" | "processing" | "ready" | "failed";

export type AvatarProviderName = "heygen" | "d-id" | "tavus" | "synthesia" | "mock-avatar";

export type AvatarTrainingStatus = "pending" | "processing" | "ready" | "failed";

export type AvatarFallbackMode = "template_avatar" | "tts_voiceover" | "broll_subtitles";

export type MarketingPurpose =
  | "store_traffic"
  | "new_product"
  | "promotion"
  | "holiday"
  | "testimonial"
  | "recruiting";

export type Platform = "douyin" | "wechat_channels" | "xiaohongshu" | "kuaishou";

export type AspectRatio = "9:16" | "1:1" | "16:9";

export type RenderStatus = "draft" | "queued" | "processing" | "ready" | "failed";

export type JobType =
  | "asset_analysis"
  | "avatar_generation"
  | "talking_head"
  | "video_render"
  | "subtitle_generation"
  | "quota_monthly_reset";

export type JobStatus = "queued" | "processing" | "completed" | "failed";

export interface StoreProfile {
  id: string;
  ownerId: string;
  name: string;
  industry: string;
  location?: string;
  mainProducts: string[];
  averageOrderValue?: number;
  targetCustomers: string[];
  sellingPoints: string[];
  promotions?: string[];
  brandTone: string;
  forbiddenWords: string[];
  contactPhone?: string;
  logoAssetId?: string;
  storefrontAssetId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Asset {
  id: string;
  ownerId: string;
  storeId: string;
  type: AssetType;
  originalFilename: string;
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  durationSeconds?: number;
  width?: number;
  height?: number;
  thumbnailStorageKey?: string;
  proxyStorageKey?: string;
  tags: string[];
  businessTags: string[];
  status: AssetStatus;
  createdAt: string;
}

export interface AssetAnalysis {
  id: string;
  assetId: string;
  visualTags: string[];
  businessTags: string[];
  transcript?: string;
  keywords: string[];
  confidence: number;
  recommendedUses: MarketingPurpose[];
  createdAt: string;
  analysisStatus: string;
}

export interface AvatarProfile {
  id: string;
  ownerId: string;
  storeId: string;
  provider: AvatarProviderName;
  providerAvatarId?: string;
  providerVoiceId?: string;
  consentAcceptedAt: string;
  trainingStatus: AvatarTrainingStatus;
  fallbackMode: AvatarFallbackMode;
  createdAt: string;
  updatedAt: string;
}

export type SceneRole = "presenter" | "broll";

export interface ScriptScene {
  order: number;
  text: string;
  durationSeconds: number;
  assetHints: string[];
  role: SceneRole;
  /** 匹配器派生：该镜期望的素材标签/关键词（默认取 assetHints） */
  desiredTags?: string[];
  /** 自动匹配命中的素材 id；null = 待匹配（用户手选） */
  matchedAssetId?: string | null;
  /** 命中依据标签，便于 UI 展示 */
  matchTag?: string | null;
}

export interface ScriptSegment {
  /** 句序号（0 起，按口播稿句序）。 */
  index: number;
  /** 该句口播原文。 */
  text: string;
  /** 说话形象下标（Phase 2 恒 0；Phase 3 多形象轮播使用）。 */
  speakerIndex: number;
  /** 是否真人出镜段（Phase 2 渲染忽略；Phase 3 分段生成使用）。 */
  onCamera: boolean;
}

export interface ScriptDraft {
  id: string;
  ownerId: string;
  storeId: string;
  purpose: MarketingPurpose;
  platform: Platform;
  title: string;
  hook: string;
  scenes: ScriptScene[];
  voiceover: string;
  captions: string[];
  cta: string;
  generationMode: "ai" | "template_fallback";
  complianceWarnings: string[];
  /** 目标成片时长（秒）：30 / 45 / 60。 */
  targetDurationSec?: number;
  /** 标黄关键词（AI 产出；用户改稿后文中不存在的词由服务端过滤失效）。 */
  highlights?: string[];
  /** 口播按句分段（服务端从 voiceover 派生/重切）。 */
  segments?: ScriptSegment[];
  createdAt: string;
}

export interface RenderProject {
  id: string;
  ownerId: string;
  storeId: string;
  scriptDraftId: string;
  selectedAssetIds: string[];
  avatarProfileId?: string;
  purpose: MarketingPurpose;
  aspectRatio: AspectRatio;
  subtitleStyle: "default" | "bold_bottom" | "minimal";
  bgmTrackId?: string;
  /** 继承自 ScriptDraft：目标成片时长（秒）。 */
  targetDurationSec?: number;
  status: RenderStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Job {
  id: string;
  ownerId: string;
  projectId?: string;
  type: JobType;
  status: JobStatus;
  progress: number;
  payload: Record<string, unknown>;
  dependsOnJobIds: string[];
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export type VideoOutputKind = "talking_head" | "final_composite" | "slideshow";

export interface VideoOutput {
  id: string;
  ownerId: string;
  renderProjectId: string | null;
  storageKey: string;
  coverStorageKey?: string;
  aspectRatio: AspectRatio;
  durationSeconds: number;
  kind: VideoOutputKind;
  status: RenderStatus;
  createdAt: string;
}

export interface BgmTrack {
  id: string;
  name: string;
  storageKey: string;
  durationSeconds: number;
  category: string;
  createdAt: string;
}

// ── Auth session extensions ──────────────────────────────────────────────────

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      jti?: string;
      name?: string | null;
      email?: string | null;
      image?: string | null;
    };
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    jti?: string;
  }
}
