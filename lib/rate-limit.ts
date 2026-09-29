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
const OTP_EMAIL_ATTEMPTS: RateLimitConfig = { windowSeconds: 600, maxRequests: 5 };
const OTP_IP_ATTEMPTS: RateLimitConfig = { windowSeconds: 600, maxRequests: 20 };
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
 * OTP 校验尝试限流（middleware 对 /api/auth/callback/email 调用）。
 * 6 位码空间仅 1e6：每邮箱 10 分钟 5 次（单码成功率 5e-6），每 IP 10 分钟 20 次。
 * 进入即计数（成功也计）——NextAuth 一次性消费 token 天然防重放，
 * 正常用户 1-2 次内成功，5 次硬顶不构成误伤。
 * 与全局限流同一后端：无 Redis 时 demo 走 memory / production fail-open（既有口径）。
 */
export async function rateLimitOtpAttempt(
  ip: string,
  email: string,
): Promise<boolean> {
  const normalized = normalizeEmail(email);
  // 同 rateLimitLogin：只消费 .allowed，needReset=false 省 ttl 命令。
  const [emailLimit, ipLimit] = await Promise.all([
    checkLimit(`otp:try:email:${normalized}`, OTP_EMAIL_ATTEMPTS, false),
    checkLimit(`otp:try:ip:${ip}`, OTP_IP_ATTEMPTS, false),
  ]);
  return emailLimit.allowed && ipLimit.allowed;
}

// ── Redeem & admin rate limits ─────────────────────────────────────────────

const REDEEM_OWNER_PER_MINUTE: RateLimitConfig = { windowSeconds: 60, maxRequests: 10 };
const REDEEM_IP_PER_MINUTE: RateLimitConfig = { windowSeconds: 60, maxRequests: 30 };
const ADMIN_IP_PER_MINUTE: RateLimitConfig = { windowSeconds: 60, maxRequests: 30 };

/**
 * 兑换接口爆破防护：每 owner 10 次/分钟 + 每 IP 30 次/分钟。
 * 兑换码空间 32^16，爆破不现实，限流挡的是脚本刷接口/探测。
 * 与 OTP 同口径：只消费 .allowed，needReset=false 跳过 ttl 命令。
 */
export async function rateLimitRedeem(ownerId: string, ip: string): Promise<boolean> {
  const [owner, ipResult] = await Promise.all([
    checkLimit(`redeem:owner:${ownerId}`, REDEEM_OWNER_PER_MINUTE, false),
    checkLimit(`redeem:ip:${ip}`, REDEEM_IP_PER_MINUTE, false),
  ]);
  return owner.allowed && ipResult.allowed;
}

/** 后台接口 IP 限流（30/min）：后台走 x-admin-key 鉴权，多一层防扫。 */
export async function rateLimitAdminIp(ip: string): Promise<boolean> {
  const result = await checkLimit(`admin:ip:${ip}`, ADMIN_IP_PER_MINUTE, false);
  return result.allowed;
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

// ── L0-auth: /api/auth/* 命名空间级限流 ──────────────────────────────────────

const AUTH_NAMESPACE_LIMIT: RateLimitConfig = { windowSeconds: 60, maxRequests: 60 };

/**
 * L0-auth: /api/auth/* 命名空间级 IP 限流（OTP 专项限流之外的兜底）。
 * 正常登录流程一分钟约十余次请求（csrf+signin+callback+页面加载），60/min
 * 只挡脚本级刷量。/api/auth/session 由 middleware 豁免（每次页面加载都打）。
 * 与 L0/L2 同一后端：无 Redis 时 demo 走 memory / production fail-open（既有口径）。
 */
export async function rateLimitAuthNamespace(ip: string): Promise<boolean> {
  // 同 rateLimitByIp：middleware 只消费 .allowed，needReset=false 跳过 ttl 命令。
  const result = await checkLimit(`auth:ns:${ip}`, AUTH_NAMESPACE_LIMIT, false);
  return result.allowed;
}

/** 豁免 L0 命名空间限流的 auth 路径（高频只读，限流会误伤正常浏览）。 */
export function isAuthL0Exempt(pathname: string): boolean {
  return pathname === "/api/auth/session";
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
      { error: "rate_limited", retryAfter, message: "请求过于频繁，请稍后再试" },
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
