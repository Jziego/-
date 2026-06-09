import { jsonOk } from "@/lib/api-response";
import { getAppMode, hasDatabase, hasObjectStorage } from "@/lib/env";

export async function GET() {
  const checks = {
    database: hasDatabase() ? "configured" : "missing",
    redis: process.env.REDIS_URL ? "configured" : "missing",
    objectStorage: hasObjectStorage() ? "configured" : "missing"
  };

  const degraded =
    checks.database === "missing" ||
    (getAppMode() === "production" && checks.objectStorage === "missing");

  return jsonOk({
    status: degraded ? "degraded" : "ok",
    mode: getAppMode(),
    checks,
    timestamp: new Date().toISOString()
  });
}
