import { Redis } from "ioredis";
import { getRedisUrl, hasRedis } from "@/lib/env";

let _redis: Redis | null = null;

function getRedis(): Redis | null {
  if (_redis) return _redis;
  if (hasRedis()) {
    // Auto-connect (lazyConnect defaults to false) and allow the offline queue
    // (defaults to true) so the first command in a cold process is queued and
    // flushed once the connection establishes. The previous lazyConnect:true +
    // enableOfflineQueue:false combo rejected the very first command (the one
    // that triggers the connection), fail-opening the JWT blacklist check on
    // the first authenticated request after every process restart.
    // maxRetriesPerRequest + connectTimeout keep the middleware hot path
    // fail-fast when Redis is actually down.
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
  const r = getRedis();
  if (!r) return;
  await r.set(`${REVOKED_PREFIX}${jti}`, "1", "EX", ttlSeconds);
}

/**
 * Check if a session has been revoked.
 * Returns false when Redis is unavailable (fail-open).
 */
export async function isSessionRevoked(jti: string): Promise<boolean> {
  const r = getRedis();
  if (!r) return false;
  const exists = await r.exists(`${REVOKED_PREFIX}${jti}`);
  return exists === 1;
}

/**
 * Revoke multiple sessions at once (e.g., "logout all devices").
 */
export async function revokeAllSessions(jtis: string[], ttlSeconds: number): Promise<void> {
  const r = getRedis();
  if (!r) return;
  if (jtis.length === 0) return;
  const pipeline = r.pipeline();
  for (const jti of jtis) {
    pipeline.set(`${REVOKED_PREFIX}${jti}`, "1", "EX", ttlSeconds);
  }
  await pipeline.exec();
}

/** Reset the Redis connection (for testing) */
export function _resetRedis(): void {
  _redis = null;
}
