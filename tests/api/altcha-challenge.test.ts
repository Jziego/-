import { describe, it, expect, vi, beforeEach } from "vitest";

// mock 方式仿 tests/api-admin.test.ts：lib 层函数用 vi.hoisted 占位，
// rate-limit 用 importOriginal 保留真实的 getClientIp / ratelimitHeaders。
const { isAltchaEnabledMock, createAltchaChallengeMock, rateLimitAltchaChallengeMock } =
  vi.hoisted(() => ({
    isAltchaEnabledMock: vi.fn(),
    createAltchaChallengeMock: vi.fn(),
    rateLimitAltchaChallengeMock: vi.fn(),
  }));

vi.mock("@/lib/altcha", () => ({
  isAltchaEnabled: isAltchaEnabledMock,
  createAltchaChallenge: createAltchaChallengeMock,
}));

vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return { ...actual, rateLimitAltchaChallenge: rateLimitAltchaChallengeMock };
});

import { GET } from "@/app/api/altcha/challenge/route";
import { headers } from "next/headers";

const CHALLENGE = {
  algorithm: "SHA-256",
  challenge: "a".repeat(64),
  salt: "deadbeef?expires=1893456000&",
  signature: "b".repeat(64),
  maxnumber: 200000,
};

describe("GET /api/altcha/challenge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isAltchaEnabledMock.mockReturnValue(true);
    createAltchaChallengeMock.mockResolvedValue(CHALLENGE);
    rateLimitAltchaChallengeMock.mockResolvedValue(true);
    // vitest.setup 的全局 headers mock 返回空 Headers；补上 x-forwarded-for 以校验 IP 传递
    vi.mocked(headers).mockResolvedValue(
      new Headers({ "x-forwarded-for": "203.0.113.7" }),
    );
  });

  it("未启用（ALTCHA_SECRET 缺失）→ 404 not_found", async () => {
    isAltchaEnabledMock.mockReturnValue(false);
    const res = await GET();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(createAltchaChallengeMock).not.toHaveBeenCalled();
  });

  it("IP 限流不过 → 429 且带限流响应头，不签发挑战", async () => {
    rateLimitAltchaChallengeMock.mockResolvedValue(false);
    const res = await GET();
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
    expect(rateLimitAltchaChallengeMock).toHaveBeenCalledWith("203.0.113.7");
    expect(createAltchaChallengeMock).not.toHaveBeenCalled();
  });

  it("成功 → 200 返回挑战且显式 Cache-Control: no-store（挑战必须每次唯一）", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(CHALLENGE);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(rateLimitAltchaChallengeMock).toHaveBeenCalledWith("203.0.113.7");
  });
});
