import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const fetchMock = vi.fn();

describe("/admin page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    window.localStorage.clear();
    // 默认 ping 鉴权通过；分用例覆盖 401/503/网络错误
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true }),
    });
  });

  it("无密钥时显示密钥输入；ping 通过后才进入后台并写入 localStorage", async () => {
    const { default: AdminPage } = await import("@/app/admin/page");
    render(<AdminPage />);
    expect(screen.getByLabelText("管理密钥")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("管理密钥"), { target: { value: "k" } });
    fireEvent.click(screen.getByRole("button", { name: "进入后台" }));
    await waitFor(() => {
      expect(screen.getByText("生成兑换码")).toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/ping",
      expect.objectContaining({ headers: expect.objectContaining({ "x-admin-key": "k" }) }),
    );
    expect(window.localStorage.getItem("ava_admin_key")).toBe("k");
  });

  it("ping 401：停留在门页，不写 localStorage、不渲染工作台", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: "Unauthorized" }),
    });
    const { default: AdminPage } = await import("@/app/admin/page");
    render(<AdminPage />);
    fireEvent.change(screen.getByLabelText("管理密钥"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "进入后台" }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("密钥错误，请重试");
    });
    expect(screen.getByLabelText("管理密钥")).toBeInTheDocument();
    expect(screen.queryByText("生成兑换码")).not.toBeInTheDocument();
    expect(window.localStorage.getItem("ava_admin_key")).toBeNull();
  });

  it("ping 503：提示后台未配置，不写 localStorage", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      json: () => Promise.resolve({ error: "Admin not configured" }),
    });
    const { default: AdminPage } = await import("@/app/admin/page");
    render(<AdminPage />);
    fireEvent.change(screen.getByLabelText("管理密钥"), { target: { value: "k" } });
    fireEvent.click(screen.getByRole("button", { name: "进入后台" }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("后台未配置（联系部署设置 ADMIN_KEY）");
    });
    expect(window.localStorage.getItem("ava_admin_key")).toBeNull();
  });

  it("ping 网络错误：提示网络错误，不写 localStorage", async () => {
    fetchMock.mockRejectedValue(new Error("connection reset"));
    const { default: AdminPage } = await import("@/app/admin/page");
    render(<AdminPage />);
    fireEvent.change(screen.getByLabelText("管理密钥"), { target: { value: "k" } });
    fireEvent.click(screen.getByRole("button", { name: "进入后台" }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("网络错误，请重试");
    });
    expect(window.localStorage.getItem("ava_admin_key")).toBeNull();
  });

  it("批量生成：提交后展示码列表（无横杠库存 → 展示层加横杠）", async () => {
    window.localStorage.setItem("ava_admin_key", "k");
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ codes: ["AAAABBBBCCCCDDDD"] }),
    });
    const { default: AdminPage } = await import("@/app/admin/page");
    render(<AdminPage />);
    fireEvent.change(screen.getByLabelText("单码面值（积分）"), { target: { value: "100" } });
    fireEvent.change(screen.getByLabelText("生成数量"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "生成" }));
    await waitFor(() => {
      expect(screen.getByText("AAAA-BBBB-CCCC-DDDD")).toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/codes",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-admin-key": "k" }),
      }),
    );
  });
});
