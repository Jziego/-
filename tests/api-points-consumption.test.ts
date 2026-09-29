import { describe, expect, it, vi, beforeEach } from "vitest";

const { getOwnerIdMock, consumeMock, repos, scriptEngine, renderPipeline } = vi.hoisted(
  () => ({
    getOwnerIdMock: vi.fn(),
    consumeMock: vi.fn(),
    repos: {
      store: { findById: vi.fn() },
      assetAnalysis: { listByIds: vi.fn() },
      avatar: { findById: vi.fn(), listByOwner: vi.fn() },
      script: { findById: vi.fn(), create: vi.fn() },
      render: { createProject: vi.fn() },
      job: { createMany: vi.fn() },
    },
    scriptEngine: {
      createScriptDraft: vi.fn(),
      createTemplateScriptDraft: vi.fn(),
    },
    renderPipeline: {
      createRenderProject: vi.fn(),
      planRenderJobs: vi.fn(),
    },
  }),
);

vi.mock("@/lib/auth-helpers", () => ({ getOwnerId: getOwnerIdMock }));
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return { ...actual, applyRateLimit: vi.fn(() => Promise.resolve(null)) };
});
vi.mock("@/lib/points", () => ({
  consumePoints: consumeMock,
  PointsExhaustedError: class PointsExhaustedError extends Error {
    constructor() {
      super("积分已用完，请联系客服充值");
      this.name = "PointsExhaustedError";
    }
  },
}));
// 路由的 repositories 工厂与生成/渲染服务：全部占位，按用例逐個 stub。
vi.mock("@/lib/repositories", () => ({
  getStoreRepository: () => repos.store,
  getAssetAnalysisRepository: () => repos.assetAnalysis,
  getAvatarRepository: () => repos.avatar,
  getScriptRepository: () => repos.script,
  getRenderRepository: () => repos.render,
  getJobRepository: () => repos.job,
}));
vi.mock("@/lib/services/script-engine", () => ({
  createScriptDraft: scriptEngine.createScriptDraft,
  createTemplateScriptDraft: scriptEngine.createTemplateScriptDraft,
}));
vi.mock("@/lib/services/render-pipeline", () => ({
  createRenderProject: renderPipeline.createRenderProject,
  planRenderJobs: renderPipeline.planRenderJobs,
}));

import { POST as scriptPOST } from "@/app/api/script-drafts/route";
import { POST as renderPOST } from "@/app/api/render-projects/route";
import { POST as talkingHeadPOST } from "@/app/api/avatars/talking-head/route";

describe("扣费接入", () => {
  beforeEach(() => vi.clearAllMocks());

  it("写稿：校验通过后扣 10 积分，成功 201", async () => {
    getOwnerIdMock.mockResolvedValue("u1");
    consumeMock.mockResolvedValue({ balance: 220 });
    repos.store.findById.mockResolvedValue({ id: "s1", ownerId: "u1" });
    repos.avatar.listByOwner.mockResolvedValue([]);
    scriptEngine.createScriptDraft.mockResolvedValue({ id: "d1" });
    repos.script.create.mockResolvedValue({ id: "d1" });

    const res = await scriptPOST(
      new Request("http://localhost/api/script-drafts", {
        method: "POST",
        body: JSON.stringify({ storeId: "s1", purpose: "store_traffic" }),
      }),
    );
    expect(res.status).toBe(201);
    expect(consumeMock).toHaveBeenCalledWith("u1", 10, "生成口播稿");
  });

  it("写稿：余额不足 402（points_exhausted + 精确中文文案）且不再生成", async () => {
    getOwnerIdMock.mockResolvedValue("u1");
    const { PointsExhaustedError } = await import("@/lib/points");
    consumeMock.mockRejectedValue(new PointsExhaustedError());
    repos.store.findById.mockResolvedValue({ id: "s1", ownerId: "u1" });
    repos.avatar.listByOwner.mockResolvedValue([]);

    const res = await scriptPOST(
      new Request("http://localhost/api/script-drafts", {
        method: "POST",
        body: JSON.stringify({ storeId: "s1", purpose: "store_traffic" }),
      }),
    );
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toBe("points_exhausted");
    expect(body.message).toBe("积分已用完，请联系客服充值");
    // createScriptDraft / createTemplateScriptDraft 未被调用（扣费在生成之前）
    expect(scriptEngine.createScriptDraft).not.toHaveBeenCalled();
    expect(scriptEngine.createTemplateScriptDraft).not.toHaveBeenCalled();
  });

  it("渲染：2 个形象扣 530（30+250×2），余额不足 402", async () => {
    getOwnerIdMock.mockResolvedValue("u1");
    const { PointsExhaustedError } = await import("@/lib/points");
    consumeMock.mockRejectedValue(new PointsExhaustedError());
    repos.script.findById.mockResolvedValue({ id: "d1", ownerId: "u1", storeId: "s1" });
    repos.avatar.findById.mockImplementation(async (id: string) => ({
      id,
      ownerId: "u1",
      trainingStatus: "ready",
      providerAvatarId: `p_${id}`,
    }));

    const res = await renderPOST(
      new Request("http://localhost/api/render-projects", {
        method: "POST",
        body: JSON.stringify({ scriptDraftId: "d1", avatarProfileIds: ["av1", "av2"] }),
      }),
    );
    expect(res.status).toBe(402);
    expect(consumeMock).toHaveBeenCalledWith("u1", 530, "渲染视频（数字人×2）");
    // 扣费之后的建项目/入队未被触达
    expect(renderPipeline.createRenderProject).not.toHaveBeenCalled();
    expect(renderPipeline.planRenderJobs).not.toHaveBeenCalled();
    expect(repos.render.createProject).not.toHaveBeenCalled();
    expect(repos.job.createMany).not.toHaveBeenCalled();
  });

  it("渲染：无数字人扣 30，reason 为「渲染视频」", async () => {
    getOwnerIdMock.mockResolvedValue("u1");
    const { PointsExhaustedError } = await import("@/lib/points");
    consumeMock.mockRejectedValue(new PointsExhaustedError());
    repos.script.findById.mockResolvedValue({ id: "d1", ownerId: "u1", storeId: "s1" });

    const res = await renderPOST(
      new Request("http://localhost/api/render-projects", {
        method: "POST",
        body: JSON.stringify({ scriptDraftId: "d1" }),
      }),
    );
    expect(res.status).toBe(402);
    expect(consumeMock).toHaveBeenCalledWith("u1", 30, "渲染视频");
  });

  it("talking-head：扣 250（数字人出镜），余额不足 402", async () => {
    getOwnerIdMock.mockResolvedValue("u1");
    const { PointsExhaustedError } = await import("@/lib/points");
    consumeMock.mockRejectedValue(new PointsExhaustedError());
    // platform avatar 免查库；草稿属主匹配
    repos.script.findById.mockResolvedValue({ id: "d1", ownerId: "u1", storeId: "s1" });

    const res = await talkingHeadPOST(
      new Request("http://localhost/api/avatars/talking-head", {
        method: "POST",
        body: JSON.stringify({ avatarProfileId: "avatar_platform", scriptDraftId: "d1" }),
      }),
    );
    expect(res.status).toBe(402);
    expect(consumeMock).toHaveBeenCalledWith("u1", 250, "数字人出镜");
    // 扣费之后的建 job/入队未被触达
    expect(repos.job.createMany).not.toHaveBeenCalled();
  });
});
