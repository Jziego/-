import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "@/components/dashboard";
import { Providers } from "@/components/providers";

function mockApiFetch() {
  return vi.fn(async (url: string, init?: RequestInit) => {
  const method = init?.method ?? "GET";

  if (url === "/api/store-profiles" && method === "POST") {
    const body = JSON.parse(String(init?.body ?? "{}"));
    return {
      ok: true,
      json: async () => ({
        store: {
          ...body,
          id: body.id ?? "store_test",
          ownerId: body.ownerId ?? "demo_user",
          promotions: body.promotions ?? [],
          forbiddenWords: body.forbiddenWords ?? [],
          createdAt: body.createdAt ?? new Date().toISOString(),
          updatedAt: body.updatedAt ?? new Date().toISOString()
        }
      })
    };
  }

  return {
    ok: true,
    json: async () => {
      if (url === "/api/store-profiles") return { stores: [] };
      if (url === "/api/assets") return { assets: [] };
      if (url === "/api/asset-analyses") return { analyses: [] };
      if (url === "/api/avatars") return { avatars: [] };
      if (url === "/api/jobs") return { jobs: [] };
      return {};
    }
  };
  });
}

function renderDashboard() {
  return render(
    <Providers>
      <Dashboard />
    </Providers>
  );
}

describe("AI video assistant dashboard", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal("fetch", mockApiFetch());
  });

  it("shows the four production modules in one SPA workspace", () => {
    renderDashboard();

    expect(screen.getByRole("heading", { name: "门店档案" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "素材库" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "AI 分身" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "智能成片" })).toBeInTheDocument();
  });

  it("uses customer-friendly copy and the global stepper", () => {
    renderDashboard();

    const stepper = screen.getByRole("navigation", { name: "全局步骤导航" });
    expect(within(stepper).getByText("门店档案")).toBeInTheDocument();
    expect(within(stepper).getByText("素材库")).toBeInTheDocument();
    expect(within(stepper).getByText("AI 分身")).toBeInTheDocument();
    expect(within(stepper).getByText("智能成片")).toBeInTheDocument();
    expect(
      screen.getByText("0 基础也能做。自动写脚本、配音乐、加字幕，你只管传素材，剩下的 AI 全包，让顾客主动找到你。")
    ).toBeInTheDocument();
    expect(screen.getByText("上传你的视频、图片或音频，AI 自动看懂内容并分类，找素材时一搜就有")).toBeInTheDocument();
    expect(screen.getByText("我已确认拥有该视频的肖像/声音使用权，同意生成 AI 形象")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "请先完成门店档案" })).toBeDisabled();
  });

  it("keeps save and continue out of native form submission", () => {
    renderDashboard();

    const saveAndContinue = screen.getByRole("button", { name: "保存并继续" });
    expect(saveAndContinue).toHaveAttribute("type", "button");
    expect(saveAndContinue.closest("form")).toHaveAttribute("novalidate");
  });

  it("prevents native form submit navigation", async () => {
    renderDashboard();

    const form = screen.getByRole("button", { name: "保存并继续" }).closest("form");
    expect(form).not.toBeNull();

    const submitEvent = new Event("submit", { bubbles: true, cancelable: true });
    const submitWasNotCancelled = fireEvent(form as HTMLFormElement, submitEvent);

    expect(submitWasNotCancelled).toBe(false);
    expect(submitEvent.defaultPrevented).toBe(true);
    expect(await screen.findByText("2/3")).toBeInTheDocument();
  });

  it("persists the store profile step and draft values after continuing", async () => {
    const user = userEvent.setup();
    const { unmount } = renderDashboard();

    await user.clear(screen.getByLabelText(/门店名称/));
    await user.type(screen.getByLabelText(/门店名称/), "测试小店");
    await user.click(screen.getByRole("button", { name: "保存并继续" }));

    expect(screen.getByText("2/3")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "产品与人设" })).toBeInTheDocument();

    unmount();
    renderDashboard();

    expect(screen.getByText("2/3")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "产品与人设" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "上一步" }));
    expect(screen.getByLabelText(/门店名称/)).toHaveValue("测试小店");
  });

  it("shows a clear validation message when a required field is missing", async () => {
    const user = userEvent.setup();
    renderDashboard();

    await user.clear(screen.getByLabelText(/门店名称/));
    await user.click(screen.getByRole("button", { name: "保存并继续" }));

    expect(screen.getByText("请填写门店名称")).toBeInTheDocument();
    expect(within(screen.getByRole("status")).getByText("请先填写门店名称。")).toBeInTheDocument();
    expect(screen.getByText("1/3")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "基础信息" })).toBeInTheDocument();
  });

  it("unlocks media upload after completing the store profile", async () => {
    const user = userEvent.setup();

    renderDashboard();

    await user.click(screen.getByRole("button", { name: "保存并继续" }));
    await user.click(screen.getByRole("button", { name: "保存并继续" }));
    await user.click(screen.getByRole("button", { name: "完成设置" }));

    expect(
      await within(screen.getByRole("status")).findByText("保存成功：请继续上传素材。")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "上传素材" })).toBeEnabled();
    const stepper = screen.getByRole("navigation", { name: "全局步骤导航" });
    expect(within(stepper).getByRole("link", { name: /素材库/ })).toHaveAttribute("href", "#media-upload");
  });

  it("shows an error when store profile save fails", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/store-profiles" && init?.method === "POST") {
          return {
            ok: false,
            json: async () => ({ error: "Foreign key constraint failed" })
          };
        }

        return {
          ok: true,
          json: async () => {
            if (url === "/api/store-profiles") return { stores: [] };
            if (url === "/api/assets") return { assets: [] };
            if (url === "/api/asset-analyses") return { analyses: [] };
            if (url === "/api/avatars") return { avatars: [] };
            if (url === "/api/jobs") return { jobs: [] };
            return {};
          }
        };
      })
    );

    renderDashboard();

    await user.click(screen.getByRole("button", { name: "保存并继续" }));
    await user.click(screen.getByRole("button", { name: "保存并继续" }));
    await user.click(screen.getByRole("button", { name: "完成设置" }));

    expect(
      await within(screen.getByRole("status")).findByText("门店档案保存失败：Foreign key constraint failed")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "上传素材" })).toBeDisabled();
  });

  it("validates only the current step when continuing", async () => {
    const user = userEvent.setup();
    renderDashboard();

    await user.click(screen.getByRole("button", { name: "保存并继续" }));
    expect(screen.getByText("2/3")).toBeInTheDocument();

    await user.clear(screen.getByLabelText(/主营产品/));
    await user.click(screen.getByRole("button", { name: "保存并继续" }));

    expect(screen.getByText("请填写主营产品")).toBeInTheDocument();
    expect(within(screen.getByRole("status")).getByText("请先填写主营产品。")).toBeInTheDocument();
    expect(screen.getByText("2/3")).toBeInTheDocument();
  });
});
