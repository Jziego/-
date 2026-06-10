import { jsonError, jsonOk } from "@/lib/api-response";
import { hasRedis } from "@/lib/env";
import { createBullQueue, toQueuePayload } from "@/lib/queue";
import {
  getAvatarRepository,
  getJobRepository,
  getRenderRepository,
  getScriptRepository
} from "@/lib/repositories";
import { demoOwnerId } from "@/lib/runtime-store";
import { createRenderProject, planRenderJobs, recoverRenderFailure } from "@/lib/services/render-pipeline";
import type { AspectRatio, RenderProject } from "@/lib/types";

export async function GET() {
  const renderRepo = getRenderRepository();
  const [renderProjects, jobs, outputs] = await Promise.all([
    renderRepo.listProjectsByOwner(demoOwnerId),
    getJobRepository().listByOwner(demoOwnerId),
    renderRepo.listOutputsByOwner(demoOwnerId)
  ]);
  return jsonOk({ renderProjects, jobs, outputs });
}

export async function POST(request: Request) {
  const body = await request.json();
  const scriptDraft = await getScriptRepository().findById(body.scriptDraftId);

  if (!scriptDraft) {
    return jsonError("Script draft not found", 404);
  }

  const avatarProfile = body.avatarProfileId
    ? (await getAvatarRepository().findById(body.avatarProfileId)) ?? undefined
    : undefined;
  const project = createRenderProject({
    ownerId: body.ownerId ?? scriptDraft.ownerId,
    storeId: scriptDraft.storeId,
    scriptDraft,
    selectedAssetIds: body.selectedAssetIds ?? [],
    avatarProfile,
    aspectRatio: (body.aspectRatio ?? "9:16") as AspectRatio,
    subtitleStyle: (body.subtitleStyle ?? "bold_bottom") as RenderProject["subtitleStyle"],
    bgmTrackId: body.bgmTrackId
  });

  const plannedJobs = planRenderJobs({ project, includeAvatar: Boolean(avatarProfile) });
  const fallbackJob = recoverRenderFailure({
    projectId: project.id,
    ownerId: project.ownerId,
    reason: "ffmpeg_timeout"
  });
  const jobs = [...plannedJobs, fallbackJob];

  await getRenderRepository().createProject(project);
  await getJobRepository().createMany(jobs);

  // Enqueue jobs to Redis/BullMQ (best-effort — data consistency hardening in step 2)
  if (hasRedis()) {
    const enqueueResults: { jobId: string; ok: boolean }[] = [];
    for (const job of jobs) {
      try {
        const queue = createBullQueue(job.type);
        const { data, opts } = toQueuePayload(job);
        await queue.add(job.id, data, opts);
        enqueueResults.push({ jobId: job.id, ok: true });
      } catch (err) {
        enqueueResults.push({ jobId: job.id, ok: false });
      }
    }
    return jsonOk({ project, jobs, enqueueResults }, 201);
  }

  return jsonOk({ project, jobs, enqueued: false }, 201);
}
