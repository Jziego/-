import { describe, expect, it, vi, beforeEach } from "vitest";

const { getOwnerIdMock, redeemMock, balanceMock, rateLimitRedeemMock } = vi.hoisted(() => ({
  getOwnerIdMock: vi.fn(),
  redeemMock: vi.fn(),
  balanceMock: vi.fn(),
  rateLimitRedeemMock: vi.fn(),
}));

vi.mock("@/lib/auth-helpers", () => ({ getOwnerId: getOwnerIdMock }));
vi.mock("@/lib/points", () => ({
  redeemPointsCode: redeemMock,
  getPointsBalance: balanceMock,
  InvalidRedeemCodeError: class InvalidRedeemCodeError extends Error {
    constructor() {
      super("兑换码无效或已被使用");
      this.name = "InvalidRedeemCodeError";
    }
  },
  PointsUnavailableError: class PointsUnavailableError extends Error {
    constructor() {
      super("积分功能未启用");
      this.name = "PointsUnavailableError";
    }
  },
}));
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return {
    ...actual,
    applyRateLimit: vi.fn(() => Promise.resolve(null)),
    rateLimitRedeem: rateLimitRedeemMock,
  };
});

import { GET as pointsGET } from "@/app/api/points/route";
import { POST as redeemPOST } from "@/app/api/points/redeem/route";

describe("GET /api/points", () => {
  beforeEach(() => vi.clearAllMocks());

  it("返回余额", async () => {
    getOwnerIdMock.mockResolvedValue("u1");
    balanceMock.mockResolvedValue(230);
    const res = await pointsGET(new Request("http://localhost/api/points"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ balance: 230 });
  });
});

describe("POST /api/points/redeem", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rateLimitRedeemMock.mockResolvedValue(true);
  });

  it("兑换成功返回积分与余额", async () => {
    getOwnerIdMock.mockResolvedValue("u1");
    redeemMock.mockResolvedValue({ points: 100, balance: 330 });
    const res = await redeemPOST(
      new Request("http://localhost/api/points/redeem", {
        method: "POST",
        body: JSON.stringify({ code: "ABCD-EFGH-JKLM-NPQR" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ points: 100, balance: 330 });
    expect(redeemMock).toHaveBeenCalledWith("u1", "ABCD-EFGH-JKLM-NPQR");
  });

  it("非 JSON body → 400；缺 code → 400", async () => {
    getOwnerIdMock.mockResolvedValue("u1");
    const bad = await redeemPOST(
      new Request("http://localhost/api/points/redeem", { method: "POST", body: "not-json" }),
    );
    expect(bad.status).toBe(400);
    const missing = await redeemPOST(
      new Request("http://localhost/api/points/redeem", { method: "POST", body: "{}" }),
    );
    expect(missing.status).toBe(400);
  });

  it("无效/已使用码 → 400（用户可见中文消息）", async () => {
    getOwnerIdMock.mockResolvedValue("u1");
    const { InvalidRedeemCodeError } = await import("@/lib/points");
    redeemMock.mockRejectedValue(new InvalidRedeemCodeError());
    const res = await redeemPOST(
      new Request("http://localhost/api/points/redeem", {
        method: "POST",
        body: JSON.stringify({ code: "USED-CODE-0000-0000" }),
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("兑换码");
  });

  it("专项限流触发 → 429（rate_limited 机器码 + Retry-After 头）", async () => {
    getOwnerIdMock.mockResolvedValue("u1");
    rateLimitRedeemMock.mockResolvedValue(false);
    const res = await redeemPOST(
      new Request("http://localhost/api/points/redeem", {
        method: "POST",
        body: JSON.stringify({ code: "AAAA-BBBB-CCCC-DDDD" }),
      }),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    const body = await res.json();
    expect(body.error).toBe("rate_limited");
    expect(body.message).toContain("稍后再试");
    expect(redeemMock).not.toHaveBeenCalled(); // 限流在兑换之前短路
  });

  it("限流以 ownerId + 客户端 IP 为维度", async () => {
    getOwnerIdMock.mockResolvedValue("u1");
    await redeemPOST(
      new Request("http://localhost/api/points/redeem", {
        method: "POST",
        body: JSON.stringify({ code: "AAAA-BBBB-CCCC-DDDD" }),
        headers: { "x-forwarded-for": "2.2.2.2" },
      }),
    );
    expect(rateLimitRedeemMock).toHaveBeenCalledWith("u1", "2.2.2.2");
  });
});
