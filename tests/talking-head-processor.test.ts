import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { processTalkingHead } from "@/worker/processors/talking-head";
import {
  getAvatarRepository,
  getRenderRepository,
  getScriptRepository
} from "@/lib/repositories";
import { MemoryAvatarRepository } from "@/lib/repositories/memory";
import { resetRuntimeStateForTests } from "@/lib/runtime-store";
import { nowIso } from "@/lib/ids";
import type { AvatarProvider } from "@/lib/services/avatar-provider";
import { createMockProvider } from "@/lib/services/providers/mock";
import type { VoiceTrackManifest } from "@/lib/services/voice-track";
import type { AvatarProfile, ScriptDraft, ScriptSegment } from "@/lib/types";
import type { Job as BullJob } from "bullmq";

// Force memory repositories regardless of DATABASE_URL
const savedDbUrl = process.env.DATABASE_URL;

describe("talking_head processor", () => {
  beforeEach(() => {
    delete process.env.DATABASE_URL;
    resetRuntimeStateForTests();
  });

  afterEach(() => {
    if (savedDbUrl) process.env.DATABASE_URL = savedDbUrl;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function seedDraft(): Promise<ScriptDraft> {
    const now = nowIso();
    const draft: ScriptDraft = {
      id: "draft_1",
      ownerId: "owner_1",
      storeId: "store_1",
      purpose: "promotion",
      platform: "douyin",
      title: "招牌推广",
      hook: "现做现卖",
      scenes: [],
      voiceover: "今天来店里尝尝刚出炉的招牌产品",
      captions: [],
      cta: "到店引流",
      generationMode: "ai",
      complianceWarnings: [],
      createdAt: now
    };
    await getScriptRepository().create(draft);
    return draft;
  }

  async function seedAvatarAndDraft(providerAvatarId: string | undefined): Promise<{
    avatar: AvatarProfile;
    draft: ScriptDraft;
  }> {
    const now = nowIso();
    const avatar: AvatarProfile = {
      id: "av_1",
      ownerId: "owner_1",
      storeId: "store_1",
      name: "",
      provider: "mock-avatar",
      providerAvatarId,
      providerVoiceId: "provider_v_1",
      consentStatus: "approved",
      consentAcceptedAt: now,
      trainingStatus: "ready",
      fallbackMode: "tts_voiceover",
      createdAt: now,
      updatedAt: now
    };
    await getAvatarRepository().create(avatar);

    const draft = await seedDraft();

    return { avatar, draft };
  }

  /** A provider whose generateTalkingHead drives onProgress and returns a known key. */
  function fakeProvider(): AvatarProvider {
    return {
      ...createMockProvider(),
      async generateTalkingHead(
        _input: { providerAvatarId: string; providerVoiceId?: string; scriptText: string },
        onProgress?: (attempt: number, maxAttempts: number) => void,
      ) {
        onProgress?.(1, 4);
        onProgress?.(2, 4);
        return { videoAssetId: "avatars/vid_fake.mp4", durationSeconds: 14 };
      }
    };
  }

  function depsWith(
    provider: AvatarProvider,
    uploadManifest: (key: string, manifest: VoiceTrackManifest) => Promise<void> = async () => {},
  ) {
    return {
      avatarRepository: getAvatarRepository(),
      scriptRepository: getScriptRepository(),
      renderRepository: getRenderRepository(),
      provider,
      uploadManifest
    };
  }

  it("writes a kind=talking_head VideoOutput and reports progress", async () => {
    const { avatar, draft } = await seedAvatarAndDraft("provider_av_1");
    const updateProgress = vi.fn();
    const mockJob = {
      data: {
        jobId: "job_1",
        projectId: "proj_1",
        ownerId: "owner_1",
        payload: { avatarProfileId: avatar.id, scriptDraftId: draft.id },
        dependsOnJobIds: []
      },
      updateProgress
    };

    const output = await processTalkingHead(mockJob as unknown as BullJob, depsWith(fakeProvider()));

    expect(output.kind).toBe("talking_head");
    expect(output.storageKey).toBe("avatars/vid_fake.mp4");
    expect(output.durationSeconds).toBe(14);
    expect(output.renderProjectId).toBe("proj_1");

    // Progress: poll(1/4)->25, poll(2/4)->45, then 90 (post-call), then 100 (final).
    const pcts = updateProgress.mock.calls.map((c) => c[0]);
    expect(pcts).toContain(25);
    expect(pcts).toContain(45);
    expect(pcts).toContain(90);
    expect(pcts[pcts.length - 1]).toBe(100);

    // Persisted and queryable by project.
    const th = await getRenderRepository().findTalkingHeadOutputByProject("proj_1");
    expect(th?.kind).toBe("talking_head");
    expect(th?.storageKey).toBe("avatars/vid_fake.mp4");
  });

  it("uses renderProjectId=null for preview jobs (no projectId)", async () => {
    const { avatar, draft } = await seedAvatarAndDraft("provider_av_1");
    const mockJob = {
      data: {
        jobId: "job_2",
        projectId: undefined,
        ownerId: "owner_1",
        payload: { avatarProfileId: avatar.id, scriptDraftId: draft.id },
        dependsOnJobIds: []
      },
      updateProgress: vi.fn()
    };

    const output = await processTalkingHead(mockJob as unknown as BullJob, depsWith(fakeProvider()));

    expect(output.renderProjectId).toBe(null);
    expect(output.kind).toBe("talking_head");
  });

  it("throws when the avatar profile is not ready (no providerAvatarId)", async () => {
    const { draft } = await seedAvatarAndDraft(undefined);

    const mockJob = {
      data: {
        jobId: "job_3",
        projectId: "proj_x",
        ownerId: "owner_1",
        payload: { avatarProfileId: "av_1", scriptDraftId: draft.id },
        dependsOnJobIds: []
      },
      updateProgress: vi.fn()
    };

    await expect(
      processTalkingHead(mockJob as unknown as BullJob, depsWith(fakeProvider())),
    ).rejects.toThrow(/not ready/);
  });

  it("resolves the platform avatar from the env template without hitting the avatar repo", async () => {
    vi.stubEnv("HEYGEN_AVATAR_TEMPLATE_ID", "tpl_platform");
    vi.stubEnv("HEYGEN_VOICE_ID", "voice_platform");
    const draft = await seedDraft(); // 无 avatar_platform 持久化行
    const findByIdSpy = vi.spyOn(MemoryAvatarRepository.prototype, "findById");

    const seen: { providerAvatarId?: string; providerVoiceId?: string } = {};
    const provider: AvatarProvider = {
      ...createMockProvider(),
      async generateTalkingHead(input) {
        seen.providerAvatarId = input.providerAvatarId;
        seen.providerVoiceId = input.providerVoiceId;
        return { videoAssetId: "avatars/platform_tpl.mp4", durationSeconds: 12 };
      }
    };

    const mockJob = {
      data: {
        jobId: "job_platform_tpl",
        projectId: "proj_platform",
        ownerId: "owner_1",
        payload: { avatarProfileId: "avatar_platform", scriptDraftId: draft.id },
        dependsOnJobIds: []
      },
      updateProgress: vi.fn()
    };

    const output = await processTalkingHead(mockJob as unknown as BullJob, depsWith(provider));

    expect(output.kind).toBe("talking_head");
    expect(output.storageKey).toBe("avatars/platform_tpl.mp4");
    expect(seen.providerAvatarId).toBe("tpl_platform");
    expect(seen.providerVoiceId).toBe("voice_platform");
    // 平台公共形象是约定 id：不查库。
    expect(findByIdSpy.mock.calls.some((c) => c[0] === "avatar_platform")).toBe(false);
  });

  it("falls back to the provider stock avatar when no env template is configured", async () => {
    const draft = await seedDraft();
    const seen: { providerAvatarId?: string; providerVoiceId?: string } = {};
    const createAvatar = vi.fn(async () => ({
      providerAvatarId: "stock_av_1",
      providerVoiceId: "stock_voice_1"
    }));
    const provider: AvatarProvider = {
      ...createMockProvider(),
      createAvatar,
      async generateTalkingHead(input) {
        seen.providerAvatarId = input.providerAvatarId;
        seen.providerVoiceId = input.providerVoiceId;
        return { videoAssetId: "avatars/platform_stock.mp4", durationSeconds: 9 };
      }
    };

    const mockJob = {
      data: {
        jobId: "job_platform_stock",
        projectId: "proj_platform",
        ownerId: "owner_1",
        payload: { avatarProfileId: "avatar_platform", scriptDraftId: draft.id },
        dependsOnJobIds: []
      },
      updateProgress: vi.fn()
    };

    const output = await processTalkingHead(mockJob as unknown as BullJob, depsWith(provider));

    expect(output.kind).toBe("talking_head");
    expect(createAvatar).toHaveBeenCalledWith({ trainingVideoAssetId: "", ownerId: "owner_1" });
    expect(seen.providerAvatarId).toBe("stock_av_1");
    expect(seen.providerVoiceId).toBe("stock_voice_1");
  });

  describe("segmented synthesis (Phase 3)", () => {
    const DEFAULT_SEGMENTS: ScriptSegment[] = [
      { index: 0, text: "开场白。", speakerIndex: 0, onCamera: true },
      { index: 1, text: "画外音介绍产品细节。", speakerIndex: 0, onCamera: false },
    ];

    async function seedSegmentedDraft(overrides: Partial<ScriptDraft> = {}): Promise<ScriptDraft> {
      const now = nowIso();
      const draft: ScriptDraft = {
        id: "draft_seg",
        ownerId: "owner_1",
        storeId: "store_1",
        purpose: "promotion",
        platform: "douyin",
        title: "分段口播",
        hook: "开场钩子",
        scenes: [],
        voiceover: "开场白。画外音介绍产品细节。",
        captions: [],
        cta: "到店引流",
        generationMode: "ai",
        complianceWarnings: [],
        segments: DEFAULT_SEGMENTS,
        ...overrides,
        createdAt: now
      };
      await getScriptRepository().create(draft);
      return draft;
    }

    function makeSegmentJob(payload: Record<string, unknown>, projectId = "render_x") {
      return {
        data: {
          jobId: "job_seg",
          projectId,
          ownerId: "owner_1",
          payload,
          dependsOnJobIds: []
        },
        updateProgress: vi.fn()
      } as unknown as BullJob;
    }

    /** 类型化的 uploadManifest 捕获 mock（便于断言 manifest 内容）。 */
    function manifestSpy() {
      return vi.fn<(key: string, manifest: VoiceTrackManifest) => Promise<void>>(async () => {});
    }

    it("onCamera→video, offCamera→TTS; persists manifest output", async () => {
      await seedAvatarAndDraft("provider_av_1"); // av_1 ready（providerVoiceId=provider_v_1）
      const draft = await seedSegmentedDraft();
      const uploadManifest = manifestSpy();

      const result = await processTalkingHead(
        makeSegmentJob({ avatarProfileIds: ["av_1"], scriptDraftId: draft.id }),
        depsWith(createMockProvider(), uploadManifest)
      );

      expect(result.kind).toBe("segmented_voice");
      expect(result.storageKey).toBe("voice-tracks/render_x/manifest.json");

      expect(uploadManifest).toHaveBeenCalledTimes(1);
      const [key, manifest] = uploadManifest.mock.calls[0]!;
      expect(key).toBe("voice-tracks/render_x/manifest.json");
      expect(manifest.version).toBe(1);
      expect(manifest.segments).toHaveLength(2);
      expect(manifest.segments[0]).toMatchObject({
        index: 0,
        onCamera: true,
        videoStorageKey: expect.stringMatching(/^avatar_video_/)
      });
      expect(manifest.segments[0]?.audioStorageKey).toBeUndefined();
      expect(manifest.segments[1]).toMatchObject({
        index: 1,
        onCamera: false,
        audioStorageKey: expect.stringMatching(/^voice_audio_/)
      });
      expect(manifest.segments[1]?.words?.length).toBeGreaterThan(0);
      expect(manifest.totalDurationSec).toBeGreaterThan(0);

      // 分段产物同样经 findTalkingHeadOutputByProject 供 video_render 消费。
      const persisted = await getRenderRepository().findTalkingHeadOutputByProject("render_x");
      expect(persisted?.kind).toBe("segmented_voice");
      expect(persisted?.storageKey).toBe("voice-tracks/render_x/manifest.json");
    });

    it("speakerIndex resolves via draft.speakerAvatarIds, unlisted id falls back into the selected list", async () => {
      const now = nowIso();
      const seedAvatar = async (id: string, providerAvatarId: string, providerVoiceId: string) => {
        const avatar: AvatarProfile = {
          id,
          ownerId: "owner_1",
          storeId: "store_1",
          name: "",
          provider: "mock-avatar",
          providerAvatarId,
          providerVoiceId,
          consentStatus: "approved",
          consentAcceptedAt: now,
          trainingStatus: "ready",
          fallbackMode: "tts_voiceover",
          createdAt: now,
          updatedAt: now
        };
        await getAvatarRepository().create(avatar);
      };
      await seedAvatar("av_a", "pav_a", "pv_a");
      await seedAvatar("av_b", "pav_b", "pv_b");

      // 生成时 personas 顺序为 [av_c, av_b]，本次渲染只选了 [av_a, av_b]（av_c 被取消勾选）
      const draft = await seedSegmentedDraft({
        speakerAvatarIds: ["av_c", "av_b"],
        segments: [
          { index: 0, text: "第一句。", speakerIndex: 0, onCamera: true },
          { index: 1, text: "第二句。", speakerIndex: 1, onCamera: true },
        ]
      });

      const seenAvatars: string[] = [];
      const seenVoices: (string | undefined)[] = [];
      const provider: AvatarProvider = {
        ...createMockProvider(),
        async generateTalkingHead(input) {
          seenAvatars.push(input.providerAvatarId);
          seenVoices.push(input.providerVoiceId);
          return { videoAssetId: "avatar_video_seen.mp4", durationSeconds: 5 };
        }
      };

      await processTalkingHead(
        makeSegmentJob({ avatarProfileIds: ["av_a", "av_b"], scriptDraftId: draft.id }),
        depsWith(provider, manifestSpy())
      );

      // 段0: speakerAvatarIds[0]=av_c 未选中 → 回退选中集（clamp 下标 → 首选中 av_a）
      // 段1: speakerAvatarIds[1]=av_b 已选中 → byId 对齐到 av_b（而非默认首选中 av_a）
      expect(seenAvatars).toEqual(["pav_a", "pav_b"]);
      expect(seenVoices).toEqual(["pv_a", "pv_b"]);
    });

    it("TTS failure retries once then falls back to a talking-head video for that segment", async () => {
      await seedAvatarAndDraft("provider_av_1");
      const offCameraOnly: ScriptSegment[] = [
        { index: 0, text: "画外音。", speakerIndex: 0, onCamera: false },
      ];

      // 第一次 TTS 抛错、第二次成功 → 正常音频段，无降级标记
      const retryDraft = await seedSegmentedDraft({ id: "draft_retry", segments: offCameraOnly });
      const uploadRetry = manifestSpy();
      await processTalkingHead(
        makeSegmentJob({ avatarProfileIds: ["av_1"], scriptDraftId: retryDraft.id }),
        depsWith(createMockProvider({ failTtsOnce: true }), uploadRetry)
      );
      const retryManifest = uploadRetry.mock.calls[0]![1];
      expect(retryManifest.segments[0]?.audioStorageKey).toMatch(/^voice_audio_/);
      expect(retryManifest.segments[0]?.fellBackToVideo).toBeUndefined();

      // TTS 持续失败（重试 1 次仍失败）→ 降级为该段数字人视频
      const failDraft = await seedSegmentedDraft({ id: "draft_fail", segments: offCameraOnly });
      const uploadFail = manifestSpy();
      await processTalkingHead(
        makeSegmentJob({ avatarProfileIds: ["av_1"], scriptDraftId: failDraft.id }),
        depsWith(createMockProvider({ failTts: true }), uploadFail)
      );
      const failManifest = uploadFail.mock.calls[0]![1];
      expect(failManifest.segments[0]?.videoStorageKey).toMatch(/^avatar_video_/);
      expect(failManifest.segments[0]?.audioStorageKey).toBeUndefined();
      expect(failManifest.segments[0]?.fellBackToVideo).toBe(true);
    });

    it("legacy: draft without segments keeps the single-video path", async () => {
      const { avatar, draft } = await seedAvatarAndDraft("provider_av_1");
      const uploadManifest = manifestSpy();

      const output = await processTalkingHead(
        makeSegmentJob({ avatarProfileIds: [avatar.id], scriptDraftId: draft.id }),
        depsWith(createMockProvider(), uploadManifest)
      );

      expect(output.kind).toBe("talking_head");
      expect(output.storageKey).toMatch(/^avatar_video_/);
      expect(uploadManifest).not.toHaveBeenCalled();
    });
  });
});
