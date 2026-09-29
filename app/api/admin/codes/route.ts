import { jsonError, jsonOk } from "@/lib/api-response";
import { AdminAuthError, assertAdminRequest } from "@/lib/admin-auth";
import { MAX_CODES_PER_BATCH, PointsUnavailableError, generateRechargeCodes } from "@/lib/points";
import { rateLimitAdminIp, getClientIp } from "@/lib/rate-limit";

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

  let body: { points?: unknown; count?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonError("Request body must be valid JSON", 400);
  }
  if (body === null || typeof body !== "object") {
    return jsonError("Request body must be a JSON object", 400);
  }
  const points = body.points;
  const count = body.count;
  if (!Number.isInteger(points) || (points as number) <= 0 || (points as number) > 100000) {
    return jsonError("points must be an integer in (0, 100000]", 400);
  }
  if (!Number.isInteger(count) || (count as number) <= 0 || (count as number) > MAX_CODES_PER_BATCH) {
    return jsonError(`count must be an integer in (0, ${MAX_CODES_PER_BATCH}]`, 400);
  }

  try {
    const codes = await generateRechargeCodes(points as number, count as number);
    return jsonOk({ codes }, 201);
  } catch (error) {
    if (error instanceof PointsUnavailableError) return jsonError(error.message, 503);
    throw error;
  }
}
