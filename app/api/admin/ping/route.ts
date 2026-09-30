import { jsonError, jsonOk } from "@/lib/api-response";
import { AdminAuthError, assertAdminRequest } from "@/lib/admin-auth";
import { rateLimitAdminIp, getClientIp } from "@/lib/rate-limit";

/** 管理后台密钥探活：/admin 进门时验证密钥是否正确，只有 200 才放行工作台。 */
export async function GET(request: Request) {
  try {
    assertAdminRequest(request);
  } catch (error) {
    if (error instanceof AdminAuthError) return jsonError(error.message, error.status);
    throw error;
  }
  if (!(await rateLimitAdminIp(getClientIp(request.headers)))) {
    return jsonError("请求过于频繁，请稍后再试", 429);
  }
  return jsonOk({ ok: true });
}
