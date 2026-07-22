import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { registerProcessor, getProcessor } from "@/worker/processors/index";
import { assetAnalysisProcessor } from "@/worker/processors/asset-analysis";
import { avatarGenerationProcessor } from "@/worker/processors/avatar-generation";
import { videoRenderProcessor, processVideoRender } from "@/worker/processors/video-render";
import { getAssetRepository, getAssetAnalysisRepository, getStoreRepository, getRenderRepository, getAvatarRepository, getScriptRepository, getBgmTrackRepository } from "@/lib/repositories";
import { resetRuntimeStateForTests } from "@/lib/runtime-store";
import { nowIso } from "@/lib/ids";
import type { RenderProject, ScriptDraft, StoreProfile, VideoOutput } from "@/lib/types";
import type { CompositionMode } from "@/lib/services/video-compose";
import type { Job as BullJob } from "bullmq";

type AvatarResult = {
  avatarProfileId: string;
  provider: string;
  trainingStatus: string;
  fallbackMode: string;
};
type AnalysisResult = { analysisId: string };

// Ensure tests use memory repositories even when DATABASE_URL is configured
const savedDbUrl = process.env.DATABASE_URL;

describe("worker processor registry", () => {
  beforeEach(() => {
    delete process.env.DATABASE_URL;
    registerProcessor("asset_analysis", assetAnalysisProcessor);
    registerProcessor("avatar_generation", avatarGenerationProcessor);
    registerProcessor("video_render", videoRenderProcessor);
  });

  afterEach(() => {
    if (savedDbUrl) process.env.DATABASE_URL = savedDbUrl;
  });

  it("returns registered processors", () => {
    expect(getProcessor("asset_analysis")).toBeDefined();
    expect(getProcessor("avatar_generation")).toBeDefined();
    expect(getProcessor("video_render")).toBeDefined();
  });

  it("returns undefined for unknown types", () => {
    expect(getProcessor("subtitle_generation")).toBeUndefined();
  });
});

describe("video render processor", () => {
  beforeEach(() => {
    delete process.env.DATABASE_URL;
    resetRuntimeStateForTests();
  });

  afterEach(() => {
    if (savedDbUrl) process.env.DATABASE_URL = savedDbUrl;
  });

  async function seedProject(opts: {
    withTalkingHead?: boolean;
    selectedAssetIds?: string[];
  } = {}): Promise<string> {
    const now = nowIso();
    const draft: ScriptDraft = {
      id: "draft_vr",
      ownerId: "demo_user",
      storeId: "store_1",
      purpose: "promotion",
      platform: "douyin",
      title: "t",
      hook: "h",
      scenes: [
        { order: 1, text: "开场", durationSeconds: 4, assetHints: [], role: "presenter" },
        { order: 2, text: "产品", durationSeconds: 6, assetHints: [], role: "broll" }
      ],
      voiceover: "v",
      captions: [],
      cta: "c",
      generationMode: "ai",
      complianceWarnings: [],
      createdAt: now
    };
    await getScriptRepository().create(draft);
    await getAssetRepository().create({
      id: "asset_v1", ownerId: "demo_user", storeId: "store_1", type: "video",
      originalFilename: "v1.mp4", storageKey: "uploads/v1.mp4", mimeType: "video/mp4",
      sizeBytes: 1000, tags: [], businessTags: [], status: "ready", createdAt: now
    });
    await getAssetRepository().create({
      id: "asset_v2", ownerId: "demo_user", storeId: "store_1", type: "image",
      originalFilename: "v2.png", storageKey: "uploads/v2.png", mimeType: "image/png",
      sizeBytes: 500, tags: [], businessTags: [], status: "ready", createdAt: now
    });
    const project: RenderProject = {
      id: "proj_vr",
      ownerId: "demo_user",
      storeId: "store_1",
      scriptDraftId: draft.id,
      selectedAssetIds: opts.selectedAssetIds ?? ["asset_v1", "asset_v2"],
      avatarProfileId: undefined,
      purpose: "promotion",
      aspectRatio: "9:16",
      subtitleStyle: "bold_bottom",
      bgmTrackId: undefined,
      status: "processing",
      createdAt: now,
      updatedAt: now
    };
    await getRenderRepository().createProject(project);
    if (opts.withTalkingHead) {
      await getRenderRepository().createOutput({
        id: "out_th",
        ownerId: "demo_user",
        renderProjectId: project.id,
        storageKey: "avatars/th.mp4",
        aspectRatio: "9:16",
        durationSeconds: 10,
        kind: "talking_head",
        status: "ready",
        createdAt: now
      });
    }
    return project.id;
  }

  function depsWithFakeComposite(
    capture: {
      mode?: CompositionMode;
      totalDuration?: number;
      assetIds?: string[];
      talkingHeadDuration?: number;
    } = {},
    probeDurations: Record<string, number> = { asset_v1: 5 }
  ) {
    return {
      renderRepository: getRenderRepository(),
      scriptRepository: getScriptRepository(),
      assetRepository: getAssetRepository(),
      bgmTrackRepository: getBgmTrackRepository(),
      probeAssetDuration: async (asset: { id: string; type: string }) =>
        asset.type === "video" ? (probeDurations[asset.id] ?? 4) : undefined,
      renderComposite: async (input: {
        mode: CompositionMode;
        totalDurationSec: number;
        projectId: string;
        segments: Array<{ assetId: string | null }>;
        talkingHead?: { durationSeconds: number } | null;
        onProgress: (pct: number) => void;
      }) => {
        capture.mode = input.mode;
        capture.totalDuration = input.totalDurationSec;
        capture.assetIds = input.segments.map((s) => s.assetId).filter(Boolean) as string[];
        capture.talkingHeadDuration = input.talkingHead?.durationSeconds ?? undefined;
        input.onProgress(50);
        return {
          storageKey: `renders/${input.projectId}/output-fake.mp4`,
          durationSeconds: input.totalDurationSec
        };
      }
    };
  }

  it("writes a kind=final_composite VideoOutput and reports progress (asset_only)", async () => {
    const projectId = await seedProject();
    const updateProgress = vi.fn();
    const mockJob = {
      data: { jobId: "j1", projectId, ownerId: "demo_user", payload: { aspectRatio: "9:16", subtitleStyle: "bold_bottom" }, dependsOnJobIds: [] },
      updateProgress
    };
    const capture: { mode?: CompositionMode; totalDuration?: number; assetIds?: string[] } = {};
    const output = await processVideoRender(
      mockJob as unknown as BullJob,
      depsWithFakeComposite(capture) as never
    );

    expect(output.kind).toBe("final_composite");
    expect(output.renderProjectId).toBe(projectId);
    expect(output.storageKey).toContain("renders/");
    expect(capture.mode).toBe("asset_only"); // no talking-head product
    // asset_only: both assets appear; total = video(5 capped) + image(3) = 8
    expect(capture.assetIds).toEqual(["asset_v1", "asset_v2"]);
    expect(capture.totalDuration).toBeCloseTo(8, 5);
    expect(updateProgress).toHaveBeenCalled();
    const persisted = await getRenderRepository().findOutputById(output.id);
    expect(persisted?.kind).toBe("final_composite");
  });

  it("uses presenter_broll mode when a talking-head product exists", async () => {
    const projectId = await seedProject({ withTalkingHead: true });
    const capture: { mode?: CompositionMode; assetIds?: string[]; talkingHeadDuration?: number } = {};
    const mockJob = {
      data: { jobId: "j2", projectId, ownerId: "demo_user", payload: { aspectRatio: "9:16", subtitleStyle: "bold_bottom" }, dependsOnJobIds: [] },
      updateProgress: vi.fn()
    };
    await processVideoRender(mockJob as unknown as BullJob, depsWithFakeComposite(capture) as never);
    expect(capture.mode).toBe("presenter_broll");
    expect(capture.talkingHeadDuration).toBe(10);
    expect(capture.assetIds).toEqual(["asset_v1", "asset_v2"]); // Bug A fix: all assets present
  });

  it("aligns total to real probed asset durations, not planned scene durations", async () => {
    const projectId = await seedProject({ withTalkingHead: true });
    const capture: { totalDuration?: number } = {};
    const mockJob = {
      data: { jobId: "j_dur", projectId, ownerId: "demo_user", payload: { aspectRatio: "9:16", subtitleStyle: "bold_bottom" }, dependsOnJobIds: [] },
      updateProgress: vi.fn()
    };
    // talkingHead=10s. asset_v1 real=2 (cap 2), asset_v2 image (3), presenter closer scene (4).
    // contentTotal = 2+3+4 = 9 < 10 → total clamps to 9 (NOT the old planned 4+6=10).
    await processVideoRender(
      mockJob as unknown as BullJob,
      depsWithFakeComposite(capture, { asset_v1: 2 }) as never
    );
    expect(capture.totalDuration).toBeCloseTo(9, 5);
  });

  it("throws when projectId is missing", async () => {
    const mockJob = {
      data: { jobId: "j3", ownerId: "demo_user", payload: {}, dependsOnJobIds: [] },
      updateProgress: vi.fn()
    };
    await expect(
      processVideoRender(mockJob as unknown as BullJob, depsWithFakeComposite() as never)
    ).rejects.toThrow(/projectId/);
  });
});

describe("avatar generation processor", () => {
  beforeEach(() => {
    delete process.env.DATABASE_URL;
    resetRuntimeStateForTests();
  });

  afterEach(() => {
    if (savedDbUrl) process.env.DATABASE_URL = savedDbUrl;
  });

  it("creates an avatar profile via mock provider", async () => {
    const mockJob = {
      data: {
        jobId: "test-avatar-job",
        projectId: "test-project",
        ownerId: "demo_user",
        payload: {
          fallbackMode: "tts_voiceover"
        },
        dependsOnJobIds: []
      }
    };

    const result = await avatarGenerationProcessor(mockJob as unknown as BullJob);
    const avatarResult = result as unknown as AvatarResult;

    expect(avatarResult.avatarProfileId).toBeDefined();
    expect(avatarResult.provider).toBe("mock-avatar");
    expect(avatarResult.trainingStatus).toBe("ready");
    expect(avatarResult.fallbackMode).toBe("tts_voiceover");

    // Verify avatar was saved to repository
    const avatar = await getAvatarRepository().findById(avatarResult.avatarProfileId);
    expect(avatar).not.toBeNull();
    expect(avatar?.provider).toBe("mock-avatar");
  });

  it("handles existing avatar profile in payload", async () => {
    // Pre-create an avatar
    await getAvatarRepository().create({
      id: "existing_avatar_1",
      ownerId: "demo_user",
      storeId: "store_1",
      provider: "mock-avatar",
      providerAvatarId: "ext_1",
      providerVoiceId: "ext_voice_1",
      consentAcceptedAt: nowIso(),
      trainingStatus: "processing",
      fallbackMode: "tts_voiceover",
      createdAt: nowIso(),
      updatedAt: nowIso()
    });

    const mockJob = {
      data: {
        jobId: "test-avatar-existing",
        projectId: "test-project",
        ownerId: "demo_user",
        payload: {
          avatarProfileId: "existing_avatar_1",
          fallbackMode: "tts_voiceover"
        },
        dependsOnJobIds: []
      }
    };

    const result = await avatarGenerationProcessor(mockJob as unknown as BullJob);
    const avatarResult = result as unknown as AvatarResult;

    expect(avatarResult.avatarProfileId).toBe("existing_avatar_1");
    expect(avatarResult.provider).toBe("mock-avatar");
  });
});

describe("asset analysis processor", () => {
  beforeEach(() => {
    delete process.env.DATABASE_URL;
    resetRuntimeStateForTests();
  });

  afterEach(() => {
    if (savedDbUrl) process.env.DATABASE_URL = savedDbUrl;
  });

  it("classifies an asset and creates analysis", async () => {
    // Setup: create store + asset
    const store: StoreProfile = {
      id: "store_test",
      ownerId: "demo_user",
      name: "测试店",
      industry: "餐饮",
      mainProducts: ["面"],
      targetCustomers: ["上班族"],
      sellingPoints: ["快"],
      promotions: [],
      brandTone: "亲切接地气",
      forbiddenWords: [],
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    await getStoreRepository().upsert(store);

    await getAssetRepository().create({
      id: "asset_test_1",
      ownerId: "demo_user",
      storeId: "store_test",
      type: "video",
      originalFilename: "test.mp4",
      storageKey: "uploads/test.mp4",
      mimeType: "video/mp4",
      sizeBytes: 1000,
      tags: ["food", "person"],
      businessTags: [],
      status: "uploaded",
      createdAt: nowIso()
    });

    const mockJob = {
      data: {
        jobId: "test-analysis-job",
        projectId: "test-project",
        ownerId: "demo_user",
        payload: {
          assetId: "asset_test_1"
        },
        dependsOnJobIds: []
      }
    };

    const result = await assetAnalysisProcessor(mockJob as unknown as BullJob);
    const analysisResult = result as unknown as AnalysisResult;

    expect(analysisResult.analysisId).toBeDefined();

    // Verify analysis was persisted
    const analysis = await getAssetAnalysisRepository().findByAssetId("asset_test_1");
    expect(analysis).not.toBeNull();
    expect(analysis?.assetId).toBe("asset_test_1");
  });

  it("throws when asset is not found", async () => {
    const mockJob = {
      data: {
        jobId: "test-missing-asset",
        payload: { assetId: "nonexistent" },
        dependsOnJobIds: []
      }
    };

    await expect(assetAnalysisProcessor(mockJob as unknown as BullJob)).rejects.toThrow("Asset not found");
  });
});
