import { jsonError, jsonOk } from "@/lib/api-response";
import { applyRateLimit } from "@/lib/rate-limit";
import { getAvatarRepository } from "@/lib/repositories";
import { getOwnerId } from "@/lib/auth-helpers";
import {
  applyDigitalTwinStatus,
  createProviderFromEnv,
  type DigitalTwinStatus,
} from "@/lib/services/avatar-provider";

/**
 * GET /api/avatars/[id]/status — 轮询分身授权+训练状态（spec §6.2.4）。
 * provider 状态经 applyDigitalTwinStatus 收敛后落库；awaiting_user 时带回
 * （可能已轮换的）consentUrl 供前端重新打开。只返回给属主本人。
 */
export async function GET(
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
    // 老数据（mock 时代创建）：没有 group 句柄可轮询，直接回现状。
    return jsonOk({ avatar });
  }
  if (avatar.trainingStatus === "ready" || avatar.trainingStatus === "failed") {
    return jsonOk({ avatar }); // 终态不再轮询 provider
  }

  let status: DigitalTwinStatus;
  try {
    status = await createProviderFromEnv().getDigitalTwinStatus({ groupId: avatar.providerGroupId });
  } catch (error) {
    console.error("[avatars] status poll failed:", error);
    return jsonError("Failed to poll avatar status", 502);
  }

  const updated = await repo.update(id, applyDigitalTwinStatus(status));
  return jsonOk({ avatar: updated, consentUrl: status.consentUrl });
}
