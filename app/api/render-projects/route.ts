import { jsonError, jsonOk } from "@/lib/api-response";
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
  try {
    const renderRepo = getRenderRepository();
    const [renderProjects, jobs, outputs] = await Promise.all([
      renderRepo.listProjectsByOwner(demoOwnerId),
      getJobRepository().listByOwner(demoOwnerId),
      renderRepo.listOutputsByOwner(demoOwnerId)
    ]);
    return jsonOk({ renderProjects, jobs, outputs });
  } catch (error) {
    console.error("Failed to list render projects:", error);
    return jsonError(error instanceof Error ? error.message : "Failed to list render projects", 500);
  }
}

export async function POST(request: Request) {
  try {
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

    return jsonOk({ project, jobs }, 201);
  } catch (error) {
    console.error("Failed to create render project:", error);
    return jsonError(error instanceof Error ? error.message : "Failed to create render project", 500);
  }
}
