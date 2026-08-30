import { getAppMode, getAvatarProviderName, hasAvatarProvider } from "@/lib/env";
import type { AvatarProvider } from "@/lib/services/avatar-provider";
import { createHeyGenProvider } from "@/lib/services/providers/heygen";
import { createMockProvider } from "@/lib/services/providers/mock";

/**
 * production 下数字人提供商未配置时抛出。
 * 历史上缺省会静默降级 mock——mock 编造假的 consent 链接（consent.example.com），
 * 用户创建分身后跳转到一个不存在的网站，故障极难定位（2026-08-30 生产事故）。
 */
export class AvatarProviderNotConfiguredError extends Error {
  constructor() {
    super("Avatar provider not configured: set AVATAR_PROVIDER and AVATAR_PROVIDER_API_KEY");
    this.name = "AvatarProviderNotConfiguredError";
  }
}

/**
 * Factory: returns the appropriate AvatarProvider based on environment config.
 *
 * - AVATAR_PROVIDER="heygen" + AVATAR_PROVIDER_API_KEY set → HeyGen
 * - demo/preview 未配置 → Mock（本地开发与测试用）
 * - production 未配置 → 抛 AvatarProviderNotConfiguredError（拒绝静默造假）
 */
export function createProviderFromEnv(): AvatarProvider {
  if (hasAvatarProvider()) {
    const name = (getAvatarProviderName() ?? "").toLowerCase();
    if (name === "heygen") {
      return createHeyGenProvider();
    }
    // Future providers: d-id, tavus, synthesia
  }

  if (getAppMode() === "production") {
    throw new AvatarProviderNotConfiguredError();
  }
  return createMockProvider();
}
