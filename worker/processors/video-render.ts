import { createId, nowIso } from "@/lib/ids";
import { getRenderRepository, getJobRepository } from "@/lib/repositories";
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

  // Simulate render delay
  await new Promise((resolve) => setTimeout(resolve, 500));

  const output: VideoOutput = {
    id: createId("output"),
    ownerId,
    renderProjectId: projectId || "",
    storageKey: `renders/${projectId || "unknown"}/output-${createId("vid")}.mp4`,
    coverStorageKey: undefined,
    aspectRatio: (payload.aspectRatio as VideoOutput["aspectRatio"]) ?? "9:16",
    durationSeconds: 30,
    status: "ready",
    createdAt: nowIso()
  };

  // Persist VideoOutput to the repository
  try {
    await getRenderRepository().createOutput(output);

    // Update the render project status to "ready"
    if (projectId) {
      try {
        await getRenderRepository().updateProject(projectId, {
          status: "ready",
          updatedAt: nowIso()
        });
      } catch {
        // Project update is best-effort
      }
    }
  } catch (err) {
    console.error(`[video_render] Failed to persist VideoOutput: ${err instanceof Error ? err.message : String(err)}`);
    // Still return the output — the DB may not be available in dev
  }

  return output;
};
