import type { Redis } from "ioredis";

/**
 * 同一实例 error 日志节流阈值。Zeabur 托管 Redis 空闲掐线（ECONNRESET）后
 * ioredis 默认自动重连、功能无损，但每次断连都会触发 error 事件——不节流会刷日志。
 */
export const REDIS_ERROR_LOG_THROTTLE_MS = 60_000;

/**
 * 给裸 ioredis 实例挂节流 error 监听器。
 *
 * 无 error 监听的实例在断连时会打印 "[ioredis] Unhandled error event" 噪音
 * （并触发 EventEmitter 告警）。挂上后 error 被消费，仅按阈值低频告警。
 */
export function attachRedisErrorLogging(client: Redis, tag: string): void {
  let lastLogged = 0;
  client.on("error", (err: Error) => {
    const now = Date.now();
    if (now - lastLogged > REDIS_ERROR_LOG_THROTTLE_MS) {
      lastLogged = now;
      console.warn(`[redis:${tag}] ${err.message}（ioredis 自动重连中，功能无损）`);
    }
  });
}
