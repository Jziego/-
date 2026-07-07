import type { JobRepository, RenderRepository } from "@/lib/repositories/types";
import { nowIso } from "@/lib/ids";

/**
 * Finalize a RenderProject's status from the terminal state of all its Jobs.
 *
 * Called after each Job completes or fails. When every Job for the project has
 * reached a terminal state (completed/failed), the project status advances:
 *  - all failed → "failed"
 *  - at least one completed render Job (video_render) → "ready"
 *  - otherwise (e.g. only avatar_generation completed, no render) → unchanged
 *
 * Single source of truth for project → ready/failed. Individual processors must
 * NOT set "ready" themselves: concurrent Jobs race and overwrite the final
 * status (the bug this centralizes — see worker/index.ts completed/failed paths).
 */
export async function finalizeProjectStatus(
  jobRepo: JobRepository,
  renderRepo: RenderRepository,
  projectId: string,
  ownerId: string
): Promise<void> {
  try {
    const allJobs = await jobRepo.listByOwner(ownerId);
    const projectJobs = allJobs.filter((j) => j.projectId === projectId);
    if (projectJobs.length === 0) return;

    const allDone = projectJobs.every(
      (j) => j.status === "completed" || j.status === "failed"
    );
    if (!allDone) return;

    const allFailed = projectJobs.every((j) => j.status === "failed");
    const hasCompletedRender = projectJobs.some(
      (j) => j.type === "video_render" && j.status === "completed"
    );

    if (allFailed) {
      await renderRepo.updateProject(projectId, {
        status: "failed",
        updatedAt: nowIso(),
      });
    } else if (hasCompletedRender) {
      await renderRepo.updateProject(projectId, {
        status: "ready",
        updatedAt: nowIso(),
      });
    }
    // else: all done but no render succeeded — leave status unchanged
  } catch {
    // Best-effort finalize; don't fail the Job because the status update failed
  }
}
