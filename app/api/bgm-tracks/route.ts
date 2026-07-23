import { jsonOk } from "@/lib/api-response";
import { applyRateLimit } from "@/lib/rate-limit";
import { getOwnerId } from "@/lib/auth-helpers";
import { getBgmTrackRepository } from "@/lib/repositories";

/**
 * 列出系统级 BGM 曲目（无 ownerId）。只返回展示字段，不返回 storageKey，
 * 避免对象存储路径泄漏。试听预签名 URL 另走专门路由。
 */
export async function GET(request: Request) {
  const ownerId = await getOwnerId();
  const limited = await applyRateLimit(request, ownerId);
  if (limited) return limited;

  const tracks = await getBgmTrackRepository().list();
  return jsonOk({
    tracks: tracks.map((t) => ({
      id: t.id,
      name: t.name,
      category: t.category,
      durationSeconds: t.durationSeconds,
    })),
  });
}
