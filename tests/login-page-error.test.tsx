import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import LoginPage from "@/app/login/page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams("error=Verification"),
}));

vi.mock("@/app/login/actions", () => ({
  sendMagicLink: vi.fn(),
  signInWithWeChat: vi.fn(),
}));

describe("/login?error=Verification", () => {
  it("shows the OTP-failed banner", () => {
    render(<LoginPage />);
    expect(
      screen.getByText("验证码错误或已过期，请重新获取")
    ).toBeInTheDocument();
  });
});
