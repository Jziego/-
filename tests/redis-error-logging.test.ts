import { EventEmitter } from "node:events";
import type { Redis } from "ioredis";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachRedisErrorLogging,
  REDIS_ERROR_LOG_THROTTLE_MS,
} from "@/lib/redis-error-logging";

function fakeClient(): Redis {
  return new EventEmitter() as unknown as Redis;
}

describe("attachRedisErrorLogging", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("挂上 error 监听器后 emit error 不抛出（消除 Unhandled error event 噪音）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const client = fakeClient();
    attachRedisErrorLogging(client, "test");

    expect(client.listenerCount("error")).toBe(1);
    expect(() => client.emit("error", new Error("read ECONNRESET"))).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[redis:test]"),
    );
  });

  it("error 日志按阈值节流：窗口内只告警一次，超过阈值再次告警", () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const client = fakeClient();
    attachRedisErrorLogging(client, "test");

    client.emit("error", new Error("read ECONNRESET"));
    client.emit("error", new Error("read ECONNRESET"));
    expect(warn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(REDIS_ERROR_LOG_THROTTLE_MS + 1);
    client.emit("error", new Error("read ECONNRESET"));
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
