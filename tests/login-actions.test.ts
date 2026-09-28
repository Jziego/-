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
});
