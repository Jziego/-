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
    return jsonError("产物不存在", 404);
  }

  await repo.deleteOutput(id);

  try {
    await deleteObject(output.storageKey);
    if (output.coverStorageKey) {
      await deleteObject(output.coverStorageKey);
    }
  } catch (err) {
    console.warn(
      `[outputs] R2 cleanup failed for ${id}:`,
      err instanceof Error ? err.message : String(err)
    );
  }

  return jsonOk({ deleted: true });
}
