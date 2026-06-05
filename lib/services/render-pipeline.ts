import { createId, nowIso } from "@/lib/ids";
import type { AspectRatio, AvatarProfile, Job, RenderProject, ScriptDraft } from "@/lib/types";

interface CreateRenderProjectInput {
  ownerId: string;
  storeId: string;
  scriptDraft: ScriptDraft;
  selectedAssetIds: string[];
  avatarProfile?: AvatarProfile;
  aspectRatio: AspectRatio;
  subtitleStyle: RenderProject["subtitleStyle"];
  bgmTrackId?: string;
}

export function createRenderProject(input: CreateRenderProjectInput): RenderProject {
  const now = nowIso();

  return {
    id: createId("render"),
    ownerId: input.ownerId,
    storeId: input.storeId,
    scriptDraftId: input.scriptDraft.id,
    selectedAssetIds: input.selectedAssetIds,
    avatarProfileId: input.avatarProfile?.id,
    purpose: input.scriptDraft.purpose,
    aspectRatio: input.aspectRatio,
    subtitleStyle: input.subtitleStyle,
    bgmTrackId: input.bgmTrackId,
    status: "queued",
    createdAt: now,
    updatedAt: now
  };
}

export function planRenderJobs(input: { project: RenderProject; includeAvatar: boolean }): Job[] {
  const now = nowIso();
  const jobs: Job[] = [];

  if (input.includeAvatar && input.project.avatarProfileId) {
    jobs.push({
      id: createId("job"),
      ownerId: input.project.ownerId,
      projectId: input.project.id,
      type: "avatar_generation",
      status: "queued",
      progress: 0,
      payload: {
        avatarProfileId: input.project.avatarProfileId,
        fallbackMode: "tts_voiceover"
      },
      dependsOnJobIds: [],
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

export function recoverRenderFailure(input: {
  projectId: string;
  ownerId: string;
  reason: string;
}): Job {
  const now = nowIso();

  return {
    id: createId("job"),
    ownerId: input.ownerId,
    projectId: input.projectId,
    type: "slideshow_render",
    status: "queued",
    progress: 0,
    payload: {
      fallbackReason: input.reason,
      strategy: "asset_slideshow_with_static_captions"
    },
    dependsOnJobIds: [],
    createdAt: now,
    updatedAt: now
  };
}
