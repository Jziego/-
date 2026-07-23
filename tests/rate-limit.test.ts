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

  it("uses SEPARATE buckets for reads vs writes (reads must not exhaust write budget)", async () => {
    // Regression: the dashboard fires many GETs on mount + 5s polling while
    // active. With a shared read/write counter, those reads push the counter
    // past the WRITE limit (20/min), so an unrelated POST (asset upload-intent)
    // gets 429 the moment the user tries to upload. Read and write limits must
    // use INDEPENDENT bucket keys.
    const { resolveApiBucket } = await import("@/lib/rate-limit");
    const owner = "owner_rw_isolation_test";

    const read = resolveApiBucket(owner, "GET");
    const write = resolveApiBucket(owner, "POST");

    // Independent keys ⇒ independent counters (the backend keys per-string,
    // proven by the rateLimitByIp test above).
    expect(read.key).not.toBe(write.key);
    expect(read.key).toBe(`api:${owner}:read`);
    expect(write.key).toBe(`api:${owner}:write`);
    // Limits stay as documented: reads 60/min, writes 20/min.
    expect(read.config.maxRequests).toBe(60);
    expect(write.config.maxRequests).toBe(20);
  });

  it("classifies POST/PUT/PATCH/DELETE as writes and everything else as reads", async () => {
    const { resolveApiBucket } = await import("@/lib/rate-limit");
    const owner = "owner_methods_test";
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(resolveApiBucket(owner, m).key).toBe(`api:${owner}:write`);
    }
    for (const m of ["GET", "HEAD", "OPTIONS"]) {
      expect(resolveApiBucket(owner, m).key).toBe(`api:${owner}:read`);
    }
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

describe("rateLimitByIp", () => {
  it("enforces maxRequests via in-memory backend when Redis absent", async () => {
    vi.stubEnv("APP_MODE", "demo");
    vi.stubEnv("REDIS_URL", "");
    const { rateLimitByIp, _resetMemoryStore } = await import("@/lib/rate-limit");
    _resetMemoryStore();
    const ip = "203.0.113.7";
    for (let i = 0; i < 60; i++) {
      const r = await rateLimitByIp(ip);
      expect(r.allowed).toBe(true);
    }
    const blocked = await rateLimitByIp(ip);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    vi.unstubAllEnvs();
  });

  it("disables limiting in production without Redis (fail-open)", async () => {
    vi.stubEnv("APP_MODE", "production");
    vi.stubEnv("REDIS_URL", "");
    const { rateLimitByIp } = await import("@/lib/rate-limit");
    const ip = "203.0.113.8";
    for (let i = 0; i < 100; i++) {
      const r = await rateLimitByIp(ip);
      expect(r.allowed).toBe(true);
    }
    vi.unstubAllEnvs();
  });
});
