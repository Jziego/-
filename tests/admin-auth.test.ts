import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

describe("assertAdminRequest", () => {
  beforeEach(() => vi.stubEnv("ADMIN_KEY", "super-secret"));
  afterEach(() => vi.unstubAllEnvs());

  it("未配置 ADMIN_KEY → AdminAuthError(503)", async () => {
    vi.stubEnv("ADMIN_KEY", "");
    const { assertAdminRequest, AdminAuthError } = await import("@/lib/admin-auth");
    let caught: unknown;
    try {
      assertAdminRequest(new Request("http://x/"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AdminAuthError);
    expect((caught as { status: number }).status).toBe(503);
  });

  it("密钥缺失或错误 → AdminAuthError(401)", async () => {
    const { assertAdminRequest, AdminAuthError } = await import("@/lib/admin-auth");
    let caught: unknown;
    try {
      assertAdminRequest(new Request("http://x/"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AdminAuthError);
    expect((caught as { status: number }).status).toBe(401);

    let caught2: unknown;
    try {
      assertAdminRequest(new Request("http://x/", { headers: { "x-admin-key": "wrong" } }));
    } catch (error) {
      caught2 = error;
    }
    expect(caught2).toBeInstanceOf(AdminAuthError);
    expect((caught2 as { status: number }).status).toBe(401);
  });

  it("等长但错误的密钥也 → 401（覆盖 timingSafeEqual false 分支）", async () => {
    const { assertAdminRequest, AdminAuthError } = await import("@/lib/admin-auth");
    let caught: unknown;
    try {
      assertAdminRequest(
        new Request("http://x/", { headers: { "x-admin-key": "xuper-secret" } }),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AdminAuthError);
    expect((caught as { status: number }).status).toBe(401);
  });

  it("密钥正确 → 通过", async () => {
    const { assertAdminRequest } = await import("@/lib/admin-auth");
    expect(() =>
      assertAdminRequest(
        new Request("http://x/", { headers: { "x-admin-key": "super-secret" } }),
      ),
    ).not.toThrow();
  });
});
