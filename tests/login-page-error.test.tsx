import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import LoginPage from "@/app/login/page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams("error=Verification"),
}));

vi.mock("@/app/login/actions", () => ({
  sendMagicLink: vi.fn(),
}));

// LoginPage 是 server component，渲染时调用 isAltchaEnabled；
// 本文件不涉及 captcha 路径，固定关闭以避免拉入真实依赖链。
vi.mock("@/lib/altcha", () => ({
  isAltchaEnabled: () => false,
}));

describe("/login?error=Verification", () => {
  it("shows the OTP-failed banner", () => {
    render(<LoginPage />);
    expect(
      screen.getByText("验证码错误或已过期，请重新获取")
    ).toBeInTheDocument();
  });
});
