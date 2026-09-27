import { getAppMode } from "@/lib/env";
import { getSharedRedis } from "@/lib/session-blacklist";
import { Redis } from "ioredis";

// 说明：Redis 连接由 session-blacklist 的 getSharedRedis 统一供给（middleware
// 黑名单校验与限流共用一条连接）；本模块不再自建连接。共享连接沿用 blacklist 的
// maxRetriesPerRequest:1 fail-fast 配置——Redis 宕机时限流命令快速抛错，与改造前
// 默认重试 20 次后抛错的行为等价（只是更快）；middleware 未包 try/catch，Redis
// 持续宕机时 API 请求会 500，改造前后一致。

// ── Configuration ──────────────────────────────────────────────────────────

interface RateLimitConfig {
  windowSeconds: number;
  maxRequests: number;
}

const LOGIN_IP_PER_MINUTE: RateLimitConfig = { windowSeconds: 60, maxRequests: 5 };
const LOGIN_IP_PER_HOUR: RateLimitConfig = { windowSeconds: 3600, maxRequests: 20 };
const LOGIN_EMAIL_PER_MINUTE: RateLimitConfig = { windowSeconds: 60, maxRequests: 1 };
const API_READ: RateLimitConfig = { windowSeconds: 60, maxRequests: 60 };
const API_WRITE: RateLimitConfig = { windowSeconds: 60, maxRequests: 20 };

// ── Redis backend (shared connection) ──────────────────────────────────────

function getRedis(): Redis | null {
  return getSharedRedis();
}

// ── IP extraction ──────────────────────────────────────────────────────────

/**
 * Extract client IP from headers, respecting forwarded proxies.
 */
export function getClientIp(headersList: {
  get(name: string): string | null;
}): string {
  const forwarded = headersList.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim() || "unknown";
  return headersList.get("x-real-ip") ?? "unknown";
}

// ── Email normalization ────────────────────────────────────────────────────

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// ── Result type ────────────────────────────────────────────────────────────

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Unix timestamp (seconds) when the window resets */
  reset: number;
}

// ── Redis fixed-window implementation ──────────────────────────────────────

async function redisFixedWindow(
  key: string,
  config: RateLimitConfig,
  needReset: boolean,
): Promise<RateLimitResult> {
  const r = getRedis()!;
  const count = await r.incr(key);
  if (count === 1) await r.expire(key, config.windowSeconds);
  // needReset=false（middleware L0 只看 .allowed）时跳过 ttl 命令，reset 用
  // now+windowSeconds 近似——只影响 reset 头精度，allowed 判定不变。
  let reset: number;
  if (needReset) {
    const ttlRemaining = await r.ttl(key);
    reset =
      Math.floor(Date.now() / 1000) +
      (ttlRemaining > 0 ? ttlRemaining : config.windowSeconds);
  } else {
    reset = Math.floor(Date.now() / 1000) + config.windowSeconds;
  }
  return {
    allowed: count <= config.maxRequests,
    remaining: Math.max(0, config.maxRequests - count),
    reset,
  };
}

// ── In-memory fallback ─────────────────────────────────────────────────────

const memoryStore = new Map<string, { count: number; reset: number }>();

// Purge expired entries every 60s
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of memoryStore) {
    if (entry.reset <= now) memoryStore.delete(key);
  }
}, 60_000);

function memoryFixedWindow(
  key: string,
  config: RateLimitConfig,
): RateLimitResult {
  const now = Date.now();
  const entry = memoryStore.get(key);

  if (!entry || entry.reset <= now) {
    const reset = now + config.windowSeconds * 1000;
    memoryStore.set(key, { count: 1, reset });
    return {
      allowed: true,
      remaining: config.maxRequests - 1,
      reset: Math.floor(reset / 1000),
    };
  }

  entry.count++;
  return {
    allowed: entry.count <= config.maxRequests,
    remaining: Math.max(0, config.maxRequests - entry.count),
    reset: Math.floor(entry.reset / 1000),
  };
}

// ── Backend resolution ─────────────────────────────────────────────────────

function resolveBackend(): "redis" | "memory" | "none" {
  if (getRedis()) return "redis";
  if (getAppMode() === "production") {
    console.warn(
      "[rate-limit] REDIS_URL missing in production — rate limiting disabled",
    );
    return "none";
  }
  return "memory";
}

async function checkLimit(
  key: string,
  config: RateLimitConfig,
  needReset: boolean,
): Promise<RateLimitResult> {
  const backend = resolveBackend();
  if (backend === "none") return { allowed: true, remaining: 999, reset: 0 };
  if (backend === "redis") return redisFixedWindow(key, config, needReset);
  return memoryFixedWindow(key, config);
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * L1: Login rate limit. Checks three windows concurrently:
 *   - IP per minute (5/min)
 *   - IP per hour (20/hour)
 *   - Email per minute (1/min)
 *
 * Returns true if ALL windows allow the request.
 */
export async function rateLimitLogin(
  ip: string,
  email: string,
): Promise<boolean> {
  const normalized = normalizeEmail(email);
  // 登录限流只消费 .allowed（返回 boolean），needReset=false 省 3 次 ttl 命令。
  const [ipMin, ipHour, emailMin] = await Promise.all([
    checkLimit(`login:ip:min:${ip}`, LOGIN_IP_PER_MINUTE, false),
    checkLimit(`login:ip:hour:${ip}`, LOGIN_IP_PER_HOUR, false),
    checkLimit(`login:email:${normalized}`, LOGIN_EMAIL_PER_MINUTE, false),
  ]);
  return ipMin.allowed && ipHour.allowed && emailMin.allowed;
}

/**
 * Resolve the rate-limit bucket (key + config) for an API request.
 *
 * Reads and writes use INDEPENDENT buckets (`:read` / `:write` suffix) so that
 * background dashboard reads (mount burst + 5s polling) cannot exhaust the
 * write budget and starve user-initiated mutations like asset upload-intent.
 * The backend keys counters per-string, so distinct suffixes ⇒ isolated
 * counters (reads capped at 60/min, writes at 20/min, independently).
 *
 * Pure & exported so the read/write bucket isolation is unit-testable without
 * the demo/production/Redis coupling of `rateLimitApi`.
 */
export function resolveApiBucket(ownerId: string, method: string): {
  key: string;
  config: RateLimitConfig;
} {
  const isWrite = ["POST", "PUT", "PATCH", "DELETE"].includes(method);
  return {
    key: `api:${ownerId}:${isWrite ? "write" : "read"}`,
    config: isWrite ? API_WRITE : API_READ,
  };
}

/**
 * L2: API rate limit. Skipped in demo mode.
 *
 * @param key  Rate limit key (typically userId for authenticated users)
 * @param method  HTTP method — POST/PUT/PATCH/DELETE use the write limit, others use read
 */
export async function rateLimitApi(
  key: string,
  method: string,
): Promise<RateLimitResult> {
  if (getAppMode() === "demo") {
    return { allowed: true, remaining: 999, reset: 0 };
  }
  const bucket = resolveApiBucket(key, method);
  return checkLimit(bucket.key, bucket.config, true);
}

// ── IP-based middleware rate limit (L0) ─────────────────────────────────────

const IP_LIMIT_CONFIG: RateLimitConfig = { windowSeconds: 60, maxRequests: 60 };

/**
 * L0: IP-based rate limit for middleware (coarse, pre-auth, multi-instance safe).
 * Uses the same Redis/memory backend as L2 — multi-instance safe when Redis is
 * configured. Called only when APP_MODE !== "demo" (middleware short-circuits
 * in demo mode before reaching this).
 */
export async function rateLimitByIp(ip: string): Promise<RateLimitResult> {
  // middleware L0 只读 .allowed，needReset=false 跳过 ttl 命令（每秒省一次 Redis 往返）。
  return checkLimit(`ip:${ip}`, IP_LIMIT_CONFIG, false);
}

/** Reset the in-memory store (for testing only). */
export function _resetMemoryStore(): void {
  memoryStore.clear();
}

// ── Convenience helper for API routes ────────────────────────────────────────

/**
 * Apply L2 API rate limit and return a 429 response if exceeded.
 * Returns null if the request is allowed (caller should continue).
 *
 * Usage in API routes:
 *   const limited = await applyRateLimit(request, ownerId);
 *   if (limited) return limited;
 */
export async function applyRateLimit(
  request: Request,
  ownerId: string,
): Promise<Response | null> {
  const rl = await rateLimitApi(ownerId, request.method);
  if (!rl.allowed) {
    const retryAfter = Math.max(0, rl.reset - Math.floor(Date.now() / 1000));
    return Response.json(
      { error: "rate_limited", retryAfter },
      {
        status: 429,
        headers: {
          "X-RateLimit-Remaining": String(rl.remaining),
          "X-RateLimit-Reset": String(rl.reset),
          "Retry-After": String(retryAfter),
        },
      },
    );
  }
  return null;
}

// ── Response headers ───────────────────────────────────────────────────────

/**
 * Build standard RateLimit response headers.
 */
export function ratelimitHeaders(
  result: RateLimitResult,
): Record<string, string> {
  const headers: Record<string, string> = {
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": String(result.reset),
  };
  if (!result.allowed) {
    headers["Retry-After"] = String(
      Math.max(0, result.reset - Math.floor(Date.now() / 1000)),
    );
  }
  return headers;
}
