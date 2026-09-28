import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import VerifyPage from "@/app/login/verify/page";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("@/app/login/actions", () => ({
  sendMagicLink: vi.fn(),
}));

describe("/login/verify without email param", () => {
  it("shows the missing-email fallback with a link back to /login", () => {
    render(<VerifyPage />);
    expect(screen.getByText("缺少邮箱参数，请重新发起登录。")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "← 返回登录" })).toBeInTheDocument();
  });
});
