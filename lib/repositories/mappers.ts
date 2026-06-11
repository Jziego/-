import type {
  Asset,
  AssetAnalysis,
  AvatarProfile,
  Job,
  MarketingPurpose,
  RenderProject,
  ScriptDraft,
  ScriptScene,
  StoreProfile,
  VideoOutput
} from "@/lib/types";
import type {
  Asset as PrismaAsset,
  AssetAnalysis as PrismaAssetAnalysis,
  AvatarProfile as PrismaAvatarProfile,
  Job as PrismaJob,
  RenderProject as PrismaRenderProject,
  ScriptDraft as PrismaScriptDraft,
  StoreProfile as PrismaStoreProfile,
  VideoOutput as PrismaVideoOutput
} from "@prisma/client";

export function toStoreProfile(row: PrismaStoreProfile): StoreProfile {
  return {
    id: row.id,
    ownerId: row.ownerId,
    name: row.name,
    industry: row.industry,
    location: row.location ?? undefined,
    mainProducts: row.mainProducts,
    averageOrderValue: row.averageOrderValue ?? undefined,
    targetCustomers: row.targetCustomers,
    sellingPoints: row.sellingPoints,
    promotions: row.promotions ?? [],
    brandTone: row.brandTone,
    forbiddenWords: row.forbiddenWords,
    contactPhone: row.contactPhone ?? undefined,
    logoAssetId: row.logoAssetId ?? undefined,
    storefrontAssetId: row.storefrontAssetId ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

export function toStoreProfileInput(profile: StoreProfile) {
  return {
    id: profile.id,
    ownerId: profile.ownerId,
    name: profile.name,
    industry: profile.industry,
    location: profile.location ?? null,
    mainProducts: profile.mainProducts,
    averageOrderValue: profile.averageOrderValue ?? null,
    targetCustomers: profile.targetCustomers,
    sellingPoints: profile.sellingPoints,
    promotions: profile.promotions ?? [],
    brandTone: profile.brandTone,
    forbiddenWords: profile.forbiddenWords,
    contactPhone: profile.contactPhone ?? null,
    logoAssetId: profile.logoAssetId ?? null,
    storefrontAssetId: profile.storefrontAssetId ?? null,
    createdAt: new Date(profile.createdAt),
    updatedAt: new Date(profile.updatedAt)
  };
}

export function toAsset(row: PrismaAsset): Asset {
  return {
    id: row.id,
    ownerId: row.ownerId,
    storeId: row.storeId,
    type: row.type as Asset["type"],
    originalFilename: row.originalFilename,
    storageKey: row.storageKey,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    durationSeconds: row.durationSeconds ?? undefined,
    width: row.width ?? undefined,
    height: row.height ?? undefined,
    thumbnailStorageKey: row.thumbnailStorageKey ?? undefined,
    proxyStorageKey: row.proxyStorageKey ?? undefined,
    tags: row.tags,
    businessTags: row.businessTags,
    status: row.status as Asset["status"],
    createdAt: row.createdAt.toISOString()
  };
}

export function toAssetInput(asset: Asset) {
  return {
    id: asset.id,
    ownerId: asset.ownerId,
    storeId: asset.storeId,
    type: asset.type,
    originalFilename: asset.originalFilename,
    storageKey: asset.storageKey,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
    durationSeconds: asset.durationSeconds ?? null,
    width: asset.width ?? null,
    height: asset.height ?? null,
    thumbnailStorageKey: asset.thumbnailStorageKey ?? null,
    proxyStorageKey: asset.proxyStorageKey ?? null,
    tags: asset.tags,
    businessTags: asset.businessTags,
    status: asset.status,
    createdAt: new Date(asset.createdAt)
  };
}

export function toAssetAnalysis(row: PrismaAssetAnalysis): AssetAnalysis {
  return {
    id: row.id,
    assetId: row.assetId,
    visualTags: row.visualTags,
    businessTags: row.businessTags,
    transcript: row.transcript ?? undefined,
    keywords: row.keywords,
    confidence: row.confidence,
    recommendedUses: row.recommendedUses as MarketingPurpose[],
    createdAt: row.createdAt.toISOString()
  };
}

export function toAssetAnalysisInput(analysis: AssetAnalysis) {
  return {
    id: analysis.id,
    assetId: analysis.assetId,
    visualTags: analysis.visualTags,
    businessTags: analysis.businessTags,
    transcript: analysis.transcript ?? null,
    keywords: analysis.keywords,
    confidence: analysis.confidence,
    recommendedUses: analysis.recommendedUses,
    createdAt: new Date(analysis.createdAt)
  };
}

export function toAvatarProfile(row: PrismaAvatarProfile): AvatarProfile {
  return {
    id: row.id,
    ownerId: row.ownerId,
    storeId: row.storeId,
    provider: row.provider as AvatarProfile["provider"],
    providerAvatarId: row.providerAvatarId ?? undefined,
    providerVoiceId: row.providerVoiceId ?? undefined,
    consentAcceptedAt: row.consentAcceptedAt.toISOString(),
    trainingStatus: row.trainingStatus as AvatarProfile["trainingStatus"],
    fallbackMode: row.fallbackMode as AvatarProfile["fallbackMode"],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

export function toAvatarProfileInput(avatar: AvatarProfile) {
  return {
    id: avatar.id,
    ownerId: avatar.ownerId,
    storeId: avatar.storeId,
    provider: avatar.provider,
    providerAvatarId: avatar.providerAvatarId ?? null,
    providerVoiceId: avatar.providerVoiceId ?? null,
    consentAcceptedAt: new Date(avatar.consentAcceptedAt),
    trainingStatus: avatar.trainingStatus,
    fallbackMode: avatar.fallbackMode,
    createdAt: new Date(avatar.createdAt),
    updatedAt: new Date(avatar.updatedAt)
  };
}

export function toScriptDraft(row: PrismaScriptDraft): ScriptDraft {
  return {
    id: row.id,
    ownerId: row.ownerId,
    storeId: row.storeId,
    purpose: row.purpose as ScriptDraft["purpose"],
    platform: row.platform as ScriptDraft["platform"],
    title: row.title,
    hook: row.hook,
    scenes: row.scenes as unknown as ScriptScene[],
    voiceover: row.voiceover,
    captions: row.captions,
    cta: row.cta,
    generationMode: row.generationMode as ScriptDraft["generationMode"],
    complianceWarnings: row.complianceWarnings,
    createdAt: row.createdAt.toISOString()
  };
}

export function toScriptDraftInput(script: ScriptDraft) {
  return {
    id: script.id,
    ownerId: script.ownerId,
    storeId: script.storeId,
    purpose: script.purpose,
    platform: script.platform,
    title: script.title,
    hook: script.hook,
    scenes: script.scenes as object,
    voiceover: script.voiceover,
    captions: script.captions,
    cta: script.cta,
    generationMode: script.generationMode,
    complianceWarnings: script.complianceWarnings,
    createdAt: new Date(script.createdAt)
  };
}

export function toRenderProject(row: PrismaRenderProject): RenderProject {
  return {
    id: row.id,
    ownerId: row.ownerId,
    storeId: row.storeId,
    scriptDraftId: row.scriptDraftId,
    selectedAssetIds: row.selectedAssetIds,
    avatarProfileId: row.avatarProfileId ?? undefined,
    purpose: row.purpose as RenderProject["purpose"],
    aspectRatio: row.aspectRatio as RenderProject["aspectRatio"],
    subtitleStyle: row.subtitleStyle as RenderProject["subtitleStyle"],
    bgmTrackId: row.bgmTrackId ?? undefined,
    status: row.status as RenderProject["status"],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

export function toRenderProjectInput(project: RenderProject) {
  return {
    id: project.id,
    ownerId: project.ownerId,
    storeId: project.storeId,
    scriptDraftId: project.scriptDraftId,
    selectedAssetIds: project.selectedAssetIds,
    avatarProfileId: project.avatarProfileId ?? null,
    purpose: project.purpose,
    aspectRatio: project.aspectRatio,
    subtitleStyle: project.subtitleStyle,
    bgmTrackId: project.bgmTrackId ?? null,
    status: project.status,
    createdAt: new Date(project.createdAt),
    updatedAt: new Date(project.updatedAt)
  };
}

export function toJob(row: PrismaJob): Job {
  return {
    id: row.id,
    ownerId: row.ownerId,
    projectId: row.projectId ?? undefined,
    type: row.type as Job["type"],
    status: row.status as Job["status"],
    progress: row.progress,
    payload: row.payload as Record<string, unknown>,
    dependsOnJobIds: row.dependsOnJobIds,
    error: row.error ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

export function toJobInput(job: Job) {
  return {
    id: job.id,
    ownerId: job.ownerId,
    projectId: job.projectId ?? null,
    type: job.type,
    status: job.status,
    progress: job.progress,
    payload: job.payload as object,
    dependsOnJobIds: job.dependsOnJobIds,
    error: job.error ?? null,
    createdAt: new Date(job.createdAt),
    updatedAt: new Date(job.updatedAt)
  };
}

export function toVideoOutputInput(output: VideoOutput) {
  return {
    id: output.id,
    ownerId: output.ownerId,
    renderProjectId: output.renderProjectId,
    storageKey: output.storageKey,
    coverStorageKey: output.coverStorageKey ?? null,
    aspectRatio: output.aspectRatio,
    durationSeconds: output.durationSeconds,
    status: output.status,
    createdAt: new Date(output.createdAt)
  };
}

export function toVideoOutput(row: PrismaVideoOutput): VideoOutput {
  return {
    id: row.id,
    ownerId: row.ownerId,
    renderProjectId: row.renderProjectId,
    storageKey: row.storageKey,
    coverStorageKey: row.coverStorageKey ?? undefined,
    aspectRatio: row.aspectRatio as VideoOutput["aspectRatio"],
    durationSeconds: row.durationSeconds,
    status: row.status as VideoOutput["status"],
    createdAt: row.createdAt.toISOString()
  };
}
