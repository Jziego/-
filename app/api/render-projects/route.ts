import { jsonError, jsonOk, jsonQuotaError } from "@/lib/api-response";
import { applyRateLimit } from "@/lib/rate-limit";
import { hasRedis } from "@/lib/env";
import { consumeQuota, QuotaExhaustedError } from "@/lib/quota";
import { createBullQueue, createFlowProducer, toFlowJobs, toQueuePayload } from "@/lib/queue";
import {
  getAvatarRepository,
  getJobRepository,
  getRenderRepository,
  getScriptRepository
} from "@/lib/repositories";
import { getOwnerId } from "@/lib/auth-helpers";
import { createRenderProject, planRenderJobs } from "@/lib/services/render-pipeline";
import { nowIso } from "@/lib/ids";
import type { AspectRatio, RenderProject } from "@/lib/types";

export async function GET(request: Request) {
  const renderRepo = getRenderRepository();
  const ownerId = await getOwnerId();
  const limited = await applyRateLimit(request, ownerId);
  if (limited) return limited;
  const [renderProjects, jobs, outputs] = await Promise.all([
    renderRepo.listProjectsByOwner(ownerId),
    getJobRepository().listByOwner(ownerId),
    renderRepo.listOutputsByOwner(ownerId, 20)
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

  const ownerId = await getOwnerId();

  const limited = await applyRateLimit(request, ownerId);
  if (limited) return limited;

  const scriptDraft = await getScriptRepository().findById(body.scriptDraftId as string);

  if (!scriptDraft) {
    return jsonError("Script draft not found", 404);
  }

  // IDOR guard: scriptDraft must belong to the authenticated user
  if (scriptDraft.ownerId !== ownerId) {
    return jsonError("Script draft not found", 404);
  }

  // Quota consumption — throws QuotaExhaustedError if exhausted (402)
  try {
    await consumeQuota(ownerId);
  } catch (error) {
    if (error instanceof QuotaExhaustedError) {
      return jsonQuotaError(error.plan);
    }
    throw error;
  }

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
  // Degradation is inline: video_render falls back to asset_only when no
  // talking-head product exists, so the old pre-enqueued slideshow fallback
  // job (b5) is removed.
  const jobs = plannedJobs;

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
          // §8: don't forward raw err.message — BullMQ/ioredis errors expose
          // internal infra (host:port). Log server-side, return ok:false only.
          console.error("[render-projects] enqueue failed for flow:", flowJob.name, err);
          enqueueResults.push({ jobId: flowJob.name, ok: false });
          failedJobIds.push(flowJob.name);
          if (flowJob.children) {
            for (const child of flowJob.children) {
              enqueueResults.push({ jobId: child.name, ok: false });
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
        202
      );
    } catch (err) {
      // §8: don't leak ioredis/BullMQ internals (host:port) to the client.
      console.error("[render-projects] enqueue failed:", err);

      // Generic message in DB; full error is in server logs only.
      for (const job of jobs) {
        try {
          await getJobRepository().update(job.id, {
            status: "failed",
            error: "Failed to enqueue to Redis",
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

      return jsonOk({ project: { ...project, status: "failed" }, jobs, enqueued: false }, 202);
    }
  }

  return jsonOk({ project, jobs, enqueued: false }, 202);
}
