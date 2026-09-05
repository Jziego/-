import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "@/components/dashboard";
import { Providers } from "@/components/providers";
import * as apiClient from "@/lib/api-client";

// 视频时长探测依赖真实媒体加载，jsdom 永远不会触发——mock 成可控值。
// 各用例按需改 probeDuration.value（默认 45s，在 30s–5min 合法窗内）。
const { probeDuration } = vi.hoisted(() => ({ probeDuration: { value: 45 } }));
vi.mock("@/lib/probe-video-duration", () => ({
  probeVideoDurationSec: vi.fn(async () => probeDuration.value),
}));

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
    probeDuration.value = 45;
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
    expect(screen.getByText("我是视频中的本人（或已获其授权），同意克隆肖像和声音生成 AI 分身")).toBeInTheDocument();
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
      name: "店主",
      provider: "mock-avatar" as const,
      consentStatus: "approved" as const,
      consentAcceptedAt: "2026-01-01T00:00:00.000Z",
      trainingStatus: "ready" as const,
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
    expect(screen.getByText(/店主·已就绪/)).toBeInTheDocument();
    expect(screen.getByText("今天上新，欢迎来尝")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /我是视频中的本人/ })).toBeChecked();
  });

  it("does not auto-check the consent box when only the platform fallback avatar is ready", async () => {
    const savedStore = {
      id: "store_plat",
      ownerId: "demo_user",
      name: "平台形象店",
      industry: "餐饮",
      location: "上海",
      mainProducts: ["牛肉面"],
      targetCustomers: ["上班族"],
      sellingPoints: ["现熬牛骨汤"],
      promotions: [],
      brandTone: "亲切接地气",
      forbiddenWords: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    // 服务端对无 ready 形象的用户注入平台兜底形象（ready/approved，跨店 storeId=""）。
    const platformAvatar = {
      id: "avatar_platform",
      ownerId: "demo_user",
      storeId: "",
      name: "平台公共形象",
      provider: "heygen",
      consentStatus: "approved",
      consentAcceptedAt: "2026-01-01T00:00:00.000Z",
      trainingStatus: "ready",
      fallbackMode: "template_avatar",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        json: async () => {
          if (url === "/api/store-profiles") return { stores: [savedStore] };
          if (url === "/api/assets") return { assets: [] };
          if (url === "/api/asset-analyses") return { analyses: [] };
          if (url === "/api/avatars") return { avatars: [platformAvatar] };
          if (url === "/api/jobs") return { jobs: [] };
          if (url === "/api/script-drafts") return { scripts: [] };
          return {};
        }
      }))
    );

    renderDashboard();

    // 等分身数据加载并 flush effect（步骤条随 ready 形象变「已完成」）后再断言：
    // 平台兜底形象就绪 ≠ 用户已授权本人肖像，授权框必须保持未勾选。
    const stepper = await screen.findByRole("navigation", { name: "全局步骤导航" });
    await waitFor(() => {
      expect(within(stepper).getByRole("link", { name: /AI 分身/ })).toHaveTextContent("已完成");
    });
    expect(screen.getByRole("checkbox", { name: /我是视频中的本人/ })).not.toBeChecked();
  });

  it("keeps avatar footage out of the material library and lists it in the footage pool", async () => {
    const savedStore = {
      id: "store_cat",
      ownerId: "demo_user",
      name: "分类店",
      industry: "餐饮",
      location: "上海",
      mainProducts: ["牛肉面"],
      targetCustomers: ["上班族"],
      sellingPoints: ["现熬牛骨汤"],
      promotions: [],
      brandTone: "亲切接地气",
      forbiddenWords: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    const savedAssets = [
      { id: "asset_mat", ownerId: "demo_user", storeId: "store_cat", type: "video", originalFilename: "mat.mp4", storageKey: "k1", mimeType: "video/mp4", sizeBytes: 1000, tags: [], businessTags: [], status: "uploaded", category: "material", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "asset_foot", ownerId: "demo_user", storeId: "store_cat", type: "video", originalFilename: "foot.mp4", storageKey: "k2", mimeType: "video/mp4", sizeBytes: 3000, tags: [], businessTags: [], status: "uploaded", category: "avatar_footage", createdAt: "2026-01-01T00:00:00.000Z" }
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        json: async () => {
          if (url === "/api/store-profiles") return { stores: [savedStore] };
          if (url === "/api/assets") return { assets: savedAssets };
          if (url === "/api/asset-analyses") return { analyses: [] };
          if (url === "/api/avatars") return { avatars: [] };
          if (url === "/api/jobs") return { jobs: [] };
          if (url === "/api/script-drafts") return { scripts: [] };
          return {};
        }
      }))
    );

    renderDashboard();

    // 素材库只统计/展示 material；人像视频不进素材网格。
    expect(await screen.findByText("已选 1 / 共 1")).toBeInTheDocument();
    expect(screen.getByLabelText("选择素材 mat.mp4")).toBeInTheDocument();
    expect(screen.queryByLabelText("选择素材 foot.mp4")).not.toBeInTheDocument();
    // 人像视频出现在 AI 分身区的人像视频列表里。
    expect(screen.getByLabelText("选择人像视频 foot.mp4")).toBeInTheDocument();
  });

  it("uploads footage and creates an AI avatar with the new contract, opening the consent window", async () => {
    const user = userEvent.setup();
    // 弹窗契约（2026-09-05 修复）：点击手势里同步开 about:blank 占位窗，
    // 异步拿到 consentUrl 后写 location——否则浏览器把异步 window.open 当弹窗拦截。
    const popup = { location: { href: "" }, close: vi.fn() };
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => popup as unknown as Window);
    const savedStore = {
      id: "store_av",
      ownerId: "demo_user",
      name: "分身店",
      industry: "餐饮",
      location: "上海",
      mainProducts: ["牛肉面"],
      targetCustomers: ["上班族"],
      sellingPoints: ["现熬牛骨汤"],
      promotions: [],
      brandTone: "亲切接地气",
      forbiddenWords: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    const createdAvatar = {
      id: "avatar_new",
      ownerId: "demo_user",
      storeId: "store_av",
      name: "店主",
      provider: "heygen",
      consentStatus: "awaiting_user",
      trainingStatus: "pending",
      consentAcceptedAt: "2026-01-01T00:00:00.000Z",
      fallbackMode: "tts_voiceover",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };

    const fetchedBodies: Record<string, unknown> = {};
    const serverAssets: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (method !== "GET") {
          fetchedBodies[`${method} ${url}`] = init?.body ? JSON.parse(init.body as string) : {};
        }

        if (url === "/api/assets/upload-intent" && method === "POST") {
          return {
            ok: true,
            json: async () => ({
              intent: {
                assetId: "asset_foot1",
                storageKey: "stores/store_av/assets/asset_foot1-me.mp4",
                uploadUrl: "https://storage.example/upload",
                headers: { "Content-Type": "video/mp4" },
                maxSizeBytes: 200 * 1024 * 1024,
                expiresInSeconds: 900
              }
            })
          };
        }

        if (url === "/api/assets/confirm" && method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}"));
          const confirmed = {
            id: body.assetId,
            ownerId: savedStore.ownerId,
            storeId: savedStore.id,
            type: "video",
            originalFilename: body.originalFilename,
            storageKey: body.storageKey,
            mimeType: body.mimeType,
            sizeBytes: body.sizeBytes ?? 1000,
            tags: [],
            businessTags: [],
            status: "uploaded",
            category: body.category ?? "material",
            createdAt: new Date().toISOString()
          };
          // 确认后素材即入服务端库，下一次 GET /api/assets 会带回它。
          serverAssets.push(confirmed);
          return { ok: true, json: async () => ({ asset: confirmed }) };
        }

        if (url === "/api/avatars" && method === "POST") {
          return { ok: true, json: async () => ({ avatar: createdAvatar, consentUrl: "https://consent/xyz" }) };
        }

        return {
          ok: true,
          json: async () => {
            if (url === "/api/store-profiles") return { stores: [savedStore] };
            if (url === "/api/assets") return { assets: serverAssets };
            if (url === "/api/asset-analyses") return { analyses: [] };
            if (url === "/api/avatars") return { avatars: [] };
            if (url === "/api/jobs") return { jobs: [] };
            if (url === "/api/script-drafts") return { scripts: [] };
            return {};
          }
        };
      })
    );

    vi.spyOn(apiClient, "uploadFileToStorage").mockImplementation(async () => {});

    renderDashboard();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "上传人像视频" })).toBeEnabled();
    });

    const footageInput = document.querySelector('input[accept="video/*"]') as HTMLInputElement;
    await user.upload(footageInput, new File(["video"], "me.mp4", { type: "video/mp4" }));

    expect(
      await within(screen.getByRole("status")).findByText("人像视频已上传。填写形象名字并确认授权后，创建你的 AI 分身。")
    ).toBeInTheDocument();
    // footage 上传链路带 category=avatar_footage，且不做素材 AI 分析。
    expect(fetchedBodies["POST /api/assets/upload-intent"]).toMatchObject({ category: "avatar_footage" });
    expect(fetchedBodies["POST /api/assets/confirm"]).toMatchObject({ category: "avatar_footage" });
    expect(fetchedBodies["POST /api/assets/analyze"]).toBeUndefined();
    // 上传成功后自动选中该人像视频；invalidate 回源后同一条素材不重复出现。
    expect(screen.getByLabelText("选择人像视频 me.mp4")).toBeChecked();
    await waitFor(() => {
      expect(screen.getAllByLabelText("选择人像视频 me.mp4")).toHaveLength(1);
    });

    await user.type(screen.getByLabelText("形象名字"), "店主");
    await user.click(screen.getByRole("checkbox", { name: /我是视频中的本人/ }));
    await user.click(screen.getByRole("button", { name: "创建 AI 分身" }));

    expect(
      await within(screen.getByRole("status")).findByText(/已创建分身任务/)
    ).toBeInTheDocument();
    expect(fetchedBodies["POST /api/avatars"]).toEqual({
      storeId: "store_av",
      footageAssetId: "asset_foot1",
      name: "店主",
      consentAccepted: true
    });
    expect(openSpy).toHaveBeenCalledWith("about:blank", "_blank");
    expect(popup.location.href).toBe("https://consent/xyz");
  });

  // 素材闸门（2026-09-05 生产事故：89MB 视频超 HeyGen 32MB 硬上限）——
  // 超限/超时长直接拒传，不发出任何上传请求。
  function stubFootageGateFetch(fetchedBodies: Record<string, unknown>) {
    const savedStore = {
      id: "store_gate",
      ownerId: "demo_user",
      name: "闸门店",
      industry: "餐饮",
      location: "上海",
      mainProducts: ["牛肉面"],
      targetCustomers: ["上班族"],
      sellingPoints: ["现熬牛骨汤"],
      promotions: [],
      brandTone: "亲切接地气",
      forbiddenWords: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (method !== "GET") {
          fetchedBodies[`${method} ${url}`] = init?.body ? JSON.parse(init.body as string) : {};
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
  }

  it("blocks avatar footage over 30MB before any upload request", async () => {
    const user = userEvent.setup();
    const fetchedBodies: Record<string, unknown> = {};
    stubFootageGateFetch(fetchedBodies);
    renderDashboard();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "上传人像视频" })).toBeEnabled();
    });
    const footageInput = document.querySelector('input[accept="video/*"]') as HTMLInputElement;
    await user.upload(
      footageInput,
      new File([new Uint8Array(31 * 1024 * 1024)], "big.mp4", { type: "video/mp4" })
    );

    expect(await within(screen.getByRole("status")).findByText(/30MB/)).toBeInTheDocument();
    expect(fetchedBodies["POST /api/assets/upload-intent"]).toBeUndefined();
  });

  it("blocks avatar footage shorter than 30 seconds before any upload request", async () => {
    probeDuration.value = 10;
    const user = userEvent.setup();
    const fetchedBodies: Record<string, unknown> = {};
    stubFootageGateFetch(fetchedBodies);
    renderDashboard();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "上传人像视频" })).toBeEnabled();
    });
    const footageInput = document.querySelector('input[accept="video/*"]') as HTMLInputElement;
    await user.upload(footageInput, new File(["video"], "me.mp4", { type: "video/mp4" }));

    expect(await within(screen.getByRole("status")).findByText(/太短/)).toBeInTheDocument();
    expect(fetchedBodies["POST /api/assets/upload-intent"]).toBeUndefined();
  });

  it("shows a 去完成授权 button for an awaiting-consent avatar and opens the consent url", async () => {
    const user = userEvent.setup();
    const popup = { location: { href: "" }, close: vi.fn() };
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => popup as unknown as Window);
    const savedStore = {
      id: "store_consent",
      ownerId: "demo_user",
      name: "授权店",
      industry: "餐饮",
      location: "上海",
      mainProducts: ["牛肉面"],
      targetCustomers: ["上班族"],
      sellingPoints: ["现熬牛骨汤"],
      promotions: [],
      brandTone: "亲切接地气",
      forbiddenWords: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    const awaitingAvatar = {
      id: "avatar_wait",
      ownerId: "demo_user",
      storeId: "store_consent",
      name: "店长",
      provider: "heygen",
      consentStatus: "awaiting_user",
      trainingStatus: "pending",
      consentAcceptedAt: "2026-01-01T00:00:00.000Z",
      fallbackMode: "tts_voiceover",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        json: async () => {
          if (url === "/api/store-profiles") return { stores: [savedStore] };
          if (url === "/api/assets") return { assets: [] };
          if (url === "/api/asset-analyses") return { analyses: [] };
          if (url === "/api/avatars") return { avatars: [awaitingAvatar] };
          if (url === "/api/avatars/avatar_wait/status") {
            return { avatar: awaitingAvatar, consentUrl: "https://consent/live" };
          }
          if (url === "/api/jobs") return { jobs: [] };
          if (url === "/api/script-drafts") return { scripts: [] };
          return {};
        }
      }))
    );

    renderDashboard();

    const consentButton = await screen.findByRole("button", { name: "去完成授权" });
    expect(screen.getByText(/店长·待真人授权/)).toBeInTheDocument();
    await user.click(consentButton);

    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledWith("about:blank", "_blank");
    });
    expect(popup.location.href).toBe("https://consent/live");
  });

  it("shows the failure reason for a failed avatar and reissues consent on demand", async () => {
    const user = userEvent.setup();
    const popup = { location: { href: "" }, close: vi.fn() };
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => popup as unknown as Window);
    const savedStore = {
      id: "store_failed",
      ownerId: "demo_user",
      name: "失败店",
      industry: "餐饮",
      location: "上海",
      mainProducts: ["牛肉面"],
      targetCustomers: ["上班族"],
      sellingPoints: ["现熬牛骨汤"],
      promotions: [],
      brandTone: "亲切接地气",
      forbiddenWords: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    const failedAvatar = {
      id: "avatar_fail",
      ownerId: "demo_user",
      storeId: "store_failed",
      name: "老板",
      provider: "heygen",
      consentStatus: "expired",
      statusReason: "授权超时",
      trainingStatus: "failed",
      consentAcceptedAt: "2026-01-01T00:00:00.000Z",
      fallbackMode: "tts_voiceover",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };

    let reissued = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (url === "/api/avatars/avatar_fail/consent" && method === "POST") {
          reissued = true;
          return {
            ok: true,
            json: async () => ({
              avatar: { ...failedAvatar, consentStatus: "awaiting_user", trainingStatus: "pending" },
              consentUrl: "https://consent/new"
            })
          };
        }
        return {
          ok: true,
          json: async () => {
            if (url === "/api/store-profiles") return { stores: [savedStore] };
            if (url === "/api/assets") return { assets: [] };
            if (url === "/api/asset-analyses") return { analyses: [] };
            if (url === "/api/avatars") return { avatars: [failedAvatar] };
            if (url === "/api/jobs") return { jobs: [] };
            if (url === "/api/script-drafts") return { scripts: [] };
            return {};
          }
        };
      })
    );

    renderDashboard();

    const reissueButton = await screen.findByRole("button", { name: "重新发起授权" });
    expect(screen.getByText(/失败：授权超时/)).toBeInTheDocument();
    await user.click(reissueButton);

    await waitFor(() => {
      expect(reissued).toBe(true);
    });
    expect(openSpy).toHaveBeenCalledWith("about:blank", "_blank");
    expect(popup.location.href).toBe("https://consent/new");
  });

  it("shows an explicit hint instead of dead air when the consent popup is blocked", async () => {
    // window.open 返回 null（浏览器拦截）时不能"没反应"——必须留明确指引。
    const user = userEvent.setup();
    vi.spyOn(window, "open").mockImplementation(() => null);
    const savedStore = {
      id: "store_blocked",
      ownerId: "demo_user",
      name: "拦截店",
      industry: "餐饮",
      location: "上海",
      mainProducts: ["牛肉面"],
      targetCustomers: ["上班族"],
      sellingPoints: ["现熬牛骨汤"],
      promotions: [],
      brandTone: "亲切接地气",
      forbiddenWords: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    const awaitingAvatar = {
      id: "avatar_blocked",
      ownerId: "demo_user",
      storeId: "store_blocked",
      name: "店长",
      provider: "heygen",
      consentStatus: "awaiting_user",
      trainingStatus: "pending",
      consentAcceptedAt: "2026-01-01T00:00:00.000Z",
      fallbackMode: "tts_voiceover",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        json: async () => {
          if (url === "/api/store-profiles") return { stores: [savedStore] };
          if (url === "/api/assets") return { assets: [] };
          if (url === "/api/asset-analyses") return { analyses: [] };
          if (url === "/api/avatars") return { avatars: [awaitingAvatar] };
          if (url === "/api/avatars/avatar_blocked/status") {
            return { avatar: awaitingAvatar, consentUrl: "https://consent/live" };
          }
          if (url === "/api/jobs") return { jobs: [] };
          if (url === "/api/script-drafts") return { scripts: [] };
          return {};
        }
      }))
    );

    renderDashboard();
    await user.click(await screen.findByRole("button", { name: "去完成授权" }));

    expect(
      await within(screen.getByRole("status")).findByText(/拦截/)
    ).toBeInTheDocument();
  });

  it("closes the placeholder window when avatar creation fails", async () => {
    // 创建失败时占位窗必须关掉，不能留个空白新标签页。
    const user = userEvent.setup();
    const popup = { location: { href: "" }, close: vi.fn() };
    vi.spyOn(window, "open").mockImplementation(() => popup as unknown as Window);
    const savedStore = {
      id: "store_fail",
      ownerId: "demo_user",
      name: "失败创建店",
      industry: "餐饮",
      location: "上海",
      mainProducts: ["牛肉面"],
      targetCustomers: ["上班族"],
      sellingPoints: ["现熬牛骨汤"],
      promotions: [],
      brandTone: "亲切接地气",
      forbiddenWords: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    const existingFootage = {
      id: "asset_exist",
      ownerId: "demo_user",
      storeId: "store_fail",
      type: "video",
      originalFilename: "me.mp4",
      storageKey: "stores/store_fail/assets/asset_exist-me.mp4",
      mimeType: "video/mp4",
      sizeBytes: 3000,
      tags: [],
      businessTags: [],
      status: "uploaded",
      category: "avatar_footage",
      createdAt: "2026-01-01T00:00:00.000Z"
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (url === "/api/avatars" && method === "POST") {
          return { ok: false, status: 502, json: async () => ({ error: "Avatar creation failed" }) };
        }
        return {
          ok: true,
          json: async () => {
            if (url === "/api/store-profiles") return { stores: [savedStore] };
            if (url === "/api/assets") return { assets: [existingFootage] };
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
    await user.click(await screen.findByLabelText("选择人像视频 me.mp4"));
    await user.type(screen.getByLabelText("形象名字"), "店主");
    await user.click(screen.getByRole("checkbox", { name: /我是视频中的本人/ }));
    await user.click(screen.getByRole("button", { name: "创建 AI 分身" }));

    expect(
      await within(screen.getByRole("status")).findByText(/创建 AI 分身失败/)
    ).toBeInTheDocument();
    expect(popup.close).toHaveBeenCalled();
    expect(popup.location.href).toBe("");
  });

  it("always renders the status toast with guidance (fixed-position contract)", () => {
    // toast 恒在（初始引导语）且 CSS 固定定位——消息不再因为页面滚动而"看不见"。
    renderDashboard();
    expect(screen.getByRole("status")).toHaveTextContent("准备开始");
  });

  it("uploads a selected file through intent, storage PUT and confirm", async () => {
    const user = userEvent.setup();
    const uploadSpy = vi.fn();
    const savedStore = {
      id: "store_upload",
      ownerId: "demo_user",
      name: "上传测试店",
      industry: "餐饮",
      location: "上海",
      mainProducts: ["牛肉面"],
      targetCustomers: ["上班族"],
      sellingPoints: ["现熬牛骨汤"],
      promotions: [],
      brandTone: "亲切接地气",
      forbiddenWords: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";

        if (url === "/api/store-profiles" && method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}"));
          return { ok: true, json: async () => ({ store: { ...savedStore, ...body, id: savedStore.id } }) };
        }

        if (url === "/api/assets/upload-intent" && method === "POST") {
          return {
            ok: true,
            json: async () => ({
              intent: {
                assetId: "asset_upload",
                storageKey: "stores/store_upload/assets/asset_upload-demo.mp4",
                uploadUrl: "https://storage.example/upload",
                headers: { "Content-Type": "video/mp4" },
                maxSizeBytes: 200 * 1024 * 1024,
                expiresInSeconds: 900
              }
            })
          };
        }

        if (url === "/api/assets/confirm" && method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}"));
          return {
            ok: true,
            json: async () => ({
              asset: {
                id: body.assetId,
                ownerId: savedStore.ownerId,
                storeId: savedStore.id,
                type: "video",
                originalFilename: body.originalFilename,
                storageKey: body.storageKey,
                mimeType: body.mimeType,
                sizeBytes: body.sizeBytes ?? 1000,
                tags: [],
                businessTags: [],
                status: "uploaded",
                createdAt: new Date().toISOString()
              }
            })
          };
        }

        if (url === "/api/assets/analyze" && method === "POST") {
          return {
            ok: true,
            json: async () => ({
              analysis: {
                id: "analysis_upload",
                assetId: "asset_upload",
                visualTags: ["food"],
                businessTags: ["新品推荐"],
                keywords: ["牛肉面"],
                confidence: 0.8,
                recommendedUses: ["new_product"],
                createdAt: new Date().toISOString(),
                analysisStatus: "succeeded"
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

    vi.spyOn(apiClient, "uploadFileToStorage").mockImplementation(async () => {
      uploadSpy();
    });

    renderDashboard();

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["video"], "demo.mp4", { type: "video/mp4" });
    await user.upload(fileInput, file);

    expect(uploadSpy).toHaveBeenCalled();
    expect(
      await within(screen.getByRole("status")).findByText("上传完成：AI 已自动识别画面和语音内容。")
    ).toBeInTheDocument();
    expect(screen.getByText("demo.mp4")).toBeInTheDocument();
  });

  it("does not send hardcoded visualLabels/transcript when uploading", async () => {
    const user = userEvent.setup();
    const analyzeCalls: { json: () => Promise<Record<string, unknown>> }[] = [];
    const savedStore = {
      id: "store_honest",
      ownerId: "demo_user",
      name: "诚实分类测试店",
      industry: "服装",
      location: "杭州",
      mainProducts: ["连衣裙"],
      targetCustomers: ["年轻女性"],
      sellingPoints: ["面料舒适"],
      promotions: [],
      brandTone: "时尚简洁",
      forbiddenWords: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";

        if (url === "/api/store-profiles" && method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}"));
          return { ok: true, json: async () => ({ store: { ...savedStore, ...body, id: savedStore.id } }) };
        }

        if (url === "/api/assets/upload-intent" && method === "POST") {
          return {
            ok: true,
            json: async () => ({
              intent: {
                assetId: "asset_honest",
                storageKey: "stores/store_honest/assets/asset_honest-demo.mp4",
                uploadUrl: "https://storage.example/upload",
                headers: { "Content-Type": "video/mp4" },
                maxSizeBytes: 200 * 1024 * 1024,
                expiresInSeconds: 900
              }
            })
          };
        }

        if (url === "/api/assets/confirm" && method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}"));
          return {
            ok: true,
            json: async () => ({
              asset: {
                id: body.assetId,
                ownerId: savedStore.ownerId,
                storeId: savedStore.id,
                type: "video",
                originalFilename: body.originalFilename,
                storageKey: body.storageKey,
                mimeType: body.mimeType,
                sizeBytes: body.sizeBytes ?? 1000,
                tags: [],
                businessTags: [],
                status: "uploaded",
                createdAt: new Date().toISOString()
              }
            })
          };
        }

        if (url === "/api/assets/analyze" && method === "POST") {
          const captured = String(init?.body ?? "{}");
          analyzeCalls.push({ json: async () => JSON.parse(captured) });
          return {
            ok: true,
            json: async () => ({
              analysis: {
                id: "analysis_honest",
                assetId: "asset_honest",
                visualTags: ["dress"],
                businessTags: ["新品推荐"],
                keywords: ["连衣裙"],
                confidence: 0.8,
                recommendedUses: ["new_product"],
                createdAt: new Date().toISOString(),
                analysisStatus: "succeeded"
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

    vi.spyOn(apiClient, "uploadFileToStorage").mockImplementation(async () => {});

    renderDashboard();

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["video"], "dress.mp4", { type: "video/mp4" });
    await user.upload(fileInput, file);

    await within(screen.getByRole("status")).findByText("上传完成：AI 已自动识别画面和语音内容。");

    expect(analyzeCalls.length).toBeGreaterThan(0);
    const body = await analyzeCalls.at(-1)!.json();
    expect(body).not.toHaveProperty("visualLabels");
    expect(body).not.toHaveProperty("transcript");
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

  it("shows only the latest render batch in the progress panel", async () => {
    const oldBatch = [
      { id: "job_old_1", ownerId: "demo_user", projectId: "proj_old", type: "avatar_generation", status: "completed", progress: 100, payload: {}, dependsOnJobIds: [], createdAt: "2026-07-09T00:00:00.000Z", updatedAt: "2026-07-09T00:00:00.000Z" },
      { id: "job_old_2", ownerId: "demo_user", projectId: "proj_old", type: "talking_head", status: "completed", progress: 100, payload: {}, dependsOnJobIds: [], createdAt: "2026-07-09T00:00:01.000Z", updatedAt: "2026-07-09T00:00:01.000Z" },
      { id: "job_old_3", ownerId: "demo_user", projectId: "proj_old", type: "video_render", status: "completed", progress: 100, payload: {}, dependsOnJobIds: [], createdAt: "2026-07-09T00:00:02.000Z", updatedAt: "2026-07-09T00:00:02.000Z" }
    ];
    const newBatch = [
      { id: "job_new_1", ownerId: "demo_user", projectId: "proj_new", type: "avatar_generation", status: "completed", progress: 100, payload: {}, dependsOnJobIds: [], createdAt: "2026-07-10T00:00:00.000Z", updatedAt: "2026-07-10T00:00:00.000Z" },
      { id: "job_new_2", ownerId: "demo_user", projectId: "proj_new", type: "talking_head", status: "completed", progress: 100, payload: {}, dependsOnJobIds: [], createdAt: "2026-07-10T00:00:01.000Z", updatedAt: "2026-07-10T00:00:01.000Z" },
      { id: "job_new_3", ownerId: "demo_user", projectId: "proj_new", type: "video_render", status: "completed", progress: 100, payload: {}, dependsOnJobIds: [], createdAt: "2026-07-10T00:00:02.000Z", updatedAt: "2026-07-10T00:00:02.000Z" }
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        json: async () => {
          if (url === "/api/jobs") return { jobs: [...oldBatch, ...newBatch] };
          if (url === "/api/store-profiles") return { stores: [] };
          if (url === "/api/assets") return { assets: [] };
          if (url === "/api/asset-analyses") return { analyses: [] };
          if (url === "/api/avatars") return { avatars: [] };
          if (url === "/api/render-projects") return { renderProjects: [], jobs: [], outputs: [] };
          if (url === "/api/script-drafts") return { scripts: [] };
          return {};
        }
      }))
    );

    const { container } = renderDashboard();

    await screen.findByText("视频合成");
    const items = container.querySelectorAll(".timelineItem");
    expect(items).toHaveLength(3);
  });

  it("hides asset_analysis noise and only shows the latest video job", async () => {
    const jobs = [
      { id: "job_analysis", ownerId: "demo_user", projectId: "proj_a", type: "asset_analysis", status: "completed", progress: 100, payload: {}, dependsOnJobIds: [], createdAt: "2026-07-11T00:00:00.000Z", updatedAt: "2026-07-11T00:00:00.000Z" },
      { id: "job_render", ownerId: "demo_user", projectId: "proj_b", type: "video_render", status: "completed", progress: 100, payload: {}, dependsOnJobIds: [], createdAt: "2026-07-10T00:00:00.000Z", updatedAt: "2026-07-10T00:00:00.000Z" }
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        json: async () => {
          if (url === "/api/jobs") return { jobs };
          if (url === "/api/store-profiles") return { stores: [] };
          if (url === "/api/assets") return { assets: [] };
          if (url === "/api/asset-analyses") return { analyses: [] };
          if (url === "/api/avatars") return { avatars: [] };
          if (url === "/api/render-projects") return { renderProjects: [], jobs: [], outputs: [] };
          if (url === "/api/script-drafts") return { scripts: [] };
          return {};
        }
      }))
    );

    const { container } = renderDashboard();

    await screen.findByText("视频合成");
    expect(container.querySelectorAll(".timelineItem")).toHaveLength(1);
    expect(screen.queryByText("AI 识别素材")).toBeNull();
  });

  it("uploads multiple files sequentially and confirms each", async () => {
    const user = userEvent.setup();
    const uploadSpy = vi.fn();
    const savedStore = {
      id: "store_multi",
      ownerId: "demo_user",
      name: "多素材店",
      industry: "餐饮",
      location: "上海",
      mainProducts: ["牛肉面"],
      targetCustomers: ["上班族"],
      sellingPoints: ["现熬牛骨汤"],
      promotions: [],
      brandTone: "亲切接地气",
      forbiddenWords: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };

    let intentCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";

        if (url === "/api/store-profiles" && method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}"));
          return { ok: true, json: async () => ({ store: { ...savedStore, ...body, id: savedStore.id } }) };
        }

        if (url === "/api/assets/upload-intent" && method === "POST") {
          intentCount += 1;
          return {
            ok: true,
            json: async () => ({
              intent: {
                assetId: `asset_${intentCount}`,
                storageKey: `stores/store_multi/assets/asset_${intentCount}-demo.mp4`,
                uploadUrl: "https://storage.example/upload",
                headers: { "Content-Type": "video/mp4" },
                maxSizeBytes: 200 * 1024 * 1024,
                expiresInSeconds: 900
              }
            })
          };
        }

        if (url === "/api/assets/confirm" && method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}"));
          return {
            ok: true,
            json: async () => ({
              asset: {
                id: body.assetId,
                ownerId: savedStore.ownerId,
                storeId: savedStore.id,
                type: "video",
                originalFilename: body.originalFilename,
                storageKey: body.storageKey,
                mimeType: body.mimeType,
                sizeBytes: body.sizeBytes ?? 1000,
                tags: [],
                businessTags: [],
                status: "uploaded",
                createdAt: new Date().toISOString()
              }
            })
          };
        }

        if (url === "/api/assets/analyze" && method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}"));
          return {
            ok: true,
            json: async () => ({
              analysis: {
                id: `analysis_${body.assetId}`,
                assetId: body.assetId,
                visualTags: ["food"],
                businessTags: ["新品推荐"],
                keywords: ["牛肉面"],
                confidence: 0.8,
                recommendedUses: ["new_product"],
                createdAt: new Date().toISOString(),
                analysisStatus: "succeeded"
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

    const callOrder: string[] = [];
    vi.spyOn(apiClient, "uploadFileToStorage").mockImplementation(
      async (_url: string, file: File) => {
        callOrder.push(file.name);
        uploadSpy();
      }
    );

    renderDashboard();

    // The GET /api/store-profiles mock returns savedStore, so the dashboard
    // auto-hydrates and the upload zone unlocks once stores load. Wait for the
    // upload button to be enabled, mirroring the single-file upload test.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "上传素材" })).toBeEnabled();
    });

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(fileInput, [
      new File(["video"], "one.mp4", { type: "video/mp4" }),
      new File(["video"], "two.mp4", { type: "video/mp4" })
    ]);

    expect(uploadSpy).toHaveBeenCalledTimes(2);
    // Guards the load-bearing rate-limit invariant: uploads must run in
    // sequence (for...of), not concurrently (Promise.all). If this breaks,
    // the fix is to restore the sequential loop — do NOT switch to Promise.all.
    expect(callOrder).toEqual(["one.mp4", "two.mp4"]);
    expect(
      await within(screen.getByRole("status")).findByText(/已上传 2 个素材/)
    ).toBeInTheDocument();
  });

  it("continues uploading remaining files when one fails (failure isolation)", async () => {
    const user = userEvent.setup();
    const uploadSpy = vi.fn();
    const savedStore = {
      id: "store_fail",
      ownerId: "demo_user",
      name: "失败隔离店",
      industry: "餐饮",
      location: "上海",
      mainProducts: ["牛肉面"],
      targetCustomers: ["上班族"],
      sellingPoints: ["现熬牛骨汤"],
      promotions: [],
      brandTone: "亲切接地气",
      forbiddenWords: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };

    let intentCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";

        if (url === "/api/store-profiles" && method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}"));
          return { ok: true, json: async () => ({ store: { ...savedStore, ...body, id: savedStore.id } }) };
        }

        if (url === "/api/assets/upload-intent" && method === "POST") {
          intentCount += 1;
          return {
            ok: true,
            json: async () => ({
              intent: {
                assetId: `asset_${intentCount}`,
                storageKey: `stores/store_fail/assets/asset_${intentCount}-demo.mp4`,
                uploadUrl: "https://storage.example/upload",
                headers: { "Content-Type": "video/mp4" },
                maxSizeBytes: 200 * 1024 * 1024,
                expiresInSeconds: 900
              }
            })
          };
        }

        if (url === "/api/assets/confirm" && method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}"));
          return {
            ok: true,
            json: async () => ({
              asset: {
                id: body.assetId,
                ownerId: savedStore.ownerId,
                storeId: savedStore.id,
                type: "video",
                originalFilename: body.originalFilename,
                storageKey: body.storageKey,
                mimeType: body.mimeType,
                sizeBytes: body.sizeBytes ?? 1000,
                tags: [],
                businessTags: [],
                status: "uploaded",
                createdAt: new Date().toISOString()
              }
            })
          };
        }

        if (url === "/api/assets/analyze" && method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}"));
          return {
            ok: true,
            json: async () => ({
              analysis: {
                id: `analysis_${body.assetId}`,
                assetId: body.assetId,
                visualTags: ["food"],
                businessTags: ["新品推荐"],
                keywords: ["牛肉面"],
                confidence: 0.8,
                recommendedUses: ["new_product"],
                createdAt: new Date().toISOString(),
                analysisStatus: "succeeded"
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

    // First upload fails (bad.mp4), second succeeds (good.mp4).
    vi.spyOn(apiClient, "uploadFileToStorage").mockImplementation(async (_url: string, file: File) => {
      uploadSpy();
      if (file.name === "bad.mp4") {
        throw new Error("network error");
      }
    });

    renderDashboard();

    // Mirror the passing multi-file test: savedStore auto-hydrates via
    // GET /api/store-profiles, so the upload zone unlocks without wizard clicks.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "上传素材" })).toBeEnabled();
    });

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(fileInput, [
      new File(["video"], "bad.mp4", { type: "video/mp4" }),
      new File(["video"], "good.mp4", { type: "video/mp4" })
    ]);

    // Both files were attempted (failure did not abort the batch).
    expect(uploadSpy).toHaveBeenCalledTimes(2);
    expect(
      await within(screen.getByRole("status")).findByText(/成功 1 个.*失败 1 个/)
    ).toBeInTheDocument();
  });

  it("deletes an asset via the × button and removes it from the library", async () => {
    const user = userEvent.setup();
    const savedStore = {
      id: "store_del",
      ownerId: "demo_user",
      name: "删除店",
      industry: "餐饮",
      location: "上海",
      mainProducts: ["牛肉面"],
      targetCustomers: ["上班族"],
      sellingPoints: ["现熬牛骨汤"],
      promotions: [],
      brandTone: "亲切接地气",
      forbiddenWords: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    const savedAssets = [
      { id: "asset_del", ownerId: "demo_user", storeId: "store_del", type: "video", originalFilename: "del.mp4", storageKey: "k1", mimeType: "video/mp4", sizeBytes: 1000, tags: [], businessTags: [], status: "uploaded", createdAt: "2026-01-01T00:00:00.000Z" }
    ];

    const deletedIds = new Set<string>();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url === "/api/assets/asset_del" && method === "DELETE") {
        deletedIds.add("asset_del");
        return { ok: true, json: async () => ({ id: "asset_del" }) };
      }
      return {
        ok: true,
        json: async () => {
          if (url === "/api/store-profiles") return { stores: [savedStore] };
          if (url === "/api/assets") return { assets: savedAssets.filter((a) => !deletedIds.has(a.id)) };
          if (url === "/api/asset-analyses") return { analyses: [] };
          if (url === "/api/avatars") return { avatars: [] };
          if (url === "/api/jobs") return { jobs: [] };
          if (url === "/api/script-drafts") return { scripts: [] };
          return {};
        }
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    vi.spyOn(window, "confirm").mockReturnValue(true);

    renderDashboard();

    await screen.findByText("已选 1 / 共 1");
    await user.click(screen.getByRole("button", { name: "删除素材 del.mp4" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/assets/asset_del",
      expect.objectContaining({ method: "DELETE" })
    );
    expect(
      await within(screen.getByRole("status")).findByText("已删除素材。")
    ).toBeInTheDocument();

    // Card disappears + grid collapses to the empty state. This verifies the
    // full invalidate→refetch→UI loop: the stateful mock returns [] on the
    // post-DELETE GET /api/assets refetch, so the grid re-renders empty. The
    // mediaSummary ("已选 N / 共 N") is intentionally hidden when the library
    // is empty (dashboard.tsx renders it only when assets.length > 0), so the
    // empty-state copy is the authoritative signal that the card is gone.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "删除素材 del.mp4" })).not.toBeInTheDocument()
    );
    expect(await screen.findByText("拖拽或点击上传视频/图片")).toBeInTheDocument();
    expect(screen.queryByText(/已选 .* \/ 共 .*/)).not.toBeInTheDocument();
  });

  it("renders the asset library as a selectable grid and defaults to all selected", async () => {
    const savedStore = {
      id: "store_grid",
      ownerId: "demo_user",
      name: "网格店",
      industry: "餐饮",
      location: "上海",
      mainProducts: ["牛肉面"],
      targetCustomers: ["上班族"],
      sellingPoints: ["现熬牛骨汤"],
      promotions: [],
      brandTone: "亲切接地气",
      forbiddenWords: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    const savedAssets = [
      { id: "asset_a", ownerId: "demo_user", storeId: "store_grid", type: "video", originalFilename: "a.mp4", storageKey: "k1", mimeType: "video/mp4", sizeBytes: 1000, tags: [], businessTags: [], status: "uploaded", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "asset_b", ownerId: "demo_user", storeId: "store_grid", type: "image", originalFilename: "b.jpg", storageKey: "k2", mimeType: "image/jpeg", sizeBytes: 2000, tags: [], businessTags: [], status: "uploaded", createdAt: "2026-01-01T00:00:00.000Z" }
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        json: async () => {
          if (url === "/api/store-profiles") return { stores: [savedStore] };
          if (url === "/api/assets") return { assets: savedAssets };
          if (url === "/api/asset-analyses") return { analyses: [] };
          if (url === "/api/avatars") return { avatars: [] };
          if (url === "/api/jobs") return { jobs: [] };
          if (url === "/api/script-drafts") return { scripts: [] };
          return {};
        }
      }))
    );

    renderDashboard();

    expect(await screen.findByText("已选 2 / 共 2")).toBeInTheDocument();
    expect(screen.getByLabelText("选择素材 a.mp4")).toBeChecked();
    expect(screen.getByLabelText("选择素材 b.jpg")).toBeChecked();
  });

  it("disables generation when no asset is selected", async () => {
    const user = userEvent.setup();
    const savedStore = {
      id: "store_gate",
      ownerId: "demo_user",
      name: "门禁店",
      industry: "餐饮",
      location: "上海",
      mainProducts: ["牛肉面"],
      targetCustomers: ["上班族"],
      sellingPoints: ["现熬牛骨汤"],
      promotions: [],
      brandTone: "亲切接地气",
      forbiddenWords: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    const savedAssets = [
      { id: "asset_only", ownerId: "demo_user", storeId: "store_gate", type: "video", originalFilename: "only.mp4", storageKey: "k1", mimeType: "video/mp4", sizeBytes: 1000, tags: [], businessTags: [], status: "uploaded", createdAt: "2026-01-01T00:00:00.000Z" }
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        json: async () => {
          if (url === "/api/store-profiles") return { stores: [savedStore] };
          if (url === "/api/assets") return { assets: savedAssets };
          if (url === "/api/asset-analyses") return { analyses: [] };
          if (url === "/api/avatars") return { avatars: [] };
          if (url === "/api/jobs") return { jobs: [] };
          if (url === "/api/script-drafts") return { scripts: [] };
          return {};
        }
      }))
    );

    renderDashboard();

    await screen.findByText("已选 1 / 共 1");
    await user.click(screen.getByLabelText("选择素材 only.mp4"));

    expect(screen.getByText("已选 0 / 共 1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "请至少勾选一个素材" })).toBeDisabled();

    await user.click(screen.getByLabelText("选择素材 only.mp4"));

    expect(screen.getByText("已选 1 / 共 1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "生成脚本" })).toBeEnabled();
  });

  it("renders a video element for a video asset thumbnail", async () => {
    const savedStore = {
      id: "store_thumb",
      ownerId: "demo_user",
      name: "缩略图店",
      industry: "餐饮",
      location: "上海",
      mainProducts: ["牛肉面"],
      targetCustomers: ["上班族"],
      sellingPoints: ["现熬牛骨汤"],
      promotions: [],
      brandTone: "亲切接地气",
      forbiddenWords: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    const savedAssets = [
      { id: "asset_v", ownerId: "demo_user", storeId: "store_thumb", type: "video", originalFilename: "clip.mp4", storageKey: "stores/store_thumb/assets/asset_v-clip.mp4", mimeType: "video/mp4", sizeBytes: 1000, tags: [], businessTags: [], status: "uploaded", createdAt: "2026-01-01T00:00:00.000Z" }
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        json: async () => {
          if (url === "/api/store-profiles") return { stores: [savedStore] };
          if (url === "/api/assets") return { assets: savedAssets };
          if (url === "/api/asset-analyses") return { analyses: [] };
          if (url === "/api/avatars") return { avatars: [] };
          if (url === "/api/jobs") return { jobs: [] };
          if (url === "/api/script-drafts") return { scripts: [] };
          if (url === `/api/assets/asset_v/preview-url`) {
            return { url: "https://signed.example/clip", mimeType: "video/mp4", type: "video" };
          }
          return {};
        }
      }))
    );

    renderDashboard();

    const video = await screen.findByTestId("asset-thumbnail-video");
    expect(video.tagName).toBe("VIDEO");
  });

  it("keeps the placeholder when the preview-url request fails", async () => {
    const savedStore = {
      id: "store_thumbfail",
      ownerId: "demo_user",
      name: "缩略图失败店",
      industry: "餐饮",
      location: "上海",
      mainProducts: ["牛肉面"],
      targetCustomers: ["上班族"],
      sellingPoints: ["现熬牛骨汤"],
      promotions: [],
      brandTone: "亲切接地气",
      forbiddenWords: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    const savedAssets = [
      { id: "asset_f", ownerId: "demo_user", storeId: "store_thumbfail", type: "video", originalFilename: "fail.mp4", storageKey: "k1", mimeType: "video/mp4", sizeBytes: 1000, tags: [], businessTags: [], status: "uploaded", createdAt: "2026-01-01T00:00:00.000Z" }
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === `/api/assets/asset_f/preview-url`) {
          // preview-url generation fails (e.g. S3 hiccup → 503). api<T> throws on non-ok.
          return { ok: false, status: 503, json: async () => ({ error: "Failed to generate preview URL" }) };
        }
        return {
          ok: true,
          json: async () => {
            if (url === "/api/store-profiles") return { stores: [savedStore] };
            if (url === "/api/assets") return { assets: savedAssets };
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

    // Card still renders (checkbox + meta present) but no video element (placeholder stays).
    expect(await screen.findByLabelText("选择素材 fail.mp4")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByTestId("asset-thumbnail-video")).not.toBeInTheDocument()
    );
  });

  it("passes all selected assets and analyses when generating", async () => {
    const user = userEvent.setup();
    const savedStore = {
      id: "store_passall",
      ownerId: "demo_user",
      name: "全量店",
      industry: "餐饮",
      location: "上海",
      mainProducts: ["牛肉面"],
      targetCustomers: ["上班族"],
      sellingPoints: ["现熬牛骨汤"],
      promotions: [],
      brandTone: "亲切接地气",
      forbiddenWords: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    const savedAssets = [
      { id: "asset_p1", ownerId: "demo_user", storeId: "store_passall", type: "video", originalFilename: "p1.mp4", storageKey: "k1", mimeType: "video/mp4", sizeBytes: 1000, tags: [], businessTags: [], status: "uploaded", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "asset_p2", ownerId: "demo_user", storeId: "store_passall", type: "image", originalFilename: "p2.jpg", storageKey: "k2", mimeType: "image/jpeg", sizeBytes: 2000, tags: [], businessTags: [], status: "uploaded", createdAt: "2026-01-01T00:00:00.000Z" }
    ];
    const savedAnalyses = [
      { id: "analysis_p1", assetId: "asset_p1", visualTags: ["food"], businessTags: ["新品推荐"], keywords: ["面"], confidence: 0.8, recommendedUses: ["new_product"], createdAt: "2026-01-01T00:00:00.000Z", analysisStatus: "succeeded" },
      { id: "analysis_p2", assetId: "asset_p2", visualTags: ["storefront"], businessTags: ["门店引流"], keywords: ["店"], confidence: 0.7, recommendedUses: ["store_traffic"], createdAt: "2026-01-01T00:00:00.000Z", analysisStatus: "succeeded" }
    ];

    const fetchedBodies: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (method === "POST") fetchedBodies[url] = JSON.parse(String(init?.body ?? "{}"));
        return {
          ok: true,
          json: async () => {
            if (url === "/api/script-drafts") {
              return {
                script: {
                  id: "script_passall",
                  ownerId: "demo_user",
                  storeId: "store_passall",
                  purpose: "store_traffic",
                  platform: "douyin",
                  title: "引流",
                  hook: "来店",
                  scenes: [
                    {
                      order: 1,
                      text: "镜1",
                      durationSeconds: 4,
                      assetHints: [],
                      role: "presenter",
                      matchedAssetId: "asset_p1"
                    }
                  ],
                  voiceover: "来店",
                  captions: [],
                  cta: "到店",
                  generationMode: "ai",
                  complianceWarnings: [],
                  createdAt: "2026-01-02T00:00:00.000Z"
                }
              };
            }
            if (url === "/api/render-projects") return { project: { id: "proj_passall" }, jobs: [] };
            if (url === "/api/store-profiles") return { stores: [savedStore] };
            if (url === "/api/assets") return { assets: savedAssets };
            if (url === "/api/asset-analyses") return { analyses: savedAnalyses };
            if (url === "/api/avatars") return { avatars: [] };
            if (url === "/api/jobs") return { jobs: [] };
            return {};
          }
        };
      })
    );

    renderDashboard();

    await screen.findByText("已选 2 / 共 2");
    await user.click(screen.getByRole("button", { name: "生成脚本" }));

    await waitFor(() => {
      expect(fetchedBodies["/api/script-drafts"]).toBeDefined();
    });
    expect(fetchedBodies["/api/script-drafts"]).toMatchObject({
      assetAnalysisIds: expect.arrayContaining(["analysis_p1", "analysis_p2"])
    });
    expect((fetchedBodies["/api/script-drafts"] as { assetAnalysisIds: string[] }).assetAnalysisIds).toHaveLength(2);
    // 改造后：点击「生成脚本」只生成草稿，不立即建渲染项目
    expect(fetchedBodies["/api/render-projects"]).toBeUndefined();
  });

  it("does not refetch the asset list when deleting (optimistic cache update)", async () => {
    const user = userEvent.setup();
    const savedStore = {
      id: "store_norefresh",
      ownerId: "demo_user",
      name: "无刷新店",
      industry: "餐饮",
      location: "上海",
      mainProducts: ["牛肉面"],
      targetCustomers: ["上班族"],
      sellingPoints: ["现熬牛骨汤"],
      promotions: [],
      brandTone: "亲切接地气",
      forbiddenWords: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    const savedAssets = [
      { id: "asset_nr", ownerId: "demo_user", storeId: "store_norefresh", type: "video", originalFilename: "nr.mp4", storageKey: "k1", mimeType: "video/mp4", sizeBytes: 1000, tags: [], businessTags: [], status: "uploaded", createdAt: "2026-01-01T00:00:00.000Z" }
    ];

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url === "/api/assets/asset_nr" && method === "DELETE") {
        return { ok: true, json: async () => ({ id: "asset_nr" }) };
      }
      return {
        ok: true,
        json: async () => {
          if (url === "/api/store-profiles") return { stores: [savedStore] };
          if (url === "/api/assets") return { assets: savedAssets };
          if (url === "/api/asset-analyses") return { analyses: [] };
          if (url === "/api/avatars") return { avatars: [] };
          if (url === "/api/jobs") return { jobs: [] };
          if (url === "/api/script-drafts") return { scripts: [] };
          return {};
        }
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    renderDashboard();

    await screen.findByText("已选 1 / 共 1");

    const assetsGetCount = () =>
      fetchMock.mock.calls.filter(
        ([url, init]) => url === "/api/assets" && (init?.method ?? "GET") === "GET"
      ).length;
    const beforeDelete = assetsGetCount();

    await user.click(screen.getByRole("button", { name: "删除素材 nr.mp4" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/assets/asset_nr",
        expect.objectContaining({ method: "DELETE" })
      );
    });
    // Asset gone from UI via optimistic cache update.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "删除素材 nr.mp4" })).not.toBeInTheDocument()
    );

    // CRITICAL: deleting must NOT trigger a GET /api/assets refetch. Each
    // refetch costs a read against the shared L0/L2-read budget; on the
    // multi-asset dashboard it pushed read load over the limit, cascading into
    // 429s — and a failed refetch left the stale (still-has-asset) cache, so
    // the deleted asset reappeared. setQueryData updates the cache directly.
    expect(assetsGetCount()).toBe(beforeDelete);
  });

  it("prefills store-profile fields from the AI suggestion without auto-saving", async () => {
    const user = userEvent.setup();
    let suggestPosted = false;
    let storePosts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";

        if (url === "/api/store-profiles/suggest" && method === "POST") {
          suggestPosted = true;
          return {
            ok: true,
            json: async () => ({
              suggestion: {
                mainProducts: ["牛肉面", "葱油拌面"],
                sellingPoints: ["现熬牛骨汤"],
                targetCustomers: ["上班族"],
                promotions: ["午餐半价"],
                brandTone: "亲切接地气"
              }
            })
          };
        }

        if (url === "/api/store-profiles" && method === "POST") {
          storePosts += 1;
          const body = JSON.parse(String(init?.body ?? "{}"));
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
            if (url === "/api/script-drafts") return { scripts: [] };
            return {};
          }
        };
      })
    );

    renderDashboard();

    // Step 1 already has defaults (name/industry/location), advance to step 2 (产品与人设).
    await user.click(screen.getByRole("button", { name: "保存并继续" }));
    expect(screen.getByRole("heading", { name: "产品与人设" })).toBeInTheDocument();

    const suggestButton = await screen.findByRole("button", { name: /AI 建议/ });
    await user.click(suggestButton);

    expect(suggestPosted).toBe(true);
    const mainProductsInput = await screen.findByLabelText(/主营产品/);
    expect((mainProductsInput as HTMLInputElement).value).toContain("牛肉面");
    expect((mainProductsInput as HTMLInputElement).value).toContain("葱油拌面");

    // The suggestion prefills for review but does NOT auto-save the store.
    expect(storePosts).toBe(0);
    expect(
      await within(screen.getByRole("status")).findByText("AI 建议已填入，请审阅后保存。")
    ).toBeInTheDocument();
  });

  it("shows a reanalyze button for a failed analysis and calls the reanalyze endpoint on click", async () => {
    const user = userEvent.setup();
    const savedStore = {
      id: "store_reanalyze",
      ownerId: "demo_user",
      name: "重分析店",
      industry: "餐饮",
      location: "上海",
      mainProducts: ["牛肉面"],
      targetCustomers: ["上班族"],
      sellingPoints: ["现熬牛骨汤"],
      promotions: [],
      brandTone: "亲切接地气",
      forbiddenWords: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    const savedAssets = [
      { id: "asset_a", ownerId: "demo_user", storeId: "store_reanalyze", type: "video", originalFilename: "failed-clip.mp4", storageKey: "ka", mimeType: "video/mp4", sizeBytes: 1000, tags: [], businessTags: [], status: "uploaded", createdAt: "2026-01-01T00:00:00.000Z" }
    ];
    const failedAnalysis = { id: "an_1", assetId: "asset_a", visualTags: [], businessTags: [], keywords: [], confidence: 0.3, recommendedUses: [], createdAt: "2026-01-01T00:00:00.000Z", analysisStatus: "failed" };

    let reanalyzed = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (url === "/api/assets/asset_a/reanalyze" && method === "POST") {
          reanalyzed = true;
          return {
            ok: true,
            json: async () => ({
              analysis: {
                id: "an_1",
                assetId: "asset_a",
                visualTags: [],
                businessTags: ["新品推荐"],
                keywords: [],
                confidence: 0.6,
                recommendedUses: [],
                createdAt: "2026-01-01T00:00:00.000Z",
                analysisStatus: "succeeded"
              }
            })
          };
        }
        return {
          ok: true,
          json: async () => {
            if (url === "/api/store-profiles") return { stores: [savedStore] };
            if (url === "/api/assets") return { assets: savedAssets };
            if (url === "/api/asset-analyses") return { analyses: [failedAnalysis] };
            if (url === "/api/avatars") return { avatars: [] };
            if (url === "/api/jobs") return { jobs: [] };
            if (url === "/api/script-drafts") return { scripts: [] };
            return {};
          }
        };
      })
    );

    renderDashboard();

    // Asset library renders with the failed analysis visible.
    await screen.findByText("已选 1 / 共 1");
    const reanalyzeBtn = await screen.findByRole("button", { name: "重新分析" });
    await user.click(reanalyzeBtn);

    await waitFor(() => {
      expect(reanalyzed).toBe(true);
    });
  });

  it("offers 30/45/60s duration slots with 45s selected by default", async () => {
    renderDashboard();
    const slot45 = await screen.findByRole("button", { name: /约45秒/ });
    expect(slot45.className).toContain("selected");
    expect(screen.getByRole("button", { name: /约30秒/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /约60秒/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /约15秒/ })).not.toBeInTheDocument();
  });

  it("confirm card: edits voiceover, PATCHes, then creates render project with full selection", async () => {
    const user = userEvent.setup();
    const savedStore = {
      id: "store_confirm",
      ownerId: "demo_user",
      name: "确认店",
      industry: "餐饮",
      location: "上海",
      mainProducts: ["牛肉面"],
      targetCustomers: ["上班族"],
      sellingPoints: ["现熬牛骨汤"],
      promotions: [],
      brandTone: "亲切接地气",
      forbiddenWords: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    const savedAssets = [
      { id: "asset_c1", ownerId: "demo_user", storeId: "store_confirm", type: "video", originalFilename: "c1.mp4", storageKey: "k1", mimeType: "video/mp4", sizeBytes: 1000, tags: [], businessTags: [], status: "uploaded", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "asset_c2", ownerId: "demo_user", storeId: "store_confirm", type: "image", originalFilename: "c2.jpg", storageKey: "k2", mimeType: "image/jpeg", sizeBytes: 1000, tags: [], businessTags: [], status: "uploaded", createdAt: "2026-01-01T00:00:00.000Z" }
    ];
    const savedAnalyses = [
      { id: "analysis_c1", assetId: "asset_c1", visualTags: ["food"], businessTags: ["招牌菜"], keywords: [], confidence: 0.9, recommendedUses: [], analysisStatus: "succeeded", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "analysis_c2", assetId: "asset_c2", visualTags: ["food"], businessTags: ["招牌菜"], keywords: [], confidence: 0.9, recommendedUses: [], analysisStatus: "succeeded", createdAt: "2026-01-01T00:00:00.000Z" }
    ];
    const scriptPayload = {
      id: "script_confirm",
      ownerId: "demo_user",
      storeId: "store_confirm",
      purpose: "store_traffic",
      platform: "douyin",
      title: "引流",
      hook: "来店",
      scenes: [],
      voiceover: "原口播稿。",
      highlights: ["口播"],
      segments: [{ index: 0, text: "原口播稿。", speakerIndex: 0, onCamera: true }],
      captions: [],
      cta: "到店",
      generationMode: "ai",
      complianceWarnings: [],
      createdAt: "2026-01-02T00:00:00.000Z"
    };
    const fetchedBodies: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (method !== "GET") {
          fetchedBodies[`${method} ${url}`] = init?.body ? JSON.parse(init.body as string) : {};
        }
        return {
          ok: true,
          json: async () => {
            if (url === "/api/script-drafts" && method === "POST") return { script: scriptPayload };
            if (url === `/api/script-drafts/${scriptPayload.id}` && method === "PATCH") {
              const patchBody = JSON.parse(init?.body as string) as { voiceover: string };
              return { script: { ...scriptPayload, voiceover: patchBody.voiceover } };
            }
            if (url === "/api/render-projects" && method === "POST") {
              return { project: { id: "proj_confirm" }, jobs: [] };
            }
            if (url === "/api/store-profiles") return { stores: [savedStore] };
            if (url === "/api/assets") return { assets: savedAssets };
            if (url === "/api/asset-analyses") return { analyses: savedAnalyses };
            if (url === "/api/avatars") return { avatars: [] };
            if (url === "/api/jobs") return { jobs: [] };
            if (url === "/api/script-drafts") return { scripts: [] };
            return {};
          }
        };
      })
    );

    renderDashboard();

    await screen.findByText("已选 2 / 共 2");
    await user.click(screen.getByRole("button", { name: "生成脚本" }));

    // 确认卡片出现：口播稿可编辑
    const editor = await screen.findByLabelText("口播稿编辑");
    await user.clear(editor);
    await user.type(editor, "改后的口播稿。");
    await user.click(screen.getByRole("button", { name: /确认生成/ }));

    // 先 PATCH 改后的口播稿，再建渲染项目（avatars 为空 → 不带 avatarProfileIds）
    await waitFor(() => {
      expect(fetchedBodies[`PATCH /api/script-drafts/${scriptPayload.id}`]).toEqual({
        voiceover: "改后的口播稿。"
      });
    });
    await waitFor(() => {
      expect(fetchedBodies["POST /api/render-projects"]).toMatchObject({
        scriptDraftId: "script_confirm",
        selectedAssetIds: expect.arrayContaining(["asset_c1", "asset_c2"])
      });
    });
  });

  it("confirm card: surfaces an error when the voiceover PATCH fails and never creates a render project", async () => {
    const user = userEvent.setup();
    const savedStore = {
      id: "store_cfail",
      ownerId: "demo_user",
      name: "确认失败店",
      industry: "餐饮",
      location: "上海",
      mainProducts: ["牛肉面"],
      targetCustomers: ["上班族"],
      sellingPoints: ["现熬牛骨汤"],
      promotions: [],
      brandTone: "亲切接地气",
      forbiddenWords: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    const savedAssets = [
      { id: "asset_f1", ownerId: "demo_user", storeId: "store_cfail", type: "video", originalFilename: "f1.mp4", storageKey: "k1", mimeType: "video/mp4", sizeBytes: 1000, tags: [], businessTags: [], status: "uploaded", createdAt: "2026-01-01T00:00:00.000Z" }
    ];
    const savedAnalyses = [
      { id: "analysis_f1", assetId: "asset_f1", visualTags: ["food"], businessTags: ["招牌菜"], keywords: [], confidence: 0.9, recommendedUses: [], analysisStatus: "succeeded", createdAt: "2026-01-01T00:00:00.000Z" }
    ];
    const scriptPayload = {
      id: "script_cfail",
      ownerId: "demo_user",
      storeId: "store_cfail",
      purpose: "store_traffic",
      platform: "douyin",
      title: "引流",
      hook: "来店",
      scenes: [],
      voiceover: "原口播稿。",
      highlights: ["口播"],
      segments: [{ index: 0, text: "原口播稿。", speakerIndex: 0, onCamera: true }],
      captions: [],
      cta: "到店",
      generationMode: "ai",
      complianceWarnings: [],
      createdAt: "2026-01-02T00:00:00.000Z"
    };
    const fetchedBodies: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (method !== "GET") {
          fetchedBodies[`${method} ${url}`] = init?.body ? JSON.parse(init.body as string) : {};
        }
        // PATCH 超长口播稿 → 服务端 400（与 MAX_VOICEOVER_CHARS 拒绝路径同形）
        if (url === `/api/script-drafts/${scriptPayload.id}` && method === "PATCH") {
          return {
            ok: false,
            json: async () => ({ error: "voiceover must be at most 2000 characters" })
          };
        }
        return {
          ok: true,
          json: async () => {
            if (url === "/api/script-drafts" && method === "POST") return { script: scriptPayload };
            if (url === "/api/render-projects" && method === "POST") {
              return { project: { id: "proj_cfail" }, jobs: [] };
            }
            if (url === "/api/store-profiles") return { stores: [savedStore] };
            if (url === "/api/assets") return { assets: savedAssets };
            if (url === "/api/asset-analyses") return { analyses: savedAnalyses };
            if (url === "/api/avatars") return { avatars: [] };
            if (url === "/api/jobs") return { jobs: [] };
            if (url === "/api/script-drafts") return { scripts: [] };
            return {};
          }
        };
      })
    );

    renderDashboard();

    await screen.findByText("已选 1 / 共 1");
    await user.click(screen.getByRole("button", { name: "生成脚本" }));

    const editor = await screen.findByLabelText("口播稿编辑");
    await user.clear(editor);
    await user.type(editor, "改后的口播稿。");
    await user.click(screen.getByRole("button", { name: /确认生成/ }));

    // 失败可见（house style：<动作>失败：<服务端 error>）；渲染项目绝不创建；
    // 确认卡片保留、按钮恢复可点，用户可改稿重试。
    expect(
      await within(screen.getByRole("status")).findByText(
        "确认生成失败：voiceover must be at most 2000 characters"
      )
    ).toBeInTheDocument();
    expect(fetchedBodies["POST /api/render-projects"]).toBeUndefined();
    expect(screen.getByLabelText("口播稿编辑")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /确认生成/ })).toBeEnabled();
  });
});
