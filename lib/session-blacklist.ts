import { Redis } from "ioredis";
import { getRedisUrl, hasRedis } from "@/lib/env";

let _redis: Redis | null = null;

/**
 * 共享 Redis 连接 getter：session-blacklist（JWT 黑名单）与 rate-limit（限流）
 * 共用同一条连接，避免双进程各开一条常驻连接（4GB 小内存机）。
 * 保留 maxRetriesPerRequest:1 + connectTimeout:3000 的 fail-fast 配置；
 * rate-limit 热路径沿用它，Redis 宕机时快速抛错，与改造前默认重试 20 次后
 * 抛错的行为等价（只是更快）。注意 middleware 未包 try/catch：Redis 持续宕机
 * 时 API 请求 500——这是改造前后一致的行为，并非 fail-open。
 */
export function getSharedRedis(): Redis | null {
  if (_redis) return _redis;
  if (hasRedis()) {
    // Auto-connect (lazyConnect defaults to false) and allow the offline queue
    // (defaults to true) so the first command in a cold process is queued and
    // flushed once the connection establishes. The previous lazyConnect:true +
    // enableOfflineQueue:false combo rejected the very first command (the one
    // that triggers the connection), fail-opening the JWT blacklist check on
    // the first authenticated request after every process restart.
    _redis = new Redis(getRedisUrl()!, {
      maxRetriesPerRequest: 1,
      connectTimeout: 3000,
    });
  }
  return _redis;
}

const REVOKED_PREFIX = "revoked:";

/**
 * Revoke a session by its JWT ID (jti).
 * Sets a Redis key with TTL equal to the remaining JWT lifetime.
 */
export async function revokeSession(jti: string, ttlSeconds: number): Promise<void> {
  const r = getSharedRedis();
  if (!r) return;
  await r.set(`${REVOKED_PREFIX}${jti}`, "1", "EX", ttlSeconds);
}

/**
 * Check if a session has been revoked.
 * Returns false when Redis is unavailable (fail-open).
 */
export async function isSessionRevoked(jti: string): Promise<boolean> {
  const r = getSharedRedis();
  if (!r) return false;
  const exists = await r.exists(`${REVOKED_PREFIX}${jti}`);
  return exists === 1;
}

/**
 * Revoke multiple sessions at once (e.g., "logout all devices").
 */
export async function revokeAllSessions(jtis: string[], ttlSeconds: number): Promise<void> {
  const r = getSharedRedis();
  if (!r) return;
  if (jtis.length === 0) return;
  const pipeline = r.pipeline();
  for (const jti of jtis) {
    pipeline.set(`${REVOKED_PREFIX}${jti}`, "1", "EX", ttlSeconds);
  }
  await pipeline.exec();
}

/** 复位共享 Redis 连接（测试用）：两模块的连接缓存都在此处，复位对双方生效。 */
export function _resetRedis(): void {
  _redis = null;
}
