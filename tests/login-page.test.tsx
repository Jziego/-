import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import LoginPage from "@/app/login/page";

const { sendMagicLinkMock, pushMock } = vi.hoisted(() => ({
  sendMagicLinkMock: vi.fn(),
  pushMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
  useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("@/app/login/actions", () => ({
  sendMagicLink: sendMagicLinkMock,
}));

describe("/login page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendMagicLinkMock.mockResolvedValue({ success: true, message: "ok" });
  });

  it("renders the brand hero with the product tagline", () => {
    render(<LoginPage />);
    expect(screen.getByText("AI 短视频助手")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "让每家店都有自己的数字人口播" })
    ).toBeInTheDocument();
  });

  it("sends OTP then navigates to /login/verify with the email param", async () => {
    render(<LoginPage />);
    fireEvent.change(screen.getByLabelText("邮箱地址"), {
      target: { value: "a@b.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送验证码" }));
    expect(sendMagicLinkMock).toHaveBeenCalledWith("a@b.com");
    await vi.waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith("/login/verify?email=a%40b.com");
    });
  });

  it("不再提供微信登录入口", () => {
    render(<LoginPage />);
    expect(screen.queryByText("微信登录")).not.toBeInTheDocument();
    expect(screen.queryByText("其他登录方式")).not.toBeInTheDocument();
  });
});
