import { randomInt } from "node:crypto";

/**
 * 6 位数字邮箱验证码（前导零保留）。
 * crypto.randomInt 均匀分布 [0, 1e6)；爆破防护不在此处——
 * 见 middleware 对 /api/auth/callback/email 的尝试限流（rateLimitOtpAttempt）。
 */
export function generateOtpCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}
