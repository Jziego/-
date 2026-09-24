import { jsonError, jsonOk } from "@/lib/api-response";
import { applyRateLimit } from "@/lib/rate-limit";
import { getAvatarRepository } from "@/lib/repositories";
import { getOwnerId } from "@/lib/auth-helpers";
import { deleteCosyVoice } from "@/lib/services/cosyvoice-enrollment";

/**
 * DELETE /api/avatars/[id] — 删除自己的分身档案（本地记录）。
 * 只删本地档案：HeyGen 侧 avatar group 占订阅槽位，需到 HeyGen 控制台另行删除。
 * 平台公共形象是合成卡片、从不落库，对其删除天然 404。
 * 对口型形象额外释放百炼克隆音色配额（见下方注释）。
 */
export async function DELETE(
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
  // 释放百炼克隆音色配额（1000/账号）：仅对口型形象 + cosyvoice 前缀音色。
  // 远端删除失败不阻塞本地删除（孤儿音色 1 年自动清理，代价可接受）。
  if (avatar.provider === "volcengine-lipsync" && avatar.providerVoiceId?.startsWith("cosyvoice-")) {
    try {
      await deleteCosyVoice(avatar.providerVoiceId);
    } catch (error) {
      console.warn(`[avatars] 释放克隆音色失败（不影响删除）：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await repo.delete(id);
  return jsonOk({ deleted: true });
}
