import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import LoginPage from "@/app/login/page";

const { sendMagicLinkMock, pushMock, altchaState } = vi.hoisted(() => ({
  sendMagicLinkMock: vi.fn(),
  pushMock: vi.fn(),
  altchaState: { enabled: false },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
  useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("@/app/login/actions", () => ({
  sendMagicLink: sendMagicLinkMock,
}));

// LoginPage 是 server component，渲染时直接调用 isAltchaEnabled 决定 captcha 开关；
// 用可变的 altchaState 在两个 describe 之间切换（默认关闭，保持旧用例语义）。
vi.mock("@/lib/altcha", () => ({
  isAltchaEnabled: () => altchaState.enabled,
}));

// 打桩 altcha web component 包：jsdom 里不真正执行注册 custom element 的代码
vi.mock("altcha", () => ({}));

describe("/login page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    altchaState.enabled = false;
    sendMagicLinkMock.mockResolvedValue({ success: true, message: "ok" });
  });

  it("renders the brand hero with the product tagline", () => {
    render(<LoginPage />);
    expect(screen.getByText("AI 短视频助手")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "让每家店都有自己的数字人口播" })
    ).toBeInTheDocument();
  });

  it("captcha 关闭时不渲染 altcha widget", () => {
    render(<LoginPage />);
    expect(document.querySelector("altcha-widget")).toBeNull();
  });

  it("sends OTP then navigates to /login/verify with the email param", async () => {
    render(<LoginPage />);
    fireEvent.change(screen.getByLabelText("邮箱地址"), {
      target: { value: "a@b.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送验证码" }));
    expect(sendMagicLinkMock).toHaveBeenCalledWith("a@b.com", undefined);
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

describe("/login page with captcha enabled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    altchaState.enabled = true;
    sendMagicLinkMock.mockResolvedValue({ success: true, message: "ok" });
  });

  function renderAndFillEmail() {
    render(<LoginPage />);
    fireEvent.change(screen.getByLabelText("邮箱地址"), {
      target: { value: "a@b.com" },
    });
    const widget = document.querySelector("altcha-widget");
    expect(widget).not.toBeNull();
    return { widget: widget as Element };
  }

  function emitStateChange(widget: Element, detail: unknown) {
    fireEvent(
      widget,
      new CustomEvent("statechange", { detail })
    );
  }

  it("渲染 altcha widget，challenge 指向挑战签发端点", () => {
    const { widget } = renderAndFillEmail();
    expect(widget.getAttribute("challenge")).toBe("/api/altcha/challenge");
  });

  it("有邮箱但未通过人机验证时，提交按钮保持禁用", () => {
    renderAndFillEmail();
    expect(screen.getByRole("button", { name: "发送验证码" })).toBeDisabled();
  });

  it("widget verified 后携带 payload 提交并跳转验证码页", async () => {
    const { widget } = renderAndFillEmail();
    emitStateChange(widget, { state: "verified", payload: "PAYLOAD" });
    const submit = screen.getByRole("button", { name: "发送验证码" });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    expect(sendMagicLinkMock).toHaveBeenCalledWith("a@b.com", "PAYLOAD");
    await vi.waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith("/login/verify?email=a%40b.com");
    });
  });

  it("widget 状态变为非 verified 时清空 payload，按钮重新禁用", () => {
    const { widget } = renderAndFillEmail();
    emitStateChange(widget, { state: "verified", payload: "PAYLOAD" });
    expect(screen.getByRole("button", { name: "发送验证码" })).toBeEnabled();
    emitStateChange(widget, { state: "error" });
    expect(screen.getByRole("button", { name: "发送验证码" })).toBeDisabled();
  });

  it("人机验证未通过时展示服务端文案、不跳转，且 payload 清空按钮重新禁用", async () => {
    sendMagicLinkMock.mockResolvedValue({
      success: false,
      message: "人机验证未通过",
    });
    const { widget } = renderAndFillEmail();
    emitStateChange(widget, { state: "verified", payload: "PAYLOAD" });
    fireEvent.click(screen.getByRole("button", { name: "发送验证码" }));
    expect(await screen.findByText("人机验证未通过")).toBeInTheDocument();
    expect(pushMock).not.toHaveBeenCalled();
    // payload 已清空（widget 强制 remount 重新验证），需再次 verified 才能提交
    expect(screen.getByRole("button", { name: "发送验证码" })).toBeDisabled();
  });
});
