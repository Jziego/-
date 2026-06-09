import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
      if (url === "/api/script-drafts") return { scripts: [] };
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

  afterEach(() => {
    vi.restoreAllMocks();
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

  it("lets a returning user complete the profile from the saved step", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem("ai-video-assistant:store-profile-step", "2");
    window.localStorage.setItem(
      "ai-video-assistant:store-profile-draft",
      JSON.stringify({
        name: "返店完成测试",
        industry: "零售",
        location: "深圳",
        mainProducts: "A",
        targetCustomers: "B",
        sellingPoints: "C",
        promotions: "D",
        brandTone: "高端精致",
        forbiddenWords: "E"
      })
    );

    renderDashboard();

    expect(screen.getByRole("heading", { name: "内容风格" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "完成设置" }));

    expect(
      await within(screen.getByRole("status")).findByText("保存成功：请继续上传素材。")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "上传素材" })).toBeEnabled();
  });

  it("lets a user fill step one, refresh, and complete the profile", async () => {
    const user = userEvent.setup();
    const { unmount } = renderDashboard();

    await user.clear(screen.getByLabelText(/门店名称/));
    await user.type(screen.getByLabelText(/门店名称/), "刷新后保存测试");
    await user.selectOptions(screen.getByLabelText(/行业/), "零售");
    await user.clear(screen.getByLabelText(/位置/));
    await user.type(screen.getByLabelText(/位置/), "杭州");
    await user.click(screen.getByRole("button", { name: "保存并继续" }));

    unmount();
    renderDashboard();

    await user.click(screen.getByRole("button", { name: "上一步" }));
    expect(screen.getByLabelText(/门店名称/)).toHaveValue("刷新后保存测试");

    await user.click(screen.getByRole("button", { name: "保存并继续" }));
    await user.click(screen.getByRole("button", { name: "保存并继续" }));
    await user.click(screen.getByRole("button", { name: "完成设置" }));

    expect(
      await within(screen.getByRole("status")).findByText("保存成功：请继续上传素材。")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "上传素材" })).toBeEnabled();
  });

  it("does not wipe a saved draft when the dashboard remounts", async () => {
    const customDraft = {
      name: "用户自定义店名",
      industry: "零售",
      location: "北京",
      mainProducts: "手工皂",
      targetCustomers: "年轻人",
      sellingPoints: "天然无添加",
      promotions: "开业八折",
      brandTone: "活泼有趣",
      forbiddenWords: "最好"
    };
    window.localStorage.setItem("ai-video-assistant:store-profile-step", "2");
    window.localStorage.setItem("ai-video-assistant:store-profile-draft", JSON.stringify(customDraft));

    const { unmount } = renderDashboard();
    await screen.findByRole("heading", { name: "内容风格" });

    expect(JSON.parse(window.localStorage.getItem("ai-video-assistant:store-profile-draft")!)).toMatchObject({
      name: "用户自定义店名"
    });

    unmount();
    renderDashboard();
    await screen.findByRole("heading", { name: "内容风格" });

    expect(JSON.parse(window.localStorage.getItem("ai-video-assistant:store-profile-draft")!)).toMatchObject({
      name: "用户自定义店名"
    });
  });

  it("does not write default values over a saved draft while hydrating", async () => {
    const customDraft = {
      name: "用户自定义店名",
      industry: "零售",
      location: "北京",
      mainProducts: "手工皂",
      targetCustomers: "年轻人",
      sellingPoints: "天然无添加",
      promotions: "开业八折",
      brandTone: "活泼有趣",
      forbiddenWords: "最好"
    };
    window.localStorage.setItem("ai-video-assistant:store-profile-step", "2");
    window.localStorage.setItem("ai-video-assistant:store-profile-draft", JSON.stringify(customDraft));
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");

    renderDashboard();
    await screen.findByRole("heading", { name: "内容风格" });

    await waitFor(() => {
      const draftWrites = setItemSpy.mock.calls.filter(([key]) => key === "ai-video-assistant:store-profile-draft");
      expect(draftWrites.length).toBeGreaterThan(0);
      expect(draftWrites.every(([, value]) => JSON.parse(String(value)).name === customDraft.name)).toBe(true);
    });
  });

  it("resumes at the saved step for a returning user", () => {
    window.localStorage.setItem("ai-video-assistant:store-profile-step", "2");
    window.localStorage.setItem(
      "ai-video-assistant:store-profile-draft",
      JSON.stringify({
        name: "返店测试",
        industry: "零售",
        location: "深圳",
        mainProducts: "A",
        targetCustomers: "B",
        sellingPoints: "C",
        promotions: "D",
        brandTone: "高端精致",
        forbiddenWords: "E"
      })
    );

    renderDashboard();

    expect(screen.getByRole("heading", { name: "内容风格" })).toBeInTheDocument();
    expect(screen.getByText("3/3")).toBeInTheDocument();
  });

  it("keeps the user's selected brand tone when completing the profile", async () => {
    const user = userEvent.setup();
    let postedBrandTone: string | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/store-profiles" && init?.method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}"));
          postedBrandTone = body.brandTone ?? null;
          return { ok: true, json: async () => ({ store: body }) };
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
    await user.click(screen.getByRole("radio", { name: "活泼有趣" }));
    await user.click(screen.getByRole("button", { name: "完成设置" }));

    expect(
      await within(screen.getByRole("status")).findByText("保存成功：请继续上传素材。")
    ).toBeInTheDocument();
    expect(postedBrandTone).toBe("活泼有趣");
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

  it("restores the store profile form from the API after a completed save and refresh", async () => {
    const user = userEvent.setup();
    const savedStore = {
      id: "store_saved",
      ownerId: "demo_user",
      name: "已保存门店",
      industry: "零售",
      location: "成都",
      mainProducts: ["手工皂"],
      targetCustomers: ["年轻人"],
      sellingPoints: ["天然无添加"],
      promotions: ["开业八折"],
      brandTone: "活泼有趣",
      forbiddenWords: ["最好"],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/store-profiles" && init?.method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}"));
          return {
            ok: true,
            json: async () => ({
              store: {
                ...savedStore,
                ...body,
                id: savedStore.id,
                ownerId: savedStore.ownerId
              }
            })
          };
        }

        return {
          ok: true,
          json: async () => {
            if (url === "/api/store-profiles") return { stores: [savedStore] };
            if (url === "/api/assets") return { assets: [] };
            if (url === "/api/asset-analyses") return { analyses: [] };
            if (url === "/api/avatars") return { avatars: [] };
            if (url === "/api/jobs") return { jobs: [] };
            if (url === "/api/script-drafts") return { scripts: [] };
            return {};
          }
        };
      })
    );

    renderDashboard();

    await screen.findByRole("heading", { name: "内容风格" });
    expect(screen.getByRole("radio", { name: "活泼有趣" })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "上一步" }));
    await user.click(screen.getByRole("button", { name: "上一步" }));

    await waitFor(() => {
      expect(screen.getByLabelText(/门店名称/)).toHaveValue("已保存门店");
    });
    expect(screen.getByLabelText(/位置/)).toHaveValue("成都");
    expect(window.localStorage.getItem("ai-video-assistant:store-profile-draft")).toBeNull();
  });

  it("restores avatar and script progress from the API after refresh", async () => {
    const savedStore = {
      id: "store_saved",
      ownerId: "demo_user",
      name: "已保存门店",
      industry: "零售",
      location: "成都",
      mainProducts: ["手工皂"],
      targetCustomers: ["年轻人"],
      sellingPoints: ["天然无添加"],
      promotions: [],
      brandTone: "活泼有趣",
      forbiddenWords: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    const savedAvatar = {
      id: "avatar_saved",
      ownerId: "demo_user",
      storeId: savedStore.id,
      provider: "mock-avatar" as const,
      consentAcceptedAt: "2026-01-01T00:00:00.000Z",
      trainingStatus: "processing" as const,
      fallbackMode: "tts_voiceover" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    const savedScript = {
      id: "script_saved",
      ownerId: "demo_user",
      storeId: savedStore.id,
      purpose: "new_product" as const,
      platform: "douyin" as const,
      title: "新品推广",
      hook: "今天上新，欢迎来尝",
      scenes: [],
      voiceover: "欢迎来尝",
      captions: [],
      cta: "到店体验",
      generationMode: "ai" as const,
      complianceWarnings: [],
      createdAt: "2026-01-02T00:00:00.000Z"
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        return {
          ok: true,
          json: async () => {
            if (url === "/api/store-profiles") return { stores: [savedStore] };
            if (url === "/api/assets") return { assets: [] };
            if (url === "/api/asset-analyses") return { analyses: [] };
            if (url === "/api/avatars") return { avatars: [savedAvatar] };
            if (url === "/api/jobs") return { jobs: [] };
            if (url === "/api/script-drafts") return { scripts: [savedScript] };
            return {};
          }
        };
      })
    );

    renderDashboard();

    const stepper = await screen.findByRole("navigation", { name: "全局步骤导航" });
    await waitFor(() => {
      expect(within(stepper).getByRole("link", { name: /AI 分身/ })).toHaveTextContent("已完成");
    });
    expect(within(stepper).getByRole("link", { name: /智能成片/ })).toHaveTextContent("已完成");
    expect(screen.getByText("AI 形象已创建")).toBeInTheDocument();
    expect(screen.getByText("今天上新，欢迎来尝")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /我已确认拥有该视频的肖像/ })).toBeChecked();
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
