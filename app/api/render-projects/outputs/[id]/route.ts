import { jsonError, jsonOk } from "@/lib/api-response";
import { getOwnerId } from "@/lib/auth-helpers";
import { applyRateLimit } from "@/lib/rate-limit";
import { getRenderRepository } from "@/lib/repositories";
import { deleteObject } from "@/lib/storage";

/**
 * Hard-delete a video output (DB row first; R2 cleanup best-effort, incl.
 * cover object when present). IDOR-safe: a missing or foreign output both
 * resolve to 404 so existence is not leaked. Storage cleanup must not block
 * the delete — same trade-off as asset deletion.
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await context.params;
  const ownerId = await getOwnerId();

  const limited = await applyRateLimit(request, ownerId);
  if (limited) return limited;

  const repo = getRenderRepository();
  const output = await repo.findOutputById(id);
  if (!output || output.ownerId !== ownerId) {
    return jsonError("Output not found", 404);
  }

  await repo.deleteOutput(id);

  // R2 清理为尽力而为：deleteObject 契约保证永不 reject（见 lib/storage.ts），
  // 路由层不再需要 try/catch——与素材删除端点一致。
  await deleteObject(output.storageKey);
  if (output.coverStorageKey) {
    await deleteObject(output.coverStorageKey);
  }

  return jsonOk({ deleted: true });
}
