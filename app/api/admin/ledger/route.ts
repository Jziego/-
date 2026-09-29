import { jsonError, jsonOk } from "@/lib/api-response";
import { AdminAuthError, assertAdminRequest } from "@/lib/admin-auth";
import {
  PointsUnavailableError,
  UserNotFoundError,
  getAdminLedgerByEmail,
} from "@/lib/points";
import { getClientIp, rateLimitAdminIp } from "@/lib/rate-limit";

const MAX_LIMIT = 200;

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

  const url = new URL(request.url);
  const email = (url.searchParams.get("email") ?? "").trim().toLowerCase();
  if (!email) return jsonError("email is required", 400);
  const limitParam = url.searchParams.get("limit");
  const limitRaw = Number(limitParam === null || limitParam === "" ? "50" : limitParam);
  const limit = Number.isInteger(limitRaw)
    ? Math.min(Math.max(1, limitRaw), MAX_LIMIT)
    : 50;

  try {
    const result = await getAdminLedgerByEmail(email, limit);
    return jsonOk(result);
  } catch (error) {
    if (error instanceof UserNotFoundError) return jsonError(error.message, 404);
    if (error instanceof PointsUnavailableError) return jsonError(error.message, 503);
    throw error;
  }
}
