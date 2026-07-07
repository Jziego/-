import { createId, nowIso } from "@/lib/ids";
import { getRenderRepository } from "@/lib/repositories";
import type { ProcessorFn } from "./index";
import type { VideoOutput } from "@/lib/types";

/**
 * video_render processor — placeholder for Phase 4's real ffmpeg pipeline.
 * Currently returns a fake storage key after a brief simulated render.
 * Writes VideoOutput to the repository on completion.
 *
 * Expected job payload: { aspectRatio, subtitleStyle, bgmTrackId? }
 */
export const videoRenderProcessor: ProcessorFn = async (job) => {
  const payload = job.data.payload as {
    aspectRatio: string;
    subtitleStyle: string;
    bgmTrackId?: string;
  };
  const projectId = job.data.projectId as string;
  const ownerId = (job.data.ownerId as string) ?? "demo_user";

  // Seam for the real composite (Plan B): detect whether a talking-head product
  // exists for this project. Mode C (presenter_broll) when present; asset_only
  // degradation when absent. The placeholder render below ignores it for now.
  const talkingHead = projectId
    ? await getRenderRepository().findTalkingHeadOutputByProject(projectId)
    : null;
  if (talkingHead) {
    console.log(`[video_render] talking-head product available: ${talkingHead.storageKey}`);
  }

  // Simulate render delay
  await new Promise((resolve) => setTimeout(resolve, 500));

  const output: VideoOutput = {
    id: createId("output"),
    ownerId,
    renderProjectId: projectId || null,
    storageKey: `renders/${projectId || "unknown"}/output-${createId("vid")}.mp4`,
    coverStorageKey: undefined,
    aspectRatio: (payload.aspectRatio as VideoOutput["aspectRatio"]) ?? "9:16",
    durationSeconds: 30,
    kind: "final_composite",
    status: "ready",
    createdAt: nowIso()
  };

  // Persist VideoOutput to the repository.
  // RenderProject status → "ready" is handled centrally by finalizeProjectStatus()
  // in worker/index.ts after all project jobs finish. Setting it here would race
  // with concurrent jobs re-setting "processing" (the bug this centralization fixes).
  try {
    await getRenderRepository().createOutput(output);
  } catch (err) {
    console.error(`[video_render] Failed to persist VideoOutput: ${err instanceof Error ? err.message : String(err)}`);
    // Still return the output — the DB may not be available in dev
  }

  return output;
};
