import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { processTalkingHead } from "@/worker/processors/talking-head";
import {
  getAvatarRepository,
  getRenderRepository,
  getScriptRepository
} from "@/lib/repositories";
import { resetRuntimeStateForTests } from "@/lib/runtime-store";
import { nowIso } from "@/lib/ids";
import type { AvatarProvider } from "@/lib/services/avatar-provider";
import type { AvatarProfile, ScriptDraft } from "@/lib/types";
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
  });

  async function seedAvatarAndDraft(providerAvatarId: string | undefined): Promise<{
    avatar: AvatarProfile;
    draft: ScriptDraft;
  }> {
    const now = nowIso();
    const avatar: AvatarProfile = {
      id: "av_1",
      ownerId: "owner_1",
      storeId: "store_1",
      provider: "mock-avatar",
      providerAvatarId,
      providerVoiceId: "provider_v_1",
      consentAcceptedAt: now,
      trainingStatus: "ready",
      fallbackMode: "tts_voiceover",
      createdAt: now,
      updatedAt: now
    };
    await getAvatarRepository().create(avatar);

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

    return { avatar, draft };
  }

  /** A provider whose generateTalkingHead drives onProgress and returns a known key. */
  function fakeProvider(): AvatarProvider {
    return {
      name: "mock-avatar",
      async createAvatar() {
        return { providerAvatarId: "x" };
      },
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

  function depsWith(provider: AvatarProvider) {
    return {
      avatarRepository: getAvatarRepository(),
      scriptRepository: getScriptRepository(),
      renderRepository: getRenderRepository(),
      provider
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
});
