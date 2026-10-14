import { describe, it, expect, vi, beforeEach } from "vitest";

// `@/auth` pulls in next-auth which needs next/server — mock it out for jsdom.
// vi.hoisted lets the factory reference the mock safely (vi.mock is hoisted).
const { signInMock } = vi.hoisted(() => ({ signInMock: vi.fn() }));
vi.mock("@/auth", () => ({
  signIn: signInMock,
  signOut: vi.fn(),
  auth: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({
  rateLimitLogin: vi.fn().mockResolvedValue(true),
  getClientIp: vi.fn().mockReturnValue("127.0.0.1"),
}));

// Altcha 整体 mock：不加载真实 altcha-lib/ioredis，用开关模拟启用状态
const { isAltchaEnabledMock, verifyAltchaPayloadMock } = vi.hoisted(() => ({
  isAltchaEnabledMock: vi.fn(),
  verifyAltchaPayloadMock: vi.fn(),
}));
vi.mock("@/lib/altcha", () => ({
  isAltchaEnabled: isAltchaEnabledMock,
  verifyAltchaPayload: verifyAltchaPayloadMock,
}));

// session-blacklist imports ioredis; stub it so module evaluation stays hermetic.
vi.mock("@/lib/session-blacklist", () => ({
  revokeSession: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

import { sendMagicLink } from "@/app/login/actions";
import { rateLimitLogin } from "@/lib/rate-limit";

describe("sendMagicLink", () => {
  beforeEach(() => {
    signInMock.mockReset();
    signInMock.mockResolvedValue(undefined);
    // 默认未启用 Altcha：原有用例行为不变
    isAltchaEnabledMock.mockReset().mockReturnValue(false);
    verifyAltchaPayloadMock.mockReset().mockResolvedValue(true);
  });

  it("sends the magic-link with redirect:false so the client drives navigation to /login/verify?email=... (NextAuth's default verifyRequest page drops the email, which the OTP page needs)", async () => {
    await sendMagicLink("owner@example.com");

    expect(signInMock).toHaveBeenCalledWith(
      "email",
      expect.objectContaining({ email: "owner@example.com", redirect: false })
    );
  });

  it("keeps the generic success message for malformed emails and never calls the provider (anti-enumeration)", async () => {
    const result = await sendMagicLink("not-an-email");

    expect(result).toEqual({ success: true, message: "若邮箱存在，我们会发送邮件" });
    expect(signInMock).not.toHaveBeenCalled();
  });

  it("keeps the generic success message when rate-limited (anti-enumeration)", async () => {
    vi.mocked(rateLimitLogin).mockResolvedValueOnce(false);

    const result = await sendMagicLink("user@example.com");

    expect(result).toEqual({ success: true, message: "若邮箱存在，我们会发送邮件" });
    expect(signInMock).not.toHaveBeenCalled();
  });

  it("throws when NextAuth resolves ok:false (redirect:false send failures don't throw), so callers can surface a retry hint", async () => {
    signInMock.mockResolvedValue({ ok: false, error: "EmailSendFailed" });

    await expect(sendMagicLink("owner@example.com")).rejects.toThrow("send failed");
  });

  it("returns the generic success message when the send succeeds", async () => {
    signInMock.mockResolvedValue({ ok: true });

    const result = await sendMagicLink("owner@example.com");

    expect(result).toEqual({ success: true, message: "若邮箱存在，我们会发送邮件" });
  });

  describe("Altcha 人机验证", () => {
    it("启用且 payload 无效 → success:false 且不发信（不消耗 L1 限流额度）", async () => {
      isAltchaEnabledMock.mockReturnValue(true);
      verifyAltchaPayloadMock.mockResolvedValue(false);
      // rateLimitLogin 的模块级 mock 跨用例累计调用，先清零再断言
      vi.mocked(rateLimitLogin).mockClear();

      const result = await sendMagicLink("owner@example.com", "bad-payload");

      expect(result).toEqual({ success: false, message: "人机验证未通过，请刷新后重试" });
      expect(verifyAltchaPayloadMock).toHaveBeenCalledWith("bad-payload");
      expect(signInMock).not.toHaveBeenCalled();
      expect(rateLimitLogin).not.toHaveBeenCalled();
    });

    it("启用且 payload 有效 → 正常发信", async () => {
      isAltchaEnabledMock.mockReturnValue(true);
      verifyAltchaPayloadMock.mockResolvedValue(true);

      const result = await sendMagicLink("owner@example.com", "valid-payload");

      expect(result.success).toBe(true);
      expect(signInMock).toHaveBeenCalledWith(
        "email",
        expect.objectContaining({ email: "owner@example.com", redirect: false })
      );
    });

    it("未启用 → 忽略 payload 直接发信", async () => {
      isAltchaEnabledMock.mockReturnValue(false);

      const result = await sendMagicLink("owner@example.com", "whatever");

      expect(result.success).toBe(true);
      expect(verifyAltchaPayloadMock).not.toHaveBeenCalled();
      expect(signInMock).toHaveBeenCalled();
    });
  });
});
