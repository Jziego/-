import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const fetchMock = vi.fn();

describe("/admin page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    window.localStorage.clear();
  });

  it("无密钥时显示密钥输入；输入后进入后台", async () => {
    const { default: AdminPage } = await import("@/app/admin/page");
    render(<AdminPage />);
    expect(screen.getByLabelText("管理密钥")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("管理密钥"), { target: { value: "k" } });
    fireEvent.click(screen.getByRole("button", { name: "进入后台" }));
    await waitFor(() => {
      expect(screen.getByText("生成兑换码")).toBeInTheDocument();
    });
  });

  it("批量生成：提交后展示码列表", async () => {
    window.localStorage.setItem("ava_admin_key", "k");
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ codes: ["AAAA-BBBB-CCCC-DDDD"] }),
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
