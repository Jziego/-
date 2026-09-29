import { timingSafeEqual } from "node:crypto";
import { getAdminKey } from "@/lib/env";

export class AdminAuthError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(status === 503 ? "Admin not configured" : "Unauthorized");
    this.name = "AdminAuthError";
    this.status = status;
  }
}

/**
 * 后台接口鉴权：x-admin-key 头 vs 环境变量 ADMIN_KEY（timingSafeEqual 防时序侧信道）。
 * ADMIN_KEY 未配置 → 503（部署遗漏的显式信号）；不匹配 → 401。
 */
export function assertAdminRequest(request: Request): void {
  const expected = getAdminKey();
  if (!expected) throw new AdminAuthError(503);
  const provided = request.headers.get("x-admin-key") ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new AdminAuthError(401);
  }
}
