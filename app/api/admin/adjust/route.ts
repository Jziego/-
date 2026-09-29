import { jsonError, jsonOk } from "@/lib/api-response";
import { AdminAuthError, assertAdminRequest } from "@/lib/admin-auth";
import {
  AdminAdjustError,
  PointsUnavailableError,
  UserNotFoundError,
  adminAdjustPoints,
} from "@/lib/points";
import { getClientIp, rateLimitAdminIp } from "@/lib/rate-limit";

export async function POST(request: Request) {
  try {
    assertAdminRequest(request);
  } catch (error) {
    if (error instanceof AdminAuthError) return jsonError(error.message, error.status);
    throw error;
  }
  if (!(await rateLimitAdminIp(getClientIp(request.headers)))) {
    return jsonError("请求过于频繁，请稍后再试", 429);
  }

  let body: { email?: unknown; delta?: unknown; note?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonError("Request body must be valid JSON", 400);
  }
  if (body === null || typeof body !== "object") {
    return jsonError("Request body must be a JSON object", 400);
  }
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 200) : "";
  const delta = body.delta;
  if (!email || !Number.isInteger(delta) || (delta as number) === 0) {
    return jsonError("email and a non-zero integer delta are required", 400);
  }

  try {
    const result = await adminAdjustPoints(email, delta as number, note);
    return jsonOk(result);
  } catch (error) {
    if (error instanceof UserNotFoundError) return jsonError(error.message, 404);
    if (error instanceof AdminAdjustError) return jsonError(error.message, 400);
    if (error instanceof PointsUnavailableError) return jsonError(error.message, 503);
    throw error;
  }
}
