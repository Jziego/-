import { getAppMode, getAvatarProviderName, hasAvatarProvider, hasLipSyncProvider } from "@/lib/env";
import type { AvatarProvider } from "@/lib/services/avatar-provider";
import { createHeyGenProvider } from "@/lib/services/providers/heygen";
import { createMockProvider } from "@/lib/services/providers/mock";
import { createVolcEngineLipSyncProvider } from "@/lib/services/providers/volcengine-lipsync";

/**
 * production 下数字人提供商未配置时抛出。
 * 历史上缺省会静默降级 mock——mock 编造假的 consent 链接（consent.example.com），
 * 用户创建分身后跳转到一个不存在的网站，故障极难定位（2026-08-30 生产事故）。
 */
export class AvatarProviderNotConfiguredError extends Error {
  constructor() {
    super("Avatar provider not configured: set AVATAR_PROVIDER and the provider's API keys");
    this.name = "AvatarProviderNotConfiguredError";
  }
}

export const LIPSYNC_PROVIDER_NAME = "volcengine-lipsync";

/**
 * Factory: 新形象「创建 provider」——决定 POST /api/avatars 用哪家创建。
 *
 * - AVATAR_PROVIDER="volcengine-lipsync" + MEDIKIT_API_KEY + DOUBAO_TTS_API_KEY → 对口型
 * - AVATAR_PROVIDER="heygen" + AVATAR_PROVIDER_API_KEY → HeyGen 分身克隆
 * - demo/preview 未配置 → Mock（本地开发与测试用）
 * - production 未配置 → 抛 AvatarProviderNotConfiguredError（拒绝静默造假）
 */
export function createProviderFromEnv(): AvatarProvider {
  const name = (getAvatarProviderName() ?? "").toLowerCase();

  if (name === LIPSYNC_PROVIDER_NAME) {
    if (hasLipSyncProvider()) {
      return createVolcEngineLipSyncProvider();
    }
    if (getAppMode() === "production") {
      throw new AvatarProviderNotConfiguredError();
    }
    return createMockProvider();
  }

  if (hasAvatarProvider() && name === "heygen") {
    return createHeyGenProvider();
  }

  if (getAppMode() === "production") {
    throw new AvatarProviderNotConfiguredError();
  }
  return createMockProvider();
}

/**
 * 按 profile.provider 逐形象解析（渲染/轮询链路用）：老 HeyGen 形象与对口型
 * 形象混排时各走各的供应商。未知/缺省名（平台公共形象约定 id、mock 时代
 * 老数据）回退到 env 创建 provider——与历史行为一致。
 */
export function createProviderByName(name: string | undefined): AvatarProvider {
  switch ((name ?? "").toLowerCase()) {
    case "heygen":
      return createHeyGenProvider();
    case LIPSYNC_PROVIDER_NAME:
      return createVolcEngineLipSyncProvider();
    case "mock-avatar":
      return createMockProvider();
    default:
      return createProviderFromEnv();
  }
}
