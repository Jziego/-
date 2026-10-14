import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createChallenge } from "altcha-lib/v1";
import type { Redis } from "ioredis";

// ── 内存版 fake Redis ──────────────────────────────────────────────────────
// Map 实现 SET ... NX PX 语义：key 已存在时返回 null（消费失败 = 重放）。
const { redisStore, fakeRedis } = vi.hoisted(() => {
  const redisStore = new Map<string, string>();
  const fakeRedis = {
    set: async (key: string, value: string, ...args: unknown[]) => {
      if (args.includes("NX") && redisStore.has(key)) return null;
      redisStore.set(key, value);
      return "OK";
    },
  };
  return { redisStore, fakeRedis };
});

vi.mock("@/lib/session-blacklist", () => ({
  getSharedRedis: vi.fn(),
}));

import {
  isAltchaEnabled,
  createAltchaChallenge,
  verifyAltchaPayload,
} from "@/lib/altcha";
import { getSharedRedis } from "@/lib/session-blacklist";

interface TestChallenge {
  algorithm: string;
  challenge: string;
  salt: string;
  signature: string;
  maxnumber?: number;
}

// ALTCHA PoW 求解器（与官方 widget 同算法）：遍历 number，sha256(salt+number)
// 的 hex 与 challenge 相等即为解。小 maxNumber 下瞬时完成。
async function solve(ch: TestChallenge): Promise<number> {
  const encoder = new TextEncoder();
  const toHex = (buf: ArrayBuffer) =>
    [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const max = ch.maxnumber ?? 1e6;
  for (let n = 0; n <= max; n++) {
    const digest = await crypto.subtle.digest(ch.algorithm, encoder.encode(ch.salt + n));
    if (toHex(digest) === ch.challenge) return n;
  }
  throw new Error("no solution found within maxnumber");
}

// 与前端 widget 一致的 payload 构造：JSON → base64。
function buildPayload(ch: TestChallenge, number: number): string {
  return btoa(
    JSON.stringify({
      algorithm: ch.algorithm,
      challenge: ch.challenge,
      number,
      salt: ch.salt,
      signature: ch.signature,
    }),
  );
}

describe("lib/altcha（未配置 ALTCHA_SECRET → 停用）", () => {
  beforeEach(() => {
    // 显式钉死未配置，避免本地 .env 配了 ALTCHA_SECRET 时本组用例挂掉
    vi.stubEnv("ALTCHA_SECRET", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("isAltchaEnabled() === false", () => {
    expect(isAltchaEnabled()).toBe(false);
  });

  it("createAltchaChallenge() 返回 null", async () => {
    expect(await createAltchaChallenge()).toBeNull();
  });

  it("verifyAltchaPayload() fail-open 返回 true（防配置缺失锁死登录）", async () => {
    expect(await verifyAltchaPayload("garbage")).toBe(true);
    expect(await verifyAltchaPayload(undefined)).toBe(true);
  });
});

describe("lib/altcha（已配置 ALTCHA_SECRET）", () => {
  beforeEach(() => {
    vi.stubEnv("ALTCHA_SECRET", "0123456789abcdef0123456789abcdef");
    redisStore.clear();
    vi.mocked(getSharedRedis).mockImplementation(() => fakeRedis as unknown as Redis);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(getSharedRedis).mockReset();
  });

  it("isAltchaEnabled() === true", () => {
    expect(isAltchaEnabled()).toBe(true);
  });

  it("createAltchaChallenge() 返回完整挑战字段（expires 以参数形式嵌入 salt）", async () => {
    const ch = (await createAltchaChallenge(100)) as TestChallenge;
    expect(ch.algorithm).toBe("SHA-256");
    expect(ch.challenge).toMatch(/^[0-9a-f]{64}$/);
    expect(ch.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof ch.salt).toBe("string");
    // altcha-lib v1 无独立 expires 字段：有效期编码进 salt 的 query 参数
    expect(ch.salt).toContain("expires=");
  });

  it("真往返：求解挑战 → payload 校验通过", async () => {
    const ch = (await createAltchaChallenge(100)) as TestChallenge;
    const number = await solve(ch);
    const payload = buildPayload(ch, number);
    expect(await verifyAltchaPayload(payload)).toBe(true);
  });

  it("同一 payload 二次校验被拒（Redis 一次性消费防重放）", async () => {
    const ch = (await createAltchaChallenge(100)) as TestChallenge;
    const payload = buildPayload(ch, await solve(ch));
    expect(await verifyAltchaPayload(payload)).toBe(true);
    expect(await verifyAltchaPayload(payload)).toBe(false);
  });

  it("篡改 payload（number +1）→ 校验失败", async () => {
    const ch = (await createAltchaChallenge(100)) as TestChallenge;
    const number = await solve(ch);
    const tampered = buildPayload(ch, number + 1);
    expect(await verifyAltchaPayload(tampered)).toBe(false);
  });

  it("过期挑战（salt 内 expires 已失效）→ 校验失败", async () => {
    // 直接用 altcha-lib 签发一个已过期的挑战，验证 checkExpires 路径
    const expired = await createChallenge({
      hmacKey: "0123456789abcdef0123456789abcdef",
      maxNumber: 100,
      expires: new Date(Date.now() - 1000),
    });
    const payload = buildPayload(expired as TestChallenge, await solve(expired as TestChallenge));
    expect(await verifyAltchaPayload(payload)).toBe(false);
  });

  it("非 base64-JSON 的纯文本 → 校验失败", async () => {
    expect(await verifyAltchaPayload("hello, this is not a payload!!!")).toBe(false);
  });

  it("非 string 类型 → 校验失败", async () => {
    expect(await verifyAltchaPayload(undefined)).toBe(false);
    expect(await verifyAltchaPayload(null)).toBe(false);
    expect(await verifyAltchaPayload(42)).toBe(false);
    expect(await verifyAltchaPayload({ number: 1 })).toBe(false);
  });

  it("无 Redis 时跳过重放消费仍可验证通过（warn-once 提示防重放降级）", async () => {
    vi.mocked(getSharedRedis).mockReturnValue(null);
    const ch = (await createAltchaChallenge(100)) as TestChallenge;
    const payload = buildPayload(ch, await solve(ch));
    expect(await verifyAltchaPayload(payload)).toBe(true);
  });
});
