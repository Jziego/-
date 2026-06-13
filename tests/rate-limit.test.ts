import { describe, expect, it, vi } from "vitest";

describe("getClientIp", () => {
  it("extracts the first IP from x-forwarded-for", async () => {
    const { getClientIp } = await import("@/lib/rate-limit");
    const headers = {
      get: (name: string) =>
        name === "x-forwarded-for" ? "10.0.0.1, 10.0.0.2, 10.0.0.3" : null,
    };
    expect(getClientIp(headers)).toBe("10.0.0.1");
  });

  it("falls back to x-real-ip", async () => {
    const { getClientIp } = await import("@/lib/rate-limit");
    const headers = {
      get: (name: string) => (name === "x-real-ip" ? "10.0.0.5" : null),
    };
    expect(getClientIp(headers)).toBe("10.0.0.5");
  });

  it("returns 'unknown' when no IP headers are present", async () => {
    const { getClientIp } = await import("@/lib/rate-limit");
    const headers = { get: () => null };
    expect(getClientIp(headers)).toBe("unknown");
  });

  it("trims whitespace from x-forwarded-for entries", async () => {
    const { getClientIp } = await import("@/lib/rate-limit");
    const headers = {
      get: (name: string) =>
        name === "x-forwarded-for" ? " 192.168.1.1 , 10.0.0.2" : null,
    };
    expect(getClientIp(headers)).toBe("192.168.1.1");
  });
});

describe("rateLimitApi", () => {
  it("returns allowed=true in demo mode regardless of key", async () => {
    vi.stubEnv("APP_MODE", "demo");
    const { rateLimitApi } = await import("@/lib/rate-limit");
    const result = await rateLimitApi("any_key", "POST");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(999);
    vi.unstubAllEnvs();
  });
});

describe("ratelimitHeaders", () => {
  it("includes remaining and reset headers", async () => {
    const { ratelimitHeaders } = await import("@/lib/rate-limit");
    const headers = ratelimitHeaders({
      allowed: true,
      remaining: 59,
      reset: 1700000000,
    });
    expect(headers["X-RateLimit-Remaining"]).toBe("59");
    expect(headers["X-RateLimit-Reset"]).toBe("1700000000");
    expect(headers["Retry-After"]).toBeUndefined();
  });

  it("includes Retry-After when not allowed", async () => {
    const { ratelimitHeaders } = await import("@/lib/rate-limit");
    const now = Math.floor(Date.now() / 1000);
    const headers = ratelimitHeaders({
      allowed: false,
      remaining: 0,
      reset: now + 30,
    });
    expect(headers["X-RateLimit-Remaining"]).toBe("0");
    expect(headers["Retry-After"]).toBeDefined();
    expect(Number(headers["Retry-After"])).toBeLessThanOrEqual(30);
  });
});
