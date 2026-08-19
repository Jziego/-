import { jsonError, jsonOk } from "@/lib/api-response";
import { applyRateLimit } from "@/lib/rate-limit";
import { getOwnerId } from "@/lib/auth-helpers";
import { getScriptRepository } from "@/lib/repositories";
import {
  deriveScenesFromSegments,
  deriveSegmentsFromVoiceover,
  filterActiveHighlights,
} from "@/lib/services/scene-derive";

const MAX_VOICEOVER_CHARS = 2000;

/**
 * 编辑口播稿全文（Phase 2：编辑对象从逐镜 scene.text 改为 voiceover）。
 * 保存后服务端重切 segments（未改句继承 onCamera）、过滤失效标黄词、
 * 重新派生渲染用 scenes。IDOR：他人或不存在的 draft 一律 404，不泄漏存在性。
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

  const voiceover = typeof body.voiceover === "string" ? body.voiceover.trim() : "";
  if (!voiceover) {
    return jsonError("voiceover is required", 400);
  }
  if (Array.from(voiceover).length > MAX_VOICEOVER_CHARS) {
    return jsonError(`voiceover must be at most ${MAX_VOICEOVER_CHARS} characters`, 400);
  }

  const segments = deriveSegmentsFromVoiceover(voiceover, { prev: draft.segments });
  const highlights = filterActiveHighlights(draft.highlights ?? [], voiceover);
  const scenes = deriveScenesFromSegments(segments);

  // captions 统一落 [voiceover]（spec §5），与创建路径 buildDraft 一致，不滞留旧文本
  const updated = await getScriptRepository().update(id, { voiceover, segments, highlights, scenes, captions: [voiceover] });
  return jsonOk({ script: updated });
}
