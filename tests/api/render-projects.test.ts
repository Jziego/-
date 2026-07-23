import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { GET, POST } from "@/app/api/render-projects/route";
import {
  getJobRepository,
  getRenderRepository,
  getScriptRepository,
  getAvatarRepository,
  getStoreRepository
} from "@/lib/repositories";
import { resetRuntimeStateForTests } from "@/lib/runtime-store";
import { createId, nowIso } from "@/lib/ids";
import type { ScriptDraft, StoreProfile, AvatarProfile } from "@/lib/types";

// Ensure tests use memory repositories even when DATABASE_URL is configured
const savedDbUrl = process.env.DATABASE_URL;

function createTestStore(): StoreProfile {
  return {
    id: createId("store"),
    ownerId: "demo_user",
    name: "测试门店",
    industry: "餐饮",
    location: "上海",
    mainProducts: ["面"],
    targetCustomers: ["上班族"],
    sellingPoints: ["快"],
    promotions: [],
    brandTone: "亲切接地气",
    forbiddenWords: [],
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
}

function createTestScript(storeId: string): ScriptDraft {
  return {
    id: createId("script"),
    ownerId: "demo_user",
    storeId,
    purpose: "promotion",
    platform: "douyin",
    title: "测试脚本",
    hook: "测试开场",
    scenes: [{ order: 1, text: "场景1", durationSeconds: 5, assetHints: [], role: "presenter" }],
    voiceover: "测试配音",
    captions: ["测试字幕"],
    cta: "测试CTA",
    generationMode: "ai",
    complianceWarnings: [],
    createdAt: nowIso()
  };
}

describe("POST /api/render-projects", () => {
  beforeEach(() => {
    delete process.env.DATABASE_URL;
    resetRuntimeStateForTests();
  });

  afterEach(() => {
    if (savedDbUrl) process.env.DATABASE_URL = savedDbUrl;
  });

  it("returns 400 when body is empty", async () => {
    const req = new Request("http://localhost/api/render-projects", {
      method: "POST",
      body: JSON.stringify({})
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("scriptDraftId");
  });

  it("returns 400 when body is not valid JSON", async () => {
    const req = new Request("http://localhost/api/render-projects", {
      method: "POST",
      body: "not-json"
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("JSON");
  });

  it("returns 404 when script draft does not exist", async () => {
    const req = new Request("http://localhost/api/render-projects", {
      method: "POST",
      body: JSON.stringify({ scriptDraftId: "nonexistent" })
    });
    const res = await POST(req);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("Script draft");
  });

  it("creates a render project with jobs when script exists (no Redis)", async () => {
    const store = createTestStore();
    await getStoreRepository().upsert(store);
    const script = createTestScript(store.id);
    await getScriptRepository().create(script);

    const req = new Request("http://localhost/api/render-projects", {
      method: "POST",
      body: JSON.stringify({
        scriptDraftId: script.id,
        selectedAssetIds: [],
        aspectRatio: "9:16",
        subtitleStyle: "bold_bottom"
      })
    });

    const res = await POST(req);
    expect(res.status).toBe(202);
    const body = await res.json();

    // jsonOk returns data directly, not wrapped in { data: ... }
    expect(body.project).toBeDefined();
    expect(body.project.status).toBe("queued");
    expect(body.jobs).toBeDefined();
    expect(body.jobs.length).toBeGreaterThanOrEqual(1);
    expect(body.enqueued).toBe(false); // no Redis in test

    // Verify project is persisted
    const saved = await getRenderRepository().findProjectById(body.project.id);
    expect(saved).not.toBeNull();
  });

  it("plans avatar_generation job before video_render when avatar is provided", async () => {
    const store = createTestStore();
    await getStoreRepository().upsert(store);
    const script = createTestScript(store.id);
    await getScriptRepository().create(script);

    const avatar: AvatarProfile = {
      id: createId("avatar"),
      ownerId: "demo_user",
      storeId: store.id,
      provider: "heygen",
      providerAvatarId: "ext_avatar_1",
      providerVoiceId: "ext_voice_1",
      consentAcceptedAt: nowIso(),
      trainingStatus: "ready",
      fallbackMode: "tts_voiceover",
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    await getAvatarRepository().create(avatar);

    const req = new Request("http://localhost/api/render-projects", {
      method: "POST",
      body: JSON.stringify({
        scriptDraftId: script.id,
        selectedAssetIds: [],
        avatarProfileId: avatar.id,
        aspectRatio: "9:16",
        subtitleStyle: "bold_bottom"
      })
    });

    const res = await POST(req);
    expect(res.status).toBe(202);
    const body = await res.json();

    const jobTypes = body.jobs.map((j: { type: string }) => j.type);
    expect(jobTypes).toContain("avatar_generation");
    expect(jobTypes).toContain("video_render");

    // video_render should depend on avatar_generation
    const videoJob = body.jobs.find((j: { type: string }) => j.type === "video_render");
    const avatarJob = body.jobs.find((j: { type: string }) => j.type === "avatar_generation");
    expect(videoJob.dependsOnJobIds).toContain(avatarJob.id);
  });

  it("persists all jobs to the repository", async () => {
    const store = createTestStore();
    await getStoreRepository().upsert(store);
    const script = createTestScript(store.id);
    await getScriptRepository().create(script);

    const req = new Request("http://localhost/api/render-projects", {
      method: "POST",
      body: JSON.stringify({
        scriptDraftId: script.id,
        selectedAssetIds: [],
        aspectRatio: "16:9",
        subtitleStyle: "bold_bottom"
      })
    });

    await POST(req);
    const jobs = await getJobRepository().listByOwner("demo_user");
    expect(jobs.length).toBeGreaterThanOrEqual(1);
    expect(jobs.every((j) => j.status === "queued")).toBe(true);
  });
});

describe("GET /api/render-projects", () => {
  beforeEach(() => {
    delete process.env.DATABASE_URL;
    resetRuntimeStateForTests();
  });

  afterEach(() => {
    if (savedDbUrl) process.env.DATABASE_URL = savedDbUrl;
  });

  it("returns empty lists when no projects exist", async () => {
    const res = await GET(new Request("http://localhost/api/render-projects"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.renderProjects).toEqual([]);
    expect(body.jobs).toEqual([]);
    expect(body.outputs).toEqual([]);
  });

  it("returns existing projects and jobs", async () => {
    const store = createTestStore();
    await getStoreRepository().upsert(store);
    const script = createTestScript(store.id);
    await getScriptRepository().create(script);

    // Create a project via POST
    const req = new Request("http://localhost/api/render-projects", {
      method: "POST",
      body: JSON.stringify({ scriptDraftId: script.id, selectedAssetIds: [], aspectRatio: "9:16", subtitleStyle: "bold_bottom" })
    });
    await POST(req);

    const res = await GET(new Request("http://localhost/api/render-projects"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.renderProjects.length).toBe(1);
    expect(body.jobs.length).toBeGreaterThan(0);
  });

  it("caps outputs count so completed videos don't pile up in the preview", async () => {
    const repo = getRenderRepository();
    for (let i = 0; i < 25; i++) {
      await repo.createOutput({
        id: createId("output"),
        ownerId: "demo_user",
        renderProjectId: null,
        storageKey: `renders/proj/out-${i}.mp4`,
        aspectRatio: "9:16",
        durationSeconds: 30,
        kind: "final_composite",
        status: "ready",
        createdAt: `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`
      });
    }

    const res = await GET(new Request("http://localhost/api/render-projects"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.outputs.length).toBeLessThanOrEqual(20);
    expect(body.outputs[0].createdAt).toBe("2026-01-01T00:00:24Z");
  });
});
