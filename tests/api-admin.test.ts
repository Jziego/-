import { describe, expect, it, vi, beforeEach } from "vitest";

const { codesMock, adjustMock, ledgerMock, assertAdminRequestMock, rateLimitAdminIpMock } = vi.hoisted(() => ({
  codesMock: vi.fn(),
  adjustMock: vi.fn(),
  ledgerMock: vi.fn(),
  assertAdminRequestMock: vi.fn(),
  rateLimitAdminIpMock: vi.fn(),
}));

vi.mock("@/lib/admin-auth", () => ({
  assertAdminRequest: assertAdminRequestMock,
  AdminAuthError: class AdminAuthError extends Error {
    status = 401;
  },
}));
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return { ...actual, rateLimitAdminIp: rateLimitAdminIpMock };
});
vi.mock("@/lib/points", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/points")>();
  return {
    ...actual,
    generateRechargeCodes: codesMock,
    adminAdjustPoints: adjustMock,
    getAdminLedgerByEmail: ledgerMock,
    MAX_CODES_PER_BATCH: 500,
  };
});

import { POST as codesPOST } from "@/app/api/admin/codes/route";
import { POST as adjustPOST } from "@/app/api/admin/adjust/route";
import { GET as ledgerGET } from "@/app/api/admin/ledger/route";

describe("admin routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assertAdminRequestMock.mockImplementation(() => {});
    rateLimitAdminIpMock.mockResolvedValue(true);
  });

  it("批量生成：成功返回码列表（201）", async () => {
    codesMock.mockResolvedValue(["AAAA-BBBB-CCCC-DDDD"]);
    const ok = await codesPOST(
      new Request("http://localhost/api/admin/codes", {
        method: "POST",
        body: JSON.stringify({ points: 100, count: 1 }),
      }),
    );
    expect(ok.status).toBe(201);
    expect(await ok.json()).toEqual({ codes: ["AAAA-BBBB-CCCC-DDDD"] });
    expect(codesMock).toHaveBeenCalledWith(100, 1);
  });

  it("批量生成：数量/面值越界 → 400", async () => {
    const tooMany = await codesPOST(
      new Request("http://localhost/api/admin/codes", {
        method: "POST",
        body: JSON.stringify({ points: 100, count: 501 }),
      }),
    );
    expect(tooMany.status).toBe(400);
    const badPoints = await codesPOST(
      new Request("http://localhost/api/admin/codes", {
        method: "POST",
        body: JSON.stringify({ points: 0, count: 10 }),
      }),
    );
    expect(badPoints.status).toBe(400);
    const nonInteger = await codesPOST(
      new Request("http://localhost/api/admin/codes", {
        method: "POST",
        body: JSON.stringify({ points: 10.5, count: 10 }),
      }),
    );
    expect(nonInteger.status).toBe(400);
    expect(codesMock).not.toHaveBeenCalled();
  });

  it("批量生成：JSON body 为 null → 400", async () => {
    const res = await codesPOST(
      new Request("http://localhost/api/admin/codes", {
        method: "POST",
        body: "null",
      }),
    );
    expect(res.status).toBe(400);
    expect(codesMock).not.toHaveBeenCalled();
  });

  it("密钥校验失败 → 401（AdminAuthError 状态码透传）", async () => {
    const { AdminAuthError } = await import("@/lib/admin-auth");
    assertAdminRequestMock.mockImplementationOnce(() => {
      throw new AdminAuthError(401);
    });
    const res = await codesPOST(
      new Request("http://localhost/api/admin/codes", {
        method: "POST",
        body: JSON.stringify({ points: 100, count: 1 }),
      }),
    );
    expect(res.status).toBe(401);
    expect(codesMock).not.toHaveBeenCalled();
  });

  it("admin IP 限流 → 429", async () => {
    rateLimitAdminIpMock.mockResolvedValueOnce(false);
    const res = await codesPOST(
      new Request("http://localhost/api/admin/codes", {
        method: "POST",
        body: JSON.stringify({ points: 100, count: 1 }),
      }),
    );
    expect(res.status).toBe(429);
    expect(codesMock).not.toHaveBeenCalled();
  });

  it("手动调整：透传 email/delta/note，成功返回余额", async () => {
    adjustMock.mockResolvedValue({ email: "a@b.com", balance: 500 });
    const res = await adjustPOST(
      new Request("http://localhost/api/admin/adjust", {
        method: "POST",
        body: JSON.stringify({ email: "a@b.com", delta: 500, note: "微信收款50元" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(adjustMock).toHaveBeenCalledWith("a@b.com", 500, "微信收款50元");
  });

  it("手动调整：用户不存在 → 404；非法 delta → 400", async () => {
    const { UserNotFoundError, AdminAdjustError } = await import("@/lib/points");
    adjustMock.mockRejectedValueOnce(new UserNotFoundError());
    const missing = await adjustPOST(
      new Request("http://localhost/api/admin/adjust", {
        method: "POST",
        body: JSON.stringify({ email: "ghost@x.com", delta: 10 }),
      }),
    );
    expect(missing.status).toBe(404);

    adjustMock.mockRejectedValueOnce(new AdminAdjustError("扣减后余额不能为负"));
    const bad = await adjustPOST(
      new Request("http://localhost/api/admin/adjust", {
        method: "POST",
        body: JSON.stringify({ email: "a@b.com", delta: -9999 }),
      }),
    );
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toContain("不能为负");
  });

  it("流水查询：归一化邮箱后调服务、默认 limit 50", async () => {
    ledgerMock.mockResolvedValue({ email: "a@b.com", entries: [{ id: "pl1", delta: 100 }] });
    const res = await ledgerGET(
      new Request("http://localhost/api/admin/ledger?email=A%40b.com"),
    );
    expect(res.status).toBe(200);
    expect(ledgerMock).toHaveBeenCalledWith("a@b.com", 50);
    expect((await res.json()).entries).toHaveLength(1);
  });

  it("流水查询：limit 上限钳制 200；用户不存在 → 404；缺 email → 400", async () => {
    ledgerMock.mockResolvedValue({ email: "a@b.com", entries: [] });
    const clamped = await ledgerGET(
      new Request("http://localhost/api/admin/ledger?email=a%40b.com&limit=999"),
    );
    expect(clamped.status).toBe(200);
    expect(ledgerMock).toHaveBeenCalledWith("a@b.com", 200);

    const { UserNotFoundError } = await import("@/lib/points");
    ledgerMock.mockRejectedValueOnce(new UserNotFoundError());
    const missing = await ledgerGET(
      new Request("http://localhost/api/admin/ledger?email=nobody%40x.com"),
    );
    expect(missing.status).toBe(404);

    const noEmail = await ledgerGET(new Request("http://localhost/api/admin/ledger"));
    expect(noEmail.status).toBe(400);
  });
});
