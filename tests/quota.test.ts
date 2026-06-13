import { describe, expect, it, vi } from "vitest";

describe("QuotaExhaustedError", () => {
  it("has correct name and retains the plan", async () => {
    const { QuotaExhaustedError } = await import("@/lib/quota");
    const err = new QuotaExhaustedError("free");
    expect(err.name).toBe("QuotaExhaustedError");
    expect(err.message).toBe("Quota exhausted");
    expect(err.plan).toBe("free");
  });
});

describe("consumeQuota", () => {
  it("returns free/10 for demoOwnerId without touching DB", async () => {
    const { consumeQuota } = await import("@/lib/quota");
    const result = await consumeQuota("demo_user");
    expect(result).toEqual({ plan: "free", remaining: 10 });
  });

  it("returns free/10 when hasDatabase() is false", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const { consumeQuota } = await import("@/lib/quota");
    const result = await consumeQuota("real_user");
    expect(result).toEqual({ plan: "free", remaining: 10 });
    vi.unstubAllEnvs();
  });
});
