import { describe, expect, it, beforeEach, vi } from "vitest";

const mockEnv = { AVATAR_PROVIDER: "", AVATAR_PROVIDER_API_KEY: "" };

async function getFactory() {
  vi.stubEnv("AVATAR_PROVIDER", mockEnv.AVATAR_PROVIDER);
  vi.stubEnv("AVATAR_PROVIDER_API_KEY", mockEnv.AVATAR_PROVIDER_API_KEY);
  const { createProviderFromEnv } = await import(
    "@/lib/services/providers/index"
  );
  return createProviderFromEnv;
}

describe("avatar provider factory", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns mock provider when no env vars are set", async () => {
    mockEnv.AVATAR_PROVIDER = "";
    mockEnv.AVATAR_PROVIDER_API_KEY = "";
    const factory = await getFactory();
    const provider = factory();
    expect(provider.name).toBe("mock-avatar");
  });

  it("returns mock provider when AVATAR_PROVIDER is mock-avatar", async () => {
    mockEnv.AVATAR_PROVIDER = "mock-avatar";
    mockEnv.AVATAR_PROVIDER_API_KEY = "key-123";
    const factory = await getFactory();
    const provider = factory();
    expect(provider.name).toBe("mock-avatar");
  });

  it("returns heygen provider when AVATAR_PROVIDER=heygen and key is set", async () => {
    mockEnv.AVATAR_PROVIDER = "heygen";
    mockEnv.AVATAR_PROVIDER_API_KEY = "hk_12345";
    const factory = await getFactory();
    const provider = factory();
    expect(provider.name).toBe("heygen");
  });
});
