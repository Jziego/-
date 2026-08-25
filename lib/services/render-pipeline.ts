import { createId, nowIso } from "@/lib/ids";
import type { AspectRatio, AvatarProfile, Job, RenderProject, ScriptDraft } from "@/lib/types";

interface CreateRenderProjectInput {
  ownerId: string;
  storeId: string;
  scriptDraft: ScriptDraft;
  selectedAssetIds: string[];
  /** Phase 3：有序形象列表（多形象轮播）。空 = 纯素材成片。 */
  avatarProfiles?: AvatarProfile[];
  aspectRatio: AspectRatio;
  subtitleStyle: RenderProject["subtitleStyle"];
  bgmTrackId?: string;
}

export function createRenderProject(input: CreateRenderProjectInput): RenderProject {
  const now = nowIso();
  const avatarProfileIds = (input.avatarProfiles ?? []).map((a) => a.id);

  return {
    id: createId("render"),
    ownerId: input.ownerId,
    storeId: input.storeId,
    scriptDraftId: input.scriptDraft.id,
    selectedAssetIds: input.selectedAssetIds,
    avatarProfileId: avatarProfileIds[0],
    avatarProfileIds,
    purpose: input.scriptDraft.purpose,
    aspectRatio: input.aspectRatio,
    subtitleStyle: input.subtitleStyle,
    bgmTrackId: input.bgmTrackId,
    targetDurationSec: input.scriptDraft.targetDurationSec,
    status: "queued",
    createdAt: now,
    updatedAt: now
  };
}

export function planRenderJobs(input: { project: RenderProject; includeAvatar: boolean }): Job[] {
  const now = nowIso();
  const jobs: Job[] = [];
  const avatarProfileIds = input.project.avatarProfileIds ?? [];

  if (input.includeAvatar && avatarProfileIds.length > 0) {
    const avatarJobId = createId("job");
    jobs.push({
      id: avatarJobId,
      ownerId: input.project.ownerId,
      projectId: input.project.id,
      type: "avatar_generation",
      status: "queued",
      progress: 0,
      payload: {
        // legacy 单 id 字段保留（= 首位），Task 10 前旧处理器仍读它。
        avatarProfileId: avatarProfileIds[0],
        avatarProfileIds,
        fallbackMode: "tts_voiceover"
      },
      dependsOnJobIds: [],
      createdAt: now,
      updatedAt: now
    });

    // talking_head synthesizes the digital-human voiceover clip from the avatar
    // profile + script voiceover. Depends on avatar_generation (profile provisioning).
    // The processor resolves AvatarProfile + ScriptDraft at processing time.
    // Phase 3：payload 带全部形象（分段合成由 Task 10 实现，按 draft.speakerAvatarIds 对齐说话人）。
    jobs.push({
      id: createId("job"),
      ownerId: input.project.ownerId,
      projectId: input.project.id,
      type: "talking_head",
      status: "queued",
      progress: 0,
      payload: {
        avatarProfileId: avatarProfileIds[0],
        avatarProfileIds,
        scriptDraftId: input.project.scriptDraftId
      },
      dependsOnJobIds: [avatarJobId],
      createdAt: now,
      updatedAt: now
    });
  }

  jobs.push({
    id: createId("job"),
    ownerId: input.project.ownerId,
    projectId: input.project.id,
    type: "video_render",
    status: "queued",
    progress: 0,
    payload: {
      aspectRatio: input.project.aspectRatio,
      subtitleStyle: input.project.subtitleStyle,
      bgmTrackId: input.project.bgmTrackId
    },
    dependsOnJobIds: jobs.map((job) => job.id),
    createdAt: now,
    updatedAt: now
  });

  return jobs;
}
