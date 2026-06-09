import { handleRouteError } from "@/lib/api-errors";
import { jsonOk } from "@/lib/api-response";
import { getAppMode, hasDatabase } from "@/lib/env";

export async function GET() {
  try {
    const checks = {
      database: hasDatabase() ? "configured" : "missing",
      redis: process.env.REDIS_URL ? "configured" : "missing"
    };
    const degraded = checks.database === "missing";

    return jsonOk({
      status: degraded ? "degraded" : "ok",
      mode: getAppMode(),
      checks,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    return handleRouteError("Health check failed", error);
  }
}
