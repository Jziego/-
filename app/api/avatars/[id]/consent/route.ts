import { jsonError, jsonOk } from "@/lib/api-response";
import { applyRateLimit } from "@/lib/rate-limit";
import { getAvatarRepository } from "@/lib/repositories";
import { getOwnerId } from "@/lib/auth-helpers";
import { AvatarProviderNotConfiguredError } from "@/lib/services/avatar-provider";
import { createProviderByName } from "@/lib/services/providers";
import { nowIso } from "@/lib/ids";

/**
 * POST /api/avatars/[id]/consent — 授权链接 24h 过期/被拒后重发（spec §6.5）。
 * 仅授权前（awaiting_user）或授权失败（rejected/expired）的形象可重发；
 * approved（含训练在途 processing 与终态 ready）返回 409——否则重发会把
 * 本地状态机错误重置回 awaiting_user/pending。
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
  // 对口型形象无授权概念（创建即就绪）：明确 400，不给 HeyGen 语义的状态机添乱。
  if (avatar.provider === "volcengine-lipsync") {
    return jsonError("对口型形象无需授权，创建后会自动就绪", 400);
  }
  if (
    avatar.consentStatus !== "awaiting_user" &&
    avatar.consentStatus !== "rejected" &&
    avatar.consentStatus !== "expired"
  ) {
    return jsonError("Avatar consent is already approved", 409);
  }

  try {
    // 按 profile.provider 解析：老 HeyGen 形象在部署切换后仍能重发授权。
    const { consentUrl } = await createProviderByName(avatar.provider).refreshConsent({ groupId: avatar.providerGroupId });
    const updated = await repo.update(id, {
      consentStatus: "awaiting_user",
      trainingStatus: "pending",
      statusReason: undefined,
      updatedAt: nowIso(),
    });
    return jsonOk({ avatar: updated, consentUrl });
  } catch (error) {
    if (error instanceof AvatarProviderNotConfiguredError) {
      return jsonError("数字人服务未配置，请联系管理员", 503);
    }
    console.error("[avatars] consent re-issue failed:", error);
    return jsonError("Failed to re-issue consent", 502);
  }
}
