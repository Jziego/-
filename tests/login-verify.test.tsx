import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import VerifyPage from "@/app/login/verify/page";

const { sendMagicLinkMock } = vi.hoisted(() => ({ sendMagicLinkMock: vi.fn() }));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("email=a%40b.com"),
}));

vi.mock("@/app/login/actions", () => ({
  sendMagicLink: sendMagicLinkMock,
}));

describe("/login/verify OTP page", () => {
  beforeEach(() => {
    sendMagicLinkMock.mockReset();
    sendMagicLinkMock.mockResolvedValue({ success: true, message: "ok" });
    // jsdom 未实现 navigation：把 window.location.assign 换成 mock，
    // 同时避免输满 6 位自动提交时打印 "Not implemented" 噪音。
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { assign: vi.fn() },
    });
  });

  it("filters non-digits and enables submit only at 6 digits", () => {
    render(<VerifyPage />);
    const input = screen.getByLabelText("登录验证码") as HTMLInputElement;
    const submit = screen.getByRole("button", { name: "登录" }) as HTMLButtonElement;

    expect(submit.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "12ab45" } });
    expect(input.value).toBe("1245");
    expect(submit.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "123456" } });
    expect(submit.disabled).toBe(false);
  });

  it("exposes an accessible label on the OTP input", () => {
    render(<VerifyPage />);
    expect(screen.getByLabelText("登录验证码")).toBeInTheDocument();
  });

  it("renders six visual OTP cells", () => {
    const { container } = render(<VerifyPage />);
    expect(container.querySelectorAll(".otpCell")).toHaveLength(6);
  });

  it("auto-submits via full-page redirect when the 6th digit is entered", () => {
    render(<VerifyPage />);
    const input = screen.getByLabelText("登录验证码");
    fireEvent.change(input, { target: { value: "123456" } });
    const assign = (
      window.location as unknown as { assign: ReturnType<typeof vi.fn> }
    ).assign;
    expect(assign).toHaveBeenCalledWith(
      "/api/auth/callback/email?email=a%40b.com&token=123456&callbackUrl=%2F",
    );
  });

  it("starts the 60s cooldown only after a successful resend", async () => {
    render(<VerifyPage />);
    fireEvent.click(screen.getByRole("button", { name: "重新发送" }));

    expect(await screen.findByRole("button", { name: "重新发送（60s）" })).toBeInTheDocument();
    expect(sendMagicLinkMock).toHaveBeenCalledWith("a@b.com");
  });

  it("shows an error and skips the cooldown when resend fails", async () => {
    sendMagicLinkMock.mockRejectedValueOnce(new Error("send failed"));
    render(<VerifyPage />);
    fireEvent.click(screen.getByRole("button", { name: "重新发送" }));

    expect(await screen.findByText("发送失败，请稍后重试")).toBeInTheDocument();
    // 冷却未启动——按钮文案保持普通"重新发送"
    expect(screen.getByRole("button", { name: "重新发送" })).toBeInTheDocument();
    expect(sendMagicLinkMock).toHaveBeenCalledTimes(1);
  });
});
