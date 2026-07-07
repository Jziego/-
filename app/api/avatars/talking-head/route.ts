import { jsonError, jsonOk, jsonQuotaError } from "@/lib/api-response";
import { applyRateLimit } from "@/lib/rate-limit";
import { hasRedis } from "@/lib/env";
import { consumeQuota, QuotaExhaustedError } from "@/lib/quota";
import { createBullQueue, toQueuePayload } from "@/lib/queue";
import { getAvatarRepository, getJobRepository, getScriptRepository } from "@/lib/repositories";
import { getOwnerId } from "@/lib/auth-helpers";
import { createId, nowIso } from "@/lib/ids";
import type { Job } from "@/lib/types";

/**
 * POST /api/avatars/talking-head
 * Enqueues a talking_head job (async). The worker synthesizes the digital-human
 * voiceover clip from the avatar profile + the script draft's voiceover text,
 * persists it as a VideoOutput(kind="talking_head"), and the client tracks
 * progress via /api/jobs/:id/progress (SSE).
 *
 * Body: { avatarProfileId, scriptDraftId }
 */
export async function POST(request: Request) {
  let body: { avatarProfileId?: string; scriptDraftId?: string };
  try {
    body = await request.json();
  } catch {
    return jsonError("Request body must be valid JSON", 400);
  }

  if (!body.avatarProfileId || !body.scriptDraftId) {
    return jsonError("avatarProfileId and scriptDraftId are required", 400);
  }

  const ownerId = await getOwnerId();

  const limited = await applyRateLimit(request, ownerId);
  if (limited) return limited;

  // IDOR: avatar must belong to the authenticated user and be ready.
  const avatar = await getAvatarRepository().findById(body.avatarProfileId);
  if (!avatar || avatar.ownerId !== ownerId) {
    return jsonError("Avatar profile not found", 404);
  }
  if (!avatar.providerAvatarId) {
    return jsonError("Avatar profile not ready", 404);
  }

  // IDOR: script draft must belong to the authenticated user.
  const draft = await getScriptRepository().findById(body.scriptDraftId);
  if (!draft || draft.ownerId !== ownerId) {
    return jsonError("Script draft not found", 404);
  }

  // Quota: talking-head consumes HeyGen credits — preview is charged (Q2).
  try {
    await consumeQuota(ownerId);
  } catch (error) {
    if (error instanceof QuotaExhaustedError) {
      return jsonQuotaError(error.plan);
    }
    throw error;
  }

  const now = nowIso();
  const job: Job = {
    id: createId("job"),
    ownerId,
    // standalone preview — no render project (projectId undefined → mapper stores null)
    type: "talking_head",
    status: "queued",
    progress: 0,
    payload: {
      avatarProfileId: avatar.id,
      scriptDraftId: draft.id
    },
    dependsOnJobIds: [],
    createdAt: now,
    updatedAt: now
  };

  await getJobRepository().createMany([job]);

  if (hasRedis()) {
    try {
      const queue = createBullQueue("talking_head");
      await queue.add(job.id, toQueuePayload(job).data, toQueuePayload(job).opts);
      await queue.close();
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Failed to enqueue";
      try {
        await getJobRepository().update(job.id, {
          status: "failed",
          error: errorMsg,
          updatedAt: nowIso()
        });
      } catch {
        // best-effort DB update
      }
      return jsonError("Failed to enqueue talking-head job", 500);
    }
  }

  return jsonOk(
    { jobId: job.id, status: `/api/jobs/${job.id}/progress` },
    202
  );
}
