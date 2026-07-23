import { jsonError, jsonOk } from "@/lib/api-response";
import { applyRateLimit } from "@/lib/rate-limit";
import { getOwnerId } from "@/lib/auth-helpers";
import { getAssetRepository, getScriptRepository } from "@/lib/repositories";
import type { ScriptScene } from "@/lib/types";

interface PatchScene {
  order: number;
  text?: string;
  matchedAssetId?: string | null;
}

/**
 * 编辑已生成分镜：逐镜改口播文案 / 换匹配素材。IDOR：他人或不存在的 draft
 * 一律 404，不泄漏存在性。matchedAssetId 必须属于本人素材库。
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return jsonError("Request body must be valid JSON", 400);
  }

  const ownerId = await getOwnerId();
  const limited = await applyRateLimit(request, ownerId);
  if (limited) return limited;

  const draft = await getScriptRepository().findById(id);
  if (!draft || draft.ownerId !== ownerId) {
    return jsonError("Script draft not found", 404);
  }

  if (!Array.isArray(body.scenes)) {
    return jsonError("scenes array is required", 400);
  }
  const patchScenes = body.scenes as PatchScene[];

  // 校验所有 swapped matchedAssetId 属于本人
  const swappedIds = patchScenes
    .map((s) => s.matchedAssetId)
    .filter((x): x is string => typeof x === "string");
  if (swappedIds.length) {
    const ownerAssets = await getAssetRepository().listByOwner(ownerId);
    const ownerAssetIds = new Set(ownerAssets.map((a) => a.id));
    for (const aid of swappedIds) {
      if (!ownerAssetIds.has(aid)) {
        return jsonError("Asset not found", 404);
      }
    }
  }

  // 按 order 合并：未提交的镜保持原样
  const byOrder = new Map(patchScenes.map((s) => [Number(s.order), s]));
  const mergedScenes: ScriptScene[] = draft.scenes.map((scene) => {
    const p = byOrder.get(scene.order);
    if (!p) return scene;
    return {
      ...scene,
      ...(typeof p.text === "string" ? { text: String(p.text).slice(0, 500) } : {}),
      ...(p.matchedAssetId !== undefined ? { matchedAssetId: p.matchedAssetId } : {}),
    };
  });

  const updated = await getScriptRepository().update(id, { scenes: mergedScenes });
  return jsonOk({ script: updated });
}
