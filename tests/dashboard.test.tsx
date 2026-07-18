import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "@/components/dashboard";
import { Providers } from "@/components/providers";
import * as apiClient from "@/lib/api-client";

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
                createdAt: new Date().toISOString()
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
                createdAt: new Date().toISOString()
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
                createdAt: new Date().toISOString()
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
    expect(screen.getByRole("button", { name: "开始生成视频" })).toBeEnabled();
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
});
