import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

interface FakeRedis extends EventEmitter {
  configCalls: string[][];
  disconnected: boolean;
}

const { instances, flags } = vi.hoisted(() => ({
  instances: [] as FakeRedis[],
  flags: { failConnect: false },
}));

vi.mock("ioredis", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    Redis: class extends EventEmitter {
      configCalls: string[][] = [];
      disconnected = false;
      constructor(..._args: unknown[]) {
        super();
        instances.push(this as FakeRedis);
      }
      async connect() {
        if (flags.failConnect) throw new Error("connect ETIMEDOUT");
      }
      async config(...args: string[]) {
        this.configCalls.push(args);
      }
      disconnect() {
        this.disconnected = true;
      }
    },
  };
});

import { applyRedisGuardrails } from "@/lib/queue";

describe("applyRedisGuardrails", () => {
  afterEach(() => {
    instances.length = 0;
    flags.failConnect = false;
    vi.unstubAllEnvs();
  });

  it("启动时 CONFIG SET maxmemory=512mb + noeviction，并断开临时连接", async () => {
    await applyRedisGuardrails();
    expect(instances).toHaveLength(1);
    const r = instances[0];
    expect(r.configCalls).toContainEqual(["SET", "maxmemory", "536870912"]);
    expect(r.configCalls).toContainEqual(["SET", "maxmemory-policy", "noeviction"]);
    expect(r.disconnected).toBe(true);
  });

  it("可用 REDIS_MAXMEMORY_BYTES 覆盖默认值", async () => {
    vi.stubEnv("REDIS_MAXMEMORY_BYTES", "268435456");
    await applyRedisGuardrails();
    expect(instances[0].configCalls).toContainEqual(["SET", "maxmemory", "268435456"]);
  });

  it("Redis 不可达时不抛错（仅告警，不阻塞 worker 启动）", async () => {
    flags.failConnect = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await applyRedisGuardrails();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[redis] 护栏应用失败"));
    expect(instances[0].disconnected).toBe(true);
    warn.mockRestore();
  });

  // Zeabur 托管 Redis 空闲掐线（ECONNRESET）时 ioredis 会自动重连、功能无损，
  // 但无 error 监听的实例会打印 "[ioredis] Unhandled error event" 噪音。
  it("临时 client 挂了 error 监听器：emit error 不抛出", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await applyRedisGuardrails();
    const r = instances[0];
    expect(r.listenerCount("error")).toBeGreaterThan(0);
    expect(() => r.emit("error", new Error("read ECONNRESET"))).not.toThrow();
    warn.mockRestore();
  });
});
