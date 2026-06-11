import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { registerProcessor, getProcessor } from "@/worker/processors/index";
import { assetAnalysisProcessor } from "@/worker/processors/asset-analysis";
import { avatarGenerationProcessor } from "@/worker/processors/avatar-generation";
import { videoRenderProcessor } from "@/worker/processors/video-render";
import { getAssetRepository, getAssetAnalysisRepository, getStoreRepository, getRenderRepository, getAvatarRepository } from "@/lib/repositories";
import { resetRuntimeStateForTests } from "@/lib/runtime-store";
import { nowIso } from "@/lib/ids";
import type { StoreProfile } from "@/lib/types";

// Ensure tests use memory repositories even when DATABASE_URL is configured
const savedDbUrl = process.env.DATABASE_URL;

describe("worker processor registry", () => {
  beforeEach(() => {
    delete process.env.DATABASE_URL;
    registerProcessor("asset_analysis", assetAnalysisProcessor);
    registerProcessor("avatar_generation", avatarGenerationProcessor);
    registerProcessor("video_render", videoRenderProcessor);
    registerProcessor("slideshow_render", videoRenderProcessor);
  });

  afterEach(() => {
    if (savedDbUrl) process.env.DATABASE_URL = savedDbUrl;
  });

  it("returns registered processors", () => {
    expect(getProcessor("asset_analysis")).toBeDefined();
    expect(getProcessor("avatar_generation")).toBeDefined();
    expect(getProcessor("video_render")).toBeDefined();
    expect(getProcessor("slideshow_render")).toBeDefined();
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

  it("returns a VideoOutput with the expected shape", async () => {
    const mockJob = {
      data: {
        jobId: "test-job-1",
        projectId: "test-project-1",
        ownerId: "demo_user",
        payload: {
          aspectRatio: "9:16",
          subtitleStyle: "bold_bottom",
          bgmTrackId: "bgm_warm"
        },
        dependsOnJobIds: []
      }
    };

    const result = await videoRenderProcessor(mockJob as any);
    const output = result as any;

    expect(output.id).toBeDefined();
    expect(output.id).toMatch(/^output_/);
    expect(output.renderProjectId).toBe("test-project-1");
    expect(output.storageKey).toContain("renders/");
    expect(output.storageKey).toMatch(/\.mp4$/);
    expect(output.aspectRatio).toBe("9:16");
    expect(output.durationSeconds).toBe(30);
    expect(output.status).toBe("ready");
    expect(output.createdAt).toBeDefined();
  });

  it("persists VideoOutput to the repository", async () => {
    const mockJob = {
      data: {
        jobId: "test-job-2",
        projectId: "test-project-2",
        ownerId: "demo_user",
        payload: {
          aspectRatio: "16:9",
          subtitleStyle: "clean_center"
        },
        dependsOnJobIds: []
      }
    };

    await videoRenderProcessor(mockJob as any);

    const outputs = await getRenderRepository().listOutputsByOwner("demo_user");
    expect(outputs.length).toBe(1);
    expect(outputs[0]?.renderProjectId).toBe("test-project-2");
    expect(outputs[0]?.aspectRatio).toBe("16:9");
    expect(outputs[0]?.status).toBe("ready");
  });

  it("handles missing projectId gracefully", async () => {
    const mockJob = {
      data: {
        jobId: "test-job-3",
        ownerId: "demo_user",
        payload: {
          aspectRatio: "1:1",
          subtitleStyle: "brand_card"
        },
        dependsOnJobIds: []
      }
    };

    const result = await videoRenderProcessor(mockJob as any);
    const output = result as any;

    expect(output).toBeDefined();
    expect(output.renderProjectId).toBe("");
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

    const result = await avatarGenerationProcessor(mockJob as any);
    const avatarResult = result as any;

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

    const result = await avatarGenerationProcessor(mockJob as any);
    const avatarResult = result as any;

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

    const result = await assetAnalysisProcessor(mockJob as any);
    const analysisResult = result as any;

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

    await expect(assetAnalysisProcessor(mockJob as any)).rejects.toThrow("Asset not found");
  });
});
