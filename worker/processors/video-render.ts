import { createId, nowIso } from "@/lib/ids";
import type { ProcessorFn } from "./index";
import type { VideoOutput } from "@/lib/types";

/**
 * video_render processor — placeholder for Phase 4's real ffmpeg pipeline.
 * Currently returns a fake storage key after a brief simulated render.
 *
 * Expected job payload: { aspectRatio, subtitleStyle, bgmTrackId? }
 */
export const videoRenderProcessor: ProcessorFn = async (job) => {
  const payload = job.data.payload as {
    aspectRatio: string;
    subtitleStyle: string;
    bgmTrackId?: string;
  };

  // Simulate render delay
  await new Promise((resolve) => setTimeout(resolve, 500));

  const output: VideoOutput = {
    id: createId("output"),
    ownerId: job.data.ownerId ?? "demo_user",
    renderProjectId: job.data.projectId ?? "",
    storageKey: `renders/${job.data.projectId}/output-${createId("vid")}.mp4`,
    coverStorageKey: undefined,
    aspectRatio: (payload.aspectRatio as VideoOutput["aspectRatio"]) ?? "9:16",
    durationSeconds: 30,
    status: "ready",
    createdAt: nowIso()
  };

  return output;
};
