import { describe, expect, it } from "vitest";
import { createRenderProject, planRenderJobs, recoverRenderFailure } from "@/lib/services/render-pipeline";
import type { AvatarProfile, ScriptDraft } from "@/lib/types";

const script: ScriptDraft = {
  id: "script_1",
  ownerId: "user_1",
  storeId: "store_1",
  purpose: "promotion",
  platform: "douyin",
  title: "今晚来甜心烘焙带走现烤可颂",
  hook: "刚出炉的香气，路过很难不进店",
  scenes: [
    {
      order: 1,
      text: "展示门店和出炉画面",
      durationSeconds: 4,
      assetHints: ["门店环境", "新品推荐"]
    },
    {
      order: 2,
      text: "展示促销套餐",
      durationSeconds: 6,
      assetHints: ["促销"]
    }
  ],
  voiceover: "今天下午茶，来甜心烘焙带一份刚出炉的可颂。",
  captions: ["刚出炉的可颂", "下午茶套餐上线"],
  cta: "到店领取下午茶套餐",
  generationMode: "ai",
  complianceWarnings: [],
  createdAt: "2026-06-03T10:00:00.000Z"
};

const avatar: AvatarProfile = {
  id: "avatar_1",
  ownerId: "user_1",
  storeId: "store_1",
  provider: "heygen",
  providerAvatarId: "external_avatar",
  providerVoiceId: "external_voice",
  consentAcceptedAt: "2026-06-03T10:00:00.000Z",
  trainingStatus: "ready",
  fallbackMode: "tts_voiceover",
  createdAt: "2026-06-03T10:00:00.000Z",
  updatedAt: "2026-06-03T10:00:00.000Z"
};

describe("render pipeline", () => {
  it("locks selected assets, script and output settings into a project", () => {
    const project = createRenderProject({
      ownerId: "user_1",
      storeId: "store_1",
      scriptDraft: script,
      selectedAssetIds: ["asset_1", "asset_2"],
      avatarProfile: avatar,
      aspectRatio: "9:16",
      subtitleStyle: "bold_bottom",
      bgmTrackId: "bgm_warm"
    });

    expect(project.status).toBe("queued");
    expect(project.avatarProfileId).toBe("avatar_1");
    expect(project.selectedAssetIds).toEqual(["asset_1", "asset_2"]);
  });

  it("plans avatar_generation -> talking_head -> video_render when a digital human is selected", () => {
    const project = createRenderProject({
      ownerId: "user_1",
      storeId: "store_1",
      scriptDraft: script,
      selectedAssetIds: ["asset_1"],
      avatarProfile: avatar,
      aspectRatio: "9:16",
      subtitleStyle: "bold_bottom",
      bgmTrackId: "bgm_warm"
    });

    const jobs = planRenderJobs({ project, includeAvatar: true });

    expect(jobs.map((job) => job.type)).toEqual([
      "avatar_generation",
      "talking_head",
      "video_render"
    ]);

    const avatarJob = jobs.find((j) => j.type === "avatar_generation")!;
    const talkingJob = jobs.find((j) => j.type === "talking_head")!;
    const renderJob = jobs.find((j) => j.type === "video_render")!;

    // talking_head depends on avatar_generation
    expect(talkingJob.dependsOnJobIds).toEqual([avatarJob.id]);
    // talking_head carries avatar + scriptDraft for the processor to resolve
    expect(talkingJob.payload).toMatchObject({
      avatarProfileId: "avatar_1",
      scriptDraftId: "script_1"
    });
    // video_render depends on both prior jobs (runs last via FlowProducer children-first)
    expect(renderJob.dependsOnJobIds).toEqual(
      expect.arrayContaining([avatarJob.id, talkingJob.id])
    );
  });

  it("omits avatar_generation and talking_head when includeAvatar is false", () => {
    const project = createRenderProject({
      ownerId: "user_1",
      storeId: "store_1",
      scriptDraft: script,
      selectedAssetIds: ["asset_1"],
      aspectRatio: "9:16",
      subtitleStyle: "bold_bottom"
    });

    const jobs = planRenderJobs({ project, includeAvatar: false });

    expect(jobs.map((job) => job.type)).toEqual(["video_render"]);
    expect(jobs[0]?.dependsOnJobIds).toEqual([]);
  });

  it("falls back to a slideshow render when full video composition fails", () => {
    const recovered = recoverRenderFailure({
      projectId: "render_1",
      ownerId: "user_1",
      reason: "ffmpeg_timeout"
    });

    expect(recovered.type).toBe("slideshow_render");
    expect(recovered.status).toBe("queued");
    expect(recovered.payload.fallbackReason).toBe("ffmpeg_timeout");
  });
});
