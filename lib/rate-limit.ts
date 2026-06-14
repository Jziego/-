import { hasRedis, getRedisUrl, getAppMode } from "@/lib/env";
import { Redis } from "ioredis";

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

// ── Redis lazy connection ──────────────────────────────────────────────────

let _redis: Redis | null = null;

function getRedis(): Redis | null {
  if (_redis) return _redis;
  if (hasRedis()) _redis = new Redis(getRedisUrl()!);
  return _redis;
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
): Promise<RateLimitResult> {
  const r = getRedis()!;
  const count = await r.incr(key);
  if (count === 1) await r.expire(key, config.windowSeconds);
  const ttlRemaining = await r.ttl(key);
  return {
    allowed: count <= config.maxRequests,
    remaining: Math.max(0, config.maxRequests - count),
    reset:
      Math.floor(Date.now() / 1000) +
      (ttlRemaining > 0 ? ttlRemaining : config.windowSeconds),
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
): Promise<RateLimitResult> {
  const backend = resolveBackend();
  if (backend === "none") return { allowed: true, remaining: 999, reset: 0 };
  if (backend === "redis") return redisFixedWindow(key, config);
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
  const [ipMin, ipHour, emailMin] = await Promise.all([
    checkLimit(`login:ip:min:${ip}`, LOGIN_IP_PER_MINUTE),
    checkLimit(`login:ip:hour:${ip}`, LOGIN_IP_PER_HOUR),
    checkLimit(`login:email:${normalized}`, LOGIN_EMAIL_PER_MINUTE),
  ]);
  return ipMin.allowed && ipHour.allowed && emailMin.allowed;
}

/**
 * L2: API rate limit. Skipped in demo mode.
 *
 * @param key  Rate limit key (typically userId for authenticated users)
 * @param method  HTTP method — POST/PUT/DELETE use the write limit, others use read
 */
export async function rateLimitApi(
  key: string,
  method: string,
): Promise<RateLimitResult> {
  if (getAppMode() === "demo") {
    return { allowed: true, remaining: 999, reset: 0 };
  }
  const config = ["POST", "PUT", "DELETE"].includes(method) ? API_WRITE : API_READ;
  return checkLimit(`api:${key}`, config);
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
