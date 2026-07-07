import type { Job } from "bullmq";
import { createId, nowIso } from "@/lib/ids";
import type { AvatarProvider } from "@/lib/services/avatar-provider";
import { createProviderFromEnv, requestAvatarTalkingHead } from "@/lib/services/avatar-provider";
import {
  getAvatarRepository,
  getRenderRepository,
  getScriptRepository
} from "@/lib/repositories";
import type {
  AvatarRepository,
  RenderRepository,
  ScriptRepository
} from "@/lib/repositories/types";
import type { VideoOutput } from "@/lib/types";
import type { ProcessorFn } from "./index";

export interface TalkingHeadDeps {
  avatarRepository: AvatarRepository;
  scriptRepository: ScriptRepository;
  renderRepository: RenderRepository;
  provider: AvatarProvider;
}

/**
 * talking_head processor: resolves the avatar profile + script voiceover from
 * the job payload, asks the avatar provider to synthesize the talking-head
 * video, and persists the product as a VideoOutput(kind="talking_head") so the
 * downstream video_render job can fetch it. Reports real progress via
 * job.updateProgress during the (1-5min) provider poll.
 *
 * Expected job payload: { avatarProfileId, scriptDraftId }
 */
export const talkingHeadProcessor: ProcessorFn = (job) =>
  processTalkingHead(job, {
    avatarRepository: getAvatarRepository(),
    scriptRepository: getScriptRepository(),
    renderRepository: getRenderRepository(),
    provider: createProviderFromEnv()
  });

export async function processTalkingHead(job: Job, deps: TalkingHeadDeps): Promise<VideoOutput> {
  const payload = job.data.payload as {
    avatarProfileId: string;
    scriptDraftId: string;
  };
  const projectId = (job.data.projectId as string | undefined) ?? null;
  const ownerId = (job.data.ownerId as string) ?? "demo_user";

  const avatar = await deps.avatarRepository.findById(payload.avatarProfileId);
  if (!avatar?.providerAvatarId) {
    throw new Error(
      `Avatar profile ${payload.avatarProfileId} not ready (missing providerAvatarId)`,
    );
  }
  const draft = await deps.scriptRepository.findById(payload.scriptDraftId);
  if (!draft) {
    throw new Error(`Script draft ${payload.scriptDraftId} not found`);
  }

  const result = await requestAvatarTalkingHead({
    provider: deps.provider,
    avatarProfileId: avatar.id,
    providerAvatarId: avatar.providerAvatarId,
    providerVoiceId: avatar.providerVoiceId,
    scriptText: draft.voiceover,
    onProgress: (attempt, maxAttempts) => {
      // Reserve 5..85 for polling; 90/100 reserved for store/finalize below.
      const pct = 5 + Math.round((attempt / maxAttempts) * 80);
      void job.updateProgress(pct);
    }
  });
  await job.updateProgress(90);

  const output: VideoOutput = {
    id: createId("output"),
    ownerId,
    renderProjectId: projectId,
    storageKey: result.videoAssetId,
    coverStorageKey: undefined,
    aspectRatio: "9:16",
    durationSeconds: result.durationSeconds,
    kind: "talking_head",
    status: "ready",
    createdAt: nowIso()
  };

  // Persist VideoOutput (talking-head product) so video_render can fetch it
  // via findTalkingHeadOutputByProject. RenderProject status is NOT set here —
  // finalizeProjectStatus() handles that centrally to avoid concurrent races.
  try {
    await deps.renderRepository.createOutput(output);
  } catch (err) {
    console.error(
      `[talking_head] Failed to persist VideoOutput: ${err instanceof Error ? err.message : String(err)}`,
    );
    // Still return the output — the DB may not be available in dev
  }

  await job.updateProgress(100);
  return output;
}
