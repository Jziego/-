import { headers } from "next/headers";
import { jsonError, jsonOk, jsonRateLimited } from "@/lib/api-response";
import { createAltchaChallenge, isAltchaEnabled } from "@/lib/altcha";
import { getClientIp, rateLimitAltchaChallenge } from "@/lib/rate-limit";

/**
 * GET /api/altcha/challenge — 签发 Altcha PoW 挑战（登录发信等人机验证用）。
 * 公开端点（middleware 放行），靠路由内 IP 限流（30/min）防挑战预囤。
 */
export async function GET() {
  // 未配置 ALTCHA_SECRET 时整体停用：与 /api/health 同口径对外表现为不存在
  if (!isAltchaEnabled()) return jsonError("not_found", 404);

  const headersList = await headers();
  const ip = getClientIp(headersList);
  if (!(await rateLimitAltchaChallenge(ip))) {
    // 布尔限流无法提供真实 reset：按窗口上限合成 RateLimitResult 走标准 429
    const reset = Math.floor(Date.now() / 1000) + 60;
    return jsonRateLimited({ allowed: false, remaining: 0, reset });
  }

  const challenge = await createAltchaChallenge();
  if (!challenge) return jsonError("not_found", 404);

  const res = jsonOk(challenge);
  // 挑战一次性且含时效，必须禁缓存保证每次领取唯一
  res.headers.set("Cache-Control", "no-store");
  return res;
}
