import { jsonError, jsonOk } from "@/lib/api-response";
import { getRuntimeState } from "@/lib/runtime-store";
import { createRenderProject, planRenderJobs } from "@/lib/services/render-pipeline";
import type { AspectRatio, RenderProject } from "@/lib/types";

export async function GET() {
  const state = getRuntimeState();
  return jsonOk({ renderProjects: state.renderProjects, jobs: state.jobs, outputs: state.outputs });
}

export async function POST(request: Request) {
  const body = await request.json();
  const state = getRuntimeState();
  const scriptDraft = state.scripts.find((item) => item.id === body.scriptDraftId);

  if (!scriptDraft) {
    return jsonError("Script draft not found", 404);
  }

  const avatarProfile = body.avatarProfileId
    ? state.avatars.find((item) => item.id === body.avatarProfileId)
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

  const jobs = planRenderJobs({ project, includeAvatar: Boolean(avatarProfile) });
  state.renderProjects.push(project);
  state.jobs.push(...jobs);

  return jsonOk({ project, jobs }, 201);
}
