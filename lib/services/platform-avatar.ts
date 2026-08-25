import { getHeygenAvatarTemplateId, getHeygenVoiceId } from "@/lib/env";
import { nowIso } from "@/lib/ids";
import type { AvatarProfile } from "@/lib/types";

/**
 * 平台公共形象（spec §6.3）：env 模板（HEYGEN_AVATAR_TEMPLATE_ID/HEYGEN_VOICE_ID）
 * 合成出的虚拟 AvatarProfile，只在用户没有任何 ready 形象时出现在形象列表兜底
 * （demo 模式 + 新用户）。不持久化——id 约定常量，渲染链路特判解析。
 */
export const PLATFORM_AVATAR_ID = "avatar_platform";

export function isPlatformAvatarId(id: string | undefined | null): boolean {
  return id === PLATFORM_AVATAR_ID;
}

export function buildPlatformAvatar(ownerId: string): AvatarProfile {
  const now = nowIso();
  return {
    id: PLATFORM_AVATAR_ID,
    ownerId,
    storeId: "",
    name: "平台公共形象",
    provider: "heygen",
    providerAvatarId: undefined,
    providerVoiceId: undefined,
    consentStatus: "approved",
    consentAcceptedAt: now,
    trainingStatus: "ready",
    fallbackMode: "template_avatar",
    createdAt: now,
    updatedAt: now,
  };
}

/** env 模板解析；未配置时由调用方回退 provider.createAvatar()（公共 stock 形象）。 */
export function resolvePlatformProviderIds(): {
  providerAvatarId: string;
  providerVoiceId?: string;
} | null {
  const templateId = getHeygenAvatarTemplateId();
  if (!templateId) return null;
  return { providerAvatarId: templateId, providerVoiceId: getHeygenVoiceId() };
}
