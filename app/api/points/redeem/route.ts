import { jsonError, jsonOk } from "@/lib/api-response";
import { applyRateLimit, getClientIp, rateLimitRedeem } from "@/lib/rate-limit";
import { getOwnerId } from "@/lib/auth-helpers";
import { InvalidRedeemCodeError, PointsUnavailableError, redeemPointsCode } from "@/lib/points";

export async function POST(request: Request) {
  let body: { code?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonError("Request body must be valid JSON", 400);
  }
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!code) return jsonError("code is required", 400);

  const ownerId = await getOwnerId();
  const limited = await applyRateLimit(request, ownerId);
  if (limited) return limited;

  // 专项爆破限流（L2 通用写桶之外再加 owner/IP 双窗口）
  if (!(await rateLimitRedeem(ownerId, getClientIp(request.headers)))) {
    return Response.json(
      { error: "rate_limited", message: "尝试过于频繁，请稍后再试", retryAfter: 60 },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }

  try {
    const result = await redeemPointsCode(ownerId, code);
    return jsonOk(result);
  } catch (error) {
    if (error instanceof InvalidRedeemCodeError) return jsonError(error.message, 400);
    if (error instanceof PointsUnavailableError) return jsonError(error.message, 503);
    throw error;
  }
}
