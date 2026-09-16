import { describe, expect, it, afterEach, vi } from "vitest";
import { hasLipSyncProvider } from "@/lib/env";
import { createProviderByName, createProviderFromEnv, AvatarProviderNotConfiguredError } from "@/lib/services/providers";

describe("lipsync env accessors", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("hasLipSyncProvider requires both MEDIKIT_API_KEY and DOUBAO_TTS_API_KEY", () => {
    vi.stubEnv("MEDIKIT_API_KEY", "mk_key");
    vi.stubEnv("DOUBAO_TTS_API_KEY", "tts_key");
    expect(hasLipSyncProvider()).toBe(true);

    vi.stubEnv("DOUBAO_TTS_API_KEY", "");
    expect(hasLipSyncProvider()).toBe(false);
  });

  it("hasLipSyncProvider is false when both unset", () => {
    vi.stubEnv("MEDIKIT_API_KEY", "");
    vi.stubEnv("DOUBAO_TTS_API_KEY", "");
    expect(hasLipSyncProvider()).toBe(false);
  });
});

describe("provider factory", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("createProviderFromEnv returns the lipsync provider when AVATAR_PROVIDER=volcengine-lipsync and both keys are set", () => {
    vi.stubEnv("AVATAR_PROVIDER", "volcengine-lipsync");
    vi.stubEnv("MEDIKIT_API_KEY", "mk");
    vi.stubEnv("DOUBAO_TTS_API_KEY", "tts");
    expect(createProviderFromEnv().name).toBe("volcengine-lipsync");
  });

  it("createProviderFromEnv throws in production when lipsync is named but keys are missing", () => {
    vi.stubEnv("APP_MODE", "production");
    vi.stubEnv("AVATAR_PROVIDER", "volcengine-lipsync");
    vi.stubEnv("MEDIKIT_API_KEY", "");
    vi.stubEnv("DOUBAO_TTS_API_KEY", "");
    expect(() => createProviderFromEnv()).toThrow(AvatarProviderNotConfiguredError);
  });

  it("createProviderFromEnv falls back to mock in demo when lipsync keys are missing", () => {
    vi.stubEnv("APP_MODE", "demo");
    vi.stubEnv("AVATAR_PROVIDER", "volcengine-lipsync");
    vi.stubEnv("MEDIKIT_API_KEY", "");
    vi.stubEnv("DOUBAO_TTS_API_KEY", "");
    expect(createProviderFromEnv().name).toBe("mock-avatar");
  });

  it("createProviderFromEnv keeps the heygen branch unchanged", () => {
    vi.stubEnv("APP_MODE", "production");
    vi.stubEnv("AVATAR_PROVIDER", "heygen");
    vi.stubEnv("AVATAR_PROVIDER_API_KEY", "hk");
    expect(createProviderFromEnv().name).toBe("heygen");
  });

  it("createProviderByName resolves per-profile providers and falls back to env for unknown names", () => {
    vi.stubEnv("APP_MODE", "demo");
    vi.stubEnv("AVATAR_PROVIDER", "");
    expect(createProviderByName("heygen").name).toBe("heygen");
    expect(createProviderByName("volcengine-lipsync").name).toBe("volcengine-lipsync");
    expect(createProviderByName("mock-avatar").name).toBe("mock-avatar");
    // 未知/缺省（平台公共形象、老数据）→ env 创建 provider（demo 无配置 → mock）
    expect(createProviderByName(undefined).name).toBe("mock-avatar");
    expect(createProviderByName("d-id").name).toBe("mock-avatar");
  });
});
