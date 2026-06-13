import { jsonError, jsonOk } from "@/lib/api-response";
import { hasRedis } from "@/lib/env";
import { createBullQueue, createFlowProducer, toFlowJobs, toQueuePayload } from "@/lib/queue";
import {
  getAvatarRepository,
  getJobRepository,
  getRenderRepository,
  getScriptRepository
} from "@/lib/repositories";
import { getOwnerId } from "@/lib/auth-helpers";
import { createRenderProject, planRenderJobs, recoverRenderFailure } from "@/lib/services/render-pipeline";
import { nowIso } from "@/lib/ids";
import type { AspectRatio, RenderProject } from "@/lib/types";

export async function GET() {
  const renderRepo = getRenderRepository();
  const ownerId = await getOwnerId();
  const [renderProjects, jobs, outputs] = await Promise.all([
    renderRepo.listProjectsByOwner(ownerId),
    getJobRepository().listByOwner(ownerId),
    renderRepo.listOutputsByOwner(ownerId)
  ]);
  return jsonOk({ renderProjects, jobs, outputs });
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return jsonError("Request body must be valid JSON", 400);
  }

  if (!body.scriptDraftId) {
    return jsonError("scriptDraftId is required", 400);
  }

  const scriptDraft = await getScriptRepository().findById(body.scriptDraftId as string);

  if (!scriptDraft) {
    return jsonError("Script draft not found", 404);
  }

  const ownerId = await getOwnerId();
  const avatarProfile = body.avatarProfileId
    ? (await getAvatarRepository().findById(body.avatarProfileId as string)) ?? undefined
    : undefined;
  const project = createRenderProject({
    ownerId,
    storeId: scriptDraft.storeId,
    scriptDraft,
    selectedAssetIds: (body.selectedAssetIds as string[]) ?? [],
    avatarProfile,
    aspectRatio: (body.aspectRatio as AspectRatio) ?? "9:16",
    subtitleStyle: ((body.subtitleStyle as RenderProject["subtitleStyle"]) ?? "bold_bottom"),
    bgmTrackId: body.bgmTrackId as string | undefined
  });

  const plannedJobs = planRenderJobs({ project, includeAvatar: Boolean(avatarProfile) });
  const fallbackJob = recoverRenderFailure({
    projectId: project.id,
    ownerId: project.ownerId,
    reason: "ffmpeg_timeout"
  });
  const jobs = [...plannedJobs, fallbackJob];

  // Step 1: Persist project and jobs to DB
  await getRenderRepository().createProject(project);
  await getJobRepository().createMany(jobs);

  // Step 2: Enqueue to Redis/BullMQ with data consistency hardening
  if (hasRedis()) {
    const enqueueResults: { jobId: string; ok: boolean; error?: string }[] = [];
    const failedJobIds: string[] = [];
    const now = nowIso();

    try {
      const flowProducer = createFlowProducer();
      const flowJobs = toFlowJobs(jobs);

      for (const flowJob of flowJobs) {
        try {
          await flowProducer.add(flowJob);
          // Mark this job and all its children as enqueued
          enqueueResults.push({ jobId: flowJob.name, ok: true });
          if (flowJob.children) {
            for (const child of flowJob.children) {
              enqueueResults.push({ jobId: child.name, ok: true });
            }
          }
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : "Unknown enqueue error";
          enqueueResults.push({ jobId: flowJob.name, ok: false, error: errorMsg });
          failedJobIds.push(flowJob.name);
          if (flowJob.children) {
            for (const child of flowJob.children) {
              enqueueResults.push({ jobId: child.name, ok: false, error: `Parent flow failed: ${errorMsg}` });
              failedJobIds.push(child.name);
            }
          }
        }
      }

      // Consistency: mark failed enqueues in DB
      for (const jobId of failedJobIds) {
        try {
          await getJobRepository().update(jobId, {
            status: "failed",
            error: "Failed to enqueue to Redis",
            updatedAt: now
          });
        } catch {
          // Best-effort DB update
        }
      }

      // Update render project status based on enqueue results
      if (failedJobIds.length > 0) {
        try {
          await getRenderRepository().updateProject(project.id, {
            status: "failed",
            updatedAt: now
          });
        } catch {
          // Best-effort
        }
      } else {
        try {
          await getRenderRepository().updateProject(project.id, {
            status: "processing",
            updatedAt: now
          });
        } catch {
          // Best-effort
        }
      }

      // Clean up FlowProducer
      try { await flowProducer.close(); } catch { /* ignore */ }

      return jsonOk(
        {
          project: { ...project, status: failedJobIds.length > 0 ? "failed" : "processing" },
          jobs,
          enqueueResults
        },
        failedJobIds.length > 0 ? 201 : 201
      );
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Redis unavailable";

      // Mark all jobs as failed since we couldn't enqueue
      for (const job of jobs) {
        try {
          await getJobRepository().update(job.id, {
            status: "failed",
            error: errorMsg,
            updatedAt: now
          });
        } catch {
          // Best-effort
        }
      }

      try {
        await getRenderRepository().updateProject(project.id, {
          status: "failed",
          updatedAt: now
        });
      } catch {
        // Best-effort
      }

      return jsonOk({ project: { ...project, status: "failed" }, jobs, enqueued: false, error: errorMsg }, 201);
    }
  }

  return jsonOk({ project, jobs, enqueued: false }, 201);
}
