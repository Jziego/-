import { createHash } from "node:crypto";
import { createChallenge, verifySolution } from "altcha-lib/v1";
import type { Challenge } from "altcha-lib/v1/types";
import { getAltchaSecret } from "@/lib/env";
import { getSharedRedis } from "@/lib/session-blacklist";

// Altcha（MIT 开源 PoW 人机验证）服务端：挑战签发 + 解答校验 + 一次性消费防重放。
// 用于登录发信等未认证端点的脚本刷量防护。整体 fail-open 口径：未配置
// ALTCHA_SECRET 时验证直接放行并告警，避免配置缺失锁死登录链路。

/** 挑战有效期（秒）：altcha-lib v1 的 expires 选项是 Date，无 expiresInSeconds。 */
const CHALLENGE_TTL_SECONDS = 300;
/** 已消费 payload 的 Redis 标记 TTL（毫秒），与挑战有效期对齐。 */
const USED_PAYLOAD_TTL_MS = CHALLENGE_TTL_SECONDS * 1000;

let warnedDisabled = false;
let warnedNoRedis = false;

export function isAltchaEnabled(): boolean {
  return Boolean(getAltchaSecret());
}

/**
 * 签发 PoW 挑战。未启用时返回 null。
 * expires 经 salt query 参数嵌入挑战（altcha-lib v1 无独立 expires 字段），
 * verifySolution(checkExpires=true) 校验时从 salt 解析。
 */
export async function createAltchaChallenge(
  maxNumber = 200_000,
): Promise<Challenge | null> {
  const secret = getAltchaSecret();
  if (!secret) return null;
  return createChallenge({
    hmacKey: secret,
    maxNumber,
    expires: new Date(Date.now() + CHALLENGE_TTL_SECONDS * 1000),
  });
}

/**
 * 校验前端回传的 payload（base64-JSON）。
 * - 未启用：warn-once 后放行（fail-open，防配置缺失锁死登录）；
 * - 非 string / 非法 payload / 签名不符 / 过期：false；
 * - 通过后有 Redis 时做一次性消费：SET altcha:used:<sha256> NX PX，
 *   已存在（重放）→ false；无 Redis 时跳过（warn-once 提示防重放降级）。
 * 永不打印 secret。
 */
export async function verifyAltchaPayload(payload: unknown): Promise<boolean> {
  const secret = getAltchaSecret();
  if (!secret) {
    if (!warnedDisabled) {
      warnedDisabled = true;
      console.warn(
        "[altcha] ALTCHA_SECRET 未配置，人机验证已停用（fail-open 放行）",
      );
    }
    return true;
  }
  if (typeof payload !== "string") return false;

  // verifySolution 内部对非 base64-JSON 字符串已 catch 返回 false
  if (!(await verifySolution(payload, secret, true))) return false;

  // 一次性消费防重放：合法解答只能兑现一次，脚本截获 payload 后无法复用。
  const redis = getSharedRedis();
  if (!redis) {
    if (!warnedNoRedis) {
      warnedNoRedis = true;
      console.warn(
        "[altcha] Redis 不可用，跳过 payload 一次性消费——防重放降级（challenge 过期校验仍生效）",
      );
    }
    return true;
  }
  const digest = createHash("sha256").update(payload).digest("hex");
  try {
    const result = await redis.set(
      `altcha:used:${digest}`,
      "1",
      "PX",
      USED_PAYLOAD_TTL_MS,
      "NX",
    );
    return result === "OK";
  } catch (err) {
    // Redis 抖动 fail-open（与 session-blacklist 同口径）：宁可放过重放窗口，
    // 也不让登录链路因基础设施故障整体不可用。
    console.warn(
      "[altcha] payload 消费标记写入失败，fail-open:",
      err instanceof Error ? err.message : String(err),
    );
    return true;
  }
}
