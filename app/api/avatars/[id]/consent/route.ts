import { jsonError, jsonOk } from "@/lib/api-response";
import { applyRateLimit } from "@/lib/rate-limit";
import { getAvatarRepository } from "@/lib/repositories";
import { getOwnerId } from "@/lib/auth-helpers";
import { createProviderFromEnv } from "@/lib/services/avatar-provider";
import { nowIso } from "@/lib/ids";

/**
 * POST /api/avatars/[id]/consent — 授权链接 24h 过期/被拒后重发（spec §6.5）。
 * 仅 failed（consent 类失败）或仍 awaiting_user 的形象可重发；ready 返回 409。
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ownerId = await getOwnerId();
  const limited = await applyRateLimit(request, ownerId);
  if (limited) return limited;

  const repo = getAvatarRepository();
  const avatar = await repo.findById(id);
  if (!avatar || avatar.ownerId !== ownerId) {
    return jsonError("Avatar profile not found", 404);
  }
  if (!avatar.providerGroupId) {
    return jsonError("Avatar has no provider group", 400);
  }
  if (avatar.trainingStatus === "ready") {
    return jsonError("Avatar is already ready", 409);
  }

  try {
    const { consentUrl } = await createProviderFromEnv().refreshConsent({ groupId: avatar.providerGroupId });
    const updated = await repo.update(id, {
      consentStatus: "awaiting_user",
      trainingStatus: "pending",
      statusReason: undefined,
      updatedAt: nowIso(),
    });
    return jsonOk({ avatar: updated, consentUrl });
  } catch (error) {
    console.error("[avatars] consent re-issue failed:", error);
    return jsonError("Failed to re-issue consent", 502);
  }
}
