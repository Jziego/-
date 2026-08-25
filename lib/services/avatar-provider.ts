import { createId, nowIso } from "@/lib/ids";
import type { AvatarConsentStatus, AvatarProfile, AvatarProviderName, AvatarTrainingStatus } from "@/lib/types";
import { createMockProvider } from "@/lib/services/providers/mock";

export interface WordTimestamp {
  word: string;
  startSec: number;
  endSec: number;
}

/** 归一化后的分身状态（provider 内部形状差异收敛于此）。 */
export interface DigitalTwinStatus {
  consentStatus: AvatarConsentStatus;
  trainingStatus: AvatarTrainingStatus;
  /** trainingStatus="ready" 时给出：HeyGen look_id 与克隆声音 id。 */
  providerAvatarId?: string;
  providerVoiceId?: string;
  /** 拒绝/失败原因（UI 展示用，provider 原文）。 */
  reason?: string;
  /** 仍在 awaiting_user 时带回（可能已轮换的）授权链接，供前端重新打开。 */
  consentUrl?: string;
}

export interface AvatarProvider {
  name: AvatarProviderName;
  createAvatar(input: { trainingVideoAssetId: string; ownerId: string }): Promise<{
    providerAvatarId: string;
    providerVoiceId?: string;
  }>;
  generateTalkingHead(
    input: {
      providerAvatarId: string;
      providerVoiceId?: string;
      scriptText: string;
    },
    onProgress?: (attempt: number, maxAttempts: number) => void,
  ): Promise<{
    videoAssetId: string;
    durationSeconds: number;
  }>;
  /** 创建数字分身（digital_twin），返回 group 句柄 + webcam 授权链接（24h 有效）。 */
  createDigitalTwin(input: { name: string; footageUrl: string }): Promise<{ groupId: string; consentUrl: string }>;
  /** 授权链接过期/被拒后重发。 */
  refreshConsent(input: { groupId: string }): Promise<{ consentUrl: string }>;
  /** 轮询授权 + 训练状态。 */
  getDigitalTwinStatus(input: { groupId: string }): Promise<DigitalTwinStatus>;
  /** 克隆声音 TTS；音频持久化到 R2 后返回 storageKey + 词级时间轴。 */
  synthesizeSpeech(input: { providerVoiceId: string; text: string }): Promise<{
    audioStorageKey: string;
    durationSeconds: number;
    words: WordTimestamp[];
  }>;
}

interface MockProviderOptions {
  avatarId?: string;
  voiceId?: string;
  failTalkingHead?: boolean;
}

/** @deprecated 兼容旧调用方；新代码请直接用 providers/mock 的 createMockProvider。 */
export function createMockAvatarProvider(options: MockProviderOptions = {}): AvatarProvider {
  return createMockProvider(options);
}

export async function createAvatarProfile(input: {
  ownerId: string;
  storeId: string;
  provider: AvatarProvider;
  trainingVideoAssetId: string;
  consentAccepted: boolean;
}): Promise<AvatarProfile> {
  if (!input.consentAccepted) {
    throw new Error("创建数字人前必须确认肖像和声音授权");
  }

  const providerAvatar = await input.provider.createAvatar({
    trainingVideoAssetId: input.trainingVideoAssetId,
    ownerId: input.ownerId
  });
  const now = nowIso();

  return {
    id: createId("avatar"),
    ownerId: input.ownerId,
    storeId: input.storeId,
    name: "",
    provider: input.provider.name,
    providerAvatarId: providerAvatar.providerAvatarId,
    providerVoiceId: providerAvatar.providerVoiceId,
    consentStatus: "approved",
    consentAcceptedAt: now,
    trainingStatus: "processing",
    fallbackMode: "tts_voiceover",
    createdAt: now,
    updatedAt: now
  };
}

export async function requestAvatarTalkingHead(input: {
  provider: AvatarProvider;
  avatarProfileId: string;
  providerAvatarId: string;
  providerVoiceId?: string;
  scriptText: string;
  onProgress?: (attempt: number, maxAttempts: number) => void;
}): Promise<{
  mode: "talking_head";
  avatarProfileId: string;
  videoAssetId: string;
  durationSeconds: number;
}> {
  const result = await input.provider.generateTalkingHead(
    {
      providerAvatarId: input.providerAvatarId,
      providerVoiceId: input.providerVoiceId,
      scriptText: input.scriptText
    },
    input.onProgress
  );

  return {
    mode: "talking_head",
    avatarProfileId: input.avatarProfileId,
    videoAssetId: result.videoAssetId,
    durationSeconds: result.durationSeconds
  };
}

/**
 * Phase 3 形象创建（spec §6.2）：调真 provider 创建 digital_twin 并取 webcam
 * 授权链接，返回待持久化的 AvatarProfile（consentStatus=awaiting_user）。
 * 授权通过且训练完成后由 status 轮询端点写入 providerAvatarId/providerVoiceId。
 */
export async function createDigitalTwinProfile(input: {
  ownerId: string;
  storeId: string;
  name: string;
  footageAssetId: string;
  footageUrl: string;
  consentAccepted: boolean;
  provider: AvatarProvider;
}): Promise<{ profile: AvatarProfile; consentUrl: string }> {
  if (!input.consentAccepted) {
    throw new Error("创建数字人前必须确认肖像和声音授权");
  }
  const { groupId, consentUrl } = await input.provider.createDigitalTwin({
    name: input.name,
    footageUrl: input.footageUrl,
  });
  const now = nowIso();
  return {
    profile: {
      id: createId("avatar"),
      ownerId: input.ownerId,
      storeId: input.storeId,
      name: input.name,
      provider: input.provider.name,
      providerGroupId: groupId,
      consentStatus: "awaiting_user",
      trainingVideoAssetId: input.footageAssetId,
      consentAcceptedAt: now,
      trainingStatus: "pending",
      fallbackMode: "tts_voiceover",
      createdAt: now,
      updatedAt: now,
    },
    consentUrl,
  };
}

/** consent 状态机（spec §6.2/§6.5）：provider 状态 → profile 持久化增量。 */
export function applyDigitalTwinStatus(
  status: DigitalTwinStatus,
): Partial<AvatarProfile> {
  const patch: Partial<AvatarProfile> = {
    consentStatus: status.consentStatus,
    updatedAt: nowIso(),
  };
  if (status.consentStatus === "rejected" || status.consentStatus === "expired") {
    patch.trainingStatus = "failed";
    patch.statusReason = status.reason ?? (status.consentStatus === "expired" ? "授权链接已过期" : "授权被拒绝");
    return patch;
  }
  if (status.trainingStatus === "failed") {
    patch.trainingStatus = "failed";
    patch.statusReason = status.reason ?? "分身训练失败";
    return patch;
  }
  if (status.consentStatus === "approved" && status.trainingStatus === "ready") {
    patch.trainingStatus = "ready";
    patch.providerAvatarId = status.providerAvatarId;
    patch.providerVoiceId = status.providerVoiceId;
    patch.statusReason = undefined;
    return patch;
  }
  // 授权未完成前训练不会开始（HeyGen 此时回报 pending）——保持 pending，
  // 否则形象会在「等用户点授权链接」阶段误显示为训练中。
  if (status.consentStatus === "awaiting_user") {
    patch.trainingStatus = "pending";
    return patch;
  }
  // approved + 训练途中
  patch.trainingStatus = status.trainingStatus === "ready" ? "ready" : "processing";
  return patch;
}

export { createProviderFromEnv } from "./providers";
