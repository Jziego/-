import { describe, expect, it, afterEach, vi } from "vitest";
import {
  PLATFORM_AVATAR_ID,
  buildPlatformAvatar,
  isPlatformAvatarId,
  resolvePlatformProviderIds,
} from "@/lib/services/platform-avatar";

describe("platform avatar", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("builds a synthetic ready profile with stable id", () => {
    const p = buildPlatformAvatar("owner_1");
    expect(p.id).toBe(PLATFORM_AVATAR_ID);
    expect(p.ownerId).toBe("owner_1");
    expect(p.trainingStatus).toBe("ready");
    expect(p.consentStatus).toBe("approved");
    expect(p.name).toContain("平台");
    expect(isPlatformAvatarId(p.id)).toBe(true);
    expect(isPlatformAvatarId("avatar_user_1")).toBe(false);
  });

  it("resolves provider ids from env template", () => {
    vi.stubEnv("HEYGEN_AVATAR_TEMPLATE_ID", "tpl_1");
    vi.stubEnv("HEYGEN_VOICE_ID", "v_1");
    expect(resolvePlatformProviderIds()).toEqual({ providerAvatarId: "tpl_1", providerVoiceId: "v_1" });
  });

  it("returns null when no template configured (caller falls back to provider.createAvatar)", () => {
    expect(resolvePlatformProviderIds()).toBeNull();
  });
});
