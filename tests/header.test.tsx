import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted lets the mock factory reference signOutMock safely.
const { signOutMock, fetchPointsMock, redeemPointsMock, notifyPointsChangedMock } = vi.hoisted(() => ({
  signOutMock: vi.fn(),
  fetchPointsMock: vi.fn(),
  redeemPointsMock: vi.fn(),
  notifyPointsChangedMock: vi.fn(),
}));
vi.mock("@/app/login/actions", () => ({
  signOutWithRevocation: signOutMock,
}));
vi.mock("@/lib/api-client", () => ({
  fetchPoints: fetchPointsMock,
  redeemPointsApi: redeemPointsMock,
  notifyPointsChanged: notifyPointsChangedMock,
}));

import { Header } from "@/components/header";

describe("Header", () => {
  beforeEach(() => {
    signOutMock.mockReset();
    signOutMock.mockResolvedValue(undefined);
    // 默认值：既有用例渲染 Header 会触发 PointsBalance 的余额拉取，
    // 未初始化 mock 会产生「called on unmocked fn」噪音。
    fetchPointsMock.mockReset();
    fetchPointsMock.mockResolvedValue(null);
    redeemPointsMock.mockReset();
    notifyPointsChangedMock.mockReset();
  });

  it("shows the signed-in user's email", () => {
    render(<Header email="owner@example.com" />);
    expect(screen.getByText("owner@example.com")).toBeInTheDocument();
  });

  it("calls signOutWithRevocation when the logout button is clicked", async () => {
    const user = userEvent.setup();
    render(<Header email="owner@example.com" />);

    await user.click(screen.getByRole("button", { name: /退出登录|退出/ }));

    expect(signOutMock).toHaveBeenCalledTimes(1);
  });

  it("disables the button and shows a pending state while signing out", async () => {
    const user = userEvent.setup();
    let resolveSignOut: () => void = () => {};
    signOutMock.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveSignOut = resolve; })
    );

    render(<Header email="owner@example.com" />);
    const button = screen.getByRole("button", { name: /退出登录|退出/ });
    await user.click(button);

    expect(button).toBeDisabled();
    resolveSignOut();
  });
});

describe("PointsBalance chip", () => {
  it("展示余额；点击兑换弹出输入框，兑换成功刷新余额", async () => {
    const user = userEvent.setup();
    fetchPointsMock.mockResolvedValue(230);
    redeemPointsMock.mockResolvedValue({ points: 100, balance: 330 });
    render(<Header email="owner@example.com" />);

    expect(await screen.findByText("积分 230")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "兑换" }));
    await user.type(screen.getByLabelText("兑换码"), "AAAA-BBBB-CCCC-DDDD");
    await user.click(screen.getByRole("button", { name: "确认兑换" }));

    await vi.waitFor(() => {
      expect(redeemPointsMock).toHaveBeenCalledWith("AAAA-BBBB-CCCC-DDDD");
      expect(screen.getByText("积分 330")).toBeInTheDocument();
    });
  });

  it("余额为 null（无库）显示占位符", async () => {
    fetchPointsMock.mockResolvedValue(null);
    render(<Header email="owner@example.com" />);
    expect(await screen.findByText("积分 —")).toBeInTheDocument();
  });

  it("余额加载失败显示问号占位", async () => {
    fetchPointsMock.mockRejectedValue(new Error("network"));
    render(<Header email="owner@example.com" />);
    expect(await screen.findByText("积分 ?")).toBeInTheDocument();
  });
});
