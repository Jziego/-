import { describe, expect, it, vi, beforeEach } from "vitest";

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: sendMock };
  },
}));

vi.mock("@/lib/env", () => ({
  getResendApiKey: () => "re_test_key",
  getEmailFrom: () => "AI短视频助手 <noreply@resend.dev>",
}));

import { sendOtpViaResend } from "@/lib/auth/resend-send";

describe("sendOtpViaResend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves when Resend accepts the email", async () => {
    sendMock.mockResolvedValue({ data: { id: "e_1" }, error: null });
    await expect(sendOtpViaResend("a@b.com", "123456", "http://localhost/cb")).resolves.toBeUndefined();
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: "a@b.com", subject: "登录验证码：123456" }),
    );
  });

  it("throws and logs when Resend rejects (sandbox/from/quota) instead of silently succeeding", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    sendMock.mockResolvedValue({
      data: null,
      error: {
        message: "You can only send testing emails to your own email address",
        statusCode: 403,
        name: "security_error",
      },
    });
    await expect(sendOtpViaResend("other@example.com", "123456", "http://localhost/cb")).rejects.toThrow(
      "resend send failed",
    );
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("403"));
    errSpy.mockRestore();
  });
});
