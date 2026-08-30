import { jsonError, jsonOk } from "@/lib/api-response";
import { applyRateLimit } from "@/lib/rate-limit";
import { getAvatarRepository } from "@/lib/repositories";
import { getOwnerId } from "@/lib/auth-helpers";

/**
 * DELETE /api/avatars/[id] — 删除自己的分身档案（本地记录）。
 * 只删本地档案：HeyGen 侧 avatar group 占订阅槽位，需到 HeyGen 控制台另行删除。
 * 平台公共形象是合成卡片、从不落库，对其删除天然 404。
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
  await repo.delete(id);
  return jsonOk({ deleted: true });
}
