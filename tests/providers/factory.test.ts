import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  AvatarProviderNotConfiguredError,
  createProviderFromEnv,
} from "@/lib/services/providers";

// 生产环境缺失数字人配置时必须炸得响亮，拒绝静默降级 mock——
// mock 会编造假授权链接（consent.example.com），用户点击创建分身后
// 跳转到一个不存在的网站，故障极难定位（2026-08-30 生产事故）。
describe("createProviderFromEnv factory", () => {
  const savedName = process.env.AVATAR_PROVIDER;
  const savedKey = process.env.AVATAR_PROVIDER_API_KEY;

  beforeEach(() => {
    delete process.env.AVATAR_PROVIDER;
    delete process.env.AVATAR_PROVIDER_API_KEY;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (savedName) process.env.AVATAR_PROVIDER = savedName;
    if (savedKey) process.env.AVATAR_PROVIDER_API_KEY = savedKey;
  });

  it("demo 模式未配置 → mock 兜底（本地开发/预览不炸）", () => {
    vi.stubEnv("APP_MODE", "demo");
    expect(createProviderFromEnv().name).toBe("mock-avatar");
  });

  it("AVATAR_PROVIDER=mock-avatar 显式配置 → mock（即使有 key）", () => {
    vi.stubEnv("AVATAR_PROVIDER", "mock-avatar");
    vi.stubEnv("AVATAR_PROVIDER_API_KEY", "key-123");
    expect(createProviderFromEnv().name).toBe("mock-avatar");
  });

  it("配置齐全 → heygen（demo 与 production 一致）", () => {
    vi.stubEnv("AVATAR_PROVIDER", "heygen");
    vi.stubEnv("AVATAR_PROVIDER_API_KEY", "hk_12345");
    expect(createProviderFromEnv().name).toBe("heygen");
  });

  it("production 完全未配置 → 抛 AvatarProviderNotConfiguredError", () => {
    vi.stubEnv("APP_MODE", "production");
    expect(() => createProviderFromEnv()).toThrow(AvatarProviderNotConfiguredError);
  });

  it("production 只配了 AVATAR_PROVIDER 没配 key → 同样抛错", () => {
    vi.stubEnv("APP_MODE", "production");
    vi.stubEnv("AVATAR_PROVIDER", "heygen");
    expect(() => createProviderFromEnv()).toThrow(AvatarProviderNotConfiguredError);
  });

  it("production 显式 mock-avatar 也抛错（生产不许 mock）", () => {
    vi.stubEnv("APP_MODE", "production");
    vi.stubEnv("AVATAR_PROVIDER", "mock-avatar");
    vi.stubEnv("AVATAR_PROVIDER_API_KEY", "key-123");
    expect(() => createProviderFromEnv()).toThrow(AvatarProviderNotConfiguredError);
  });
});
