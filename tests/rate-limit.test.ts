import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// ioredis mock：记录命令序列，用于断言 needReset=false 时 middleware 免 ttl。
const redisCommandLog: string[] = [];
const incrCounts = new Map<string, number>();

const mockPipeline = {
  set: vi.fn().mockReturnThis(),
  exec: vi.fn().mockResolvedValue([]),
};

const mockRedis = {
  incr: vi.fn((key: string) => {
    redisCommandLog.push("incr");
    const next = (incrCounts.get(key) ?? 0) + 1;
    incrCounts.set(key, next);
    return Promise.resolve(next);
  }),
  expire: vi.fn((_key: string, _seconds: number) => {
    redisCommandLog.push("expire");
    return Promise.resolve(1);
  }),
  ttl: vi.fn((_key: string) => {
    redisCommandLog.push("ttl");
    return Promise.resolve(55);
  }),
  exists: vi.fn((_key: string) => Promise.resolve(0)),
  set: vi.fn(() => Promise.resolve("OK")),
  pipeline: vi.fn(() => mockPipeline),
};

vi.mock("ioredis", () => ({
  Redis: vi.fn().mockImplementation(function () {
    return mockRedis;
  }),
}));

import { Redis } from "ioredis";

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

describe("rateLimitOtpAttempt", () => {
  it("allows up to 5 attempts per email in 10min, then blocks", async () => {
    vi.stubEnv("APP_MODE", "demo");
    vi.stubEnv("REDIS_URL", "");
    const { rateLimitOtpAttempt, _resetMemoryStore } = await import(
      "@/lib/rate-limit"
    );
    _resetMemoryStore();
    for (let i = 0; i < 5; i++) {
      expect(await rateLimitOtpAttempt("1.2.3.4", "a@b.com")).toBe(true);
    }
    expect(await rateLimitOtpAttempt("1.2.3.4", "a@b.com")).toBe(false);
    vi.unstubAllEnvs();
  });

  it("email bucket is case/whitespace-insensitive", async () => {
    vi.stubEnv("APP_MODE", "demo");
    vi.stubEnv("REDIS_URL", "");
    const { rateLimitOtpAttempt, _resetMemoryStore } = await import(
      "@/lib/rate-limit"
    );
    _resetMemoryStore();
    for (let i = 0; i < 5; i++) {
      await rateLimitOtpAttempt("1.2.3.4", "A@b.com ");
    }
    expect(await rateLimitOtpAttempt("1.2.3.4", "a@b.com")).toBe(false);
    vi.unstubAllEnvs();
  });

  it("allows up to 20 attempts per IP across different emails, then blocks", async () => {
    vi.stubEnv("APP_MODE", "demo");
    vi.stubEnv("REDIS_URL", "");
    const { rateLimitOtpAttempt, _resetMemoryStore } = await import(
      "@/lib/rate-limit"
    );
    _resetMemoryStore();
    for (let i = 0; i < 20; i++) {
      expect(await rateLimitOtpAttempt("5.6.7.8", `user${i}@x.com`)).toBe(true);
    }
    expect(await rateLimitOtpAttempt("5.6.7.8", "another@x.com")).toBe(false);
    vi.unstubAllEnvs();
  });
});

describe("redis fixed-window command sequence", () => {
  beforeEach(async () => {
    vi.stubEnv("APP_MODE", "production");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    redisCommandLog.length = 0;
    incrCounts.clear();
    vi.clearAllMocks();
    // 共享连接复位：清空 session-blacklist 模块级缓存，保证用例隔离
    const { _resetRedis } = await import("@/lib/session-blacklist");
    _resetRedis();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("middleware IP limit (needReset=false) skips the ttl command", async () => {
    const { rateLimitByIp } = await import("@/lib/rate-limit");

    const first = await rateLimitByIp("198.51.100.9");
    expect(redisCommandLog).toEqual(["incr", "expire"]);
    expect(first.allowed).toBe(true);

    const second = await rateLimitByIp("198.51.100.9");
    expect(redisCommandLog).toEqual(["incr", "expire", "incr"]);
    // reset 头退化为 now+windowSeconds 近似（只影响头精度，不影响 allowed 判定）
    const now = Math.floor(Date.now() / 1000);
    expect(second.reset).toBeGreaterThanOrEqual(now + 55);
    expect(second.reset).toBeLessThanOrEqual(now + 61);
    expect(mockRedis.ttl).not.toHaveBeenCalled();
  });

  it("API limit (needReset=true) still issues ttl for the X-RateLimit-Reset header", async () => {
    const { rateLimitApi } = await import("@/lib/rate-limit");

    const result = await rateLimitApi("owner_rl_seq", "GET");
    expect(redisCommandLog).toEqual(["incr", "expire", "ttl"]);
    const now = Math.floor(Date.now() / 1000);
    // ttlRemaining mock 为 55s ⇒ reset ≈ now+55
    expect(result.reset).toBeGreaterThanOrEqual(now + 54);
    expect(result.reset).toBeLessThanOrEqual(now + 56);
  });
});

describe("shared Redis connection (rate-limit <-> session-blacklist)", () => {
  it("rate-limit reconnects through the shared getter after a shared reset", async () => {
    vi.stubEnv("APP_MODE", "production");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    const { _resetRedis, isSessionRevoked } = await import("@/lib/session-blacklist");
    const { rateLimitByIp } = await import("@/lib/rate-limit");

    await isSessionRevoked("warm-jti"); // 建立连接
    _resetRedis(); // 共享连接复位：两模块都必须经共享 getter 重建
    const callsBefore = vi.mocked(Redis).mock.calls.length;

    await rateLimitByIp("198.51.100.11");

    // rate-limit 走共享 getter ⇒ 复位后会重建连接（若私有自己的模块级缓存则不会）
    expect(vi.mocked(Redis).mock.calls.length - callsBefore).toBe(1);
    vi.unstubAllEnvs();
  });
});
