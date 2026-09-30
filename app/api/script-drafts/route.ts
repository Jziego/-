import { jsonError, jsonOk, jsonPointsError } from "@/lib/api-response";
import { applyRateLimit } from "@/lib/rate-limit";
import { getAssetAnalysisRepository, getAvatarRepository, getScriptRepository, getStoreRepository } from "@/lib/repositories";
import { getOwnerId } from "@/lib/auth-helpers";
import { PointsExhaustedError, PointsUnavailableError, consumePoints, countRecentScriptDrafts } from "@/lib/points";
import { SCRIPT_DRAFT_POINTS } from "@/lib/points-pricing";
import { createScriptDraft, createTemplateScriptDraft } from "@/lib/services/script-engine";
import { COPY_ANGLES, type CopyAngle } from "@/lib/copywriting-rules";
import type { MarketingPurpose, Platform } from "@/lib/types";

// targetDurationSec drives worker render loops — only the UI duration slots are accepted.
const DURATION_SLOTS = [30, 45, 60];
const durationSlot = (v: unknown): number | undefined =>
  typeof v === "number" && DURATION_SLOTS.includes(v) ? v : undefined;
// 切入角度（批次二）：运行时白名单——不信任客户端任意字符串直插 prompt（CLAUDE.md §3）。
const angleParam = (v: unknown): CopyAngle | undefined =>
  typeof v === "string" && (COPY_ANGLES as readonly string[]).includes(v) ? (v as CopyAngle) : undefined;

export async function GET(request: Request) {
  const ownerId = await getOwnerId();
  const limited = await applyRateLimit(request, ownerId);
  if (limited) return limited;
  const scripts = await getScriptRepository().listByOwner(ownerId);
  return jsonOk({ scripts });
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return jsonError("Request body must be valid JSON", 400);
  }
  const ownerId = await getOwnerId();
  const limited = await applyRateLimit(request, ownerId);
  if (limited) return limited;

  const store = await getStoreRepository().findById(body.storeId as string);
  // Not-found + IDOR guard (both 404, no leak)
  if (!store || store.ownerId !== ownerId) {
    return jsonError("Store profile not found", 404);
  }

  const assetAnalysisIds = body.assetAnalysisIds as string[] | undefined;
  const assetAnalyses = assetAnalysisIds?.length
    ? await getAssetAnalysisRepository().listByIds(assetAnalysisIds)
    : [];
  const purpose = (body.purpose ?? "store_traffic") as MarketingPurpose;

  // 多形象人设（spec §6.4）：本店 ready 形象，按创建时间排序；
  // speakerAvatarIds 持久化到 draft，渲染端 speakerIndex 按此对齐。
  const readyAvatars = (await getAvatarRepository().listByOwner(ownerId))
    .filter((a) => a.storeId === store.id && a.trainingStatus === "ready")
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  const avatarPersonas = readyAvatars.map((a, index) => ({
    index,
    id: a.id,
    name: a.name || `形象${index + 1}`,
  }));

  // 重写收费规则：同店 24h 窗口内第 1/4/7/10…次扣 10 积分（窗口内已生成 N 条，N%3===0 时扣），
  // 其余免费——免费不消费不记流水。计数发生在本次草稿创建之前（count 口径，非创建后统计）。
  // 无库（本地 dev/demo 降级）无法计数时降级旧口径走 consumePoints（其内部同样无库豁免），不 500。
  let recentDrafts = 0;
  try {
    recentDrafts = await countRecentScriptDrafts(ownerId, store.id, new Date(Date.now() - 24 * 60 * 60 * 1000));
  } catch (error) {
    if (!(error instanceof PointsUnavailableError)) throw error;
  }
  // 核心功能前置扣费：校验全过后、生成前扣 10 积分；余额不足 402（事务内防负）。
  if (recentDrafts % 3 === 0) {
    try {
      await consumePoints(ownerId, SCRIPT_DRAFT_POINTS, "生成口播稿");
    } catch (error) {
      if (error instanceof PointsExhaustedError) return jsonPointsError();
      throw error;
    }
  }

  const script = body.forceTemplate
    ? createTemplateScriptDraft({
        store,
        purpose,
        reason: "manual_template_mode",
        targetDurationSec: durationSlot(body.targetDurationSec),
        speakerAvatarIds: avatarPersonas.map((p) => p.id),
      })
    : await createScriptDraft({
        store,
        assetAnalyses,
        purpose,
        platform: (body.platform ?? "douyin") as Platform,
        targetDurationSec: durationSlot(body.targetDurationSec),
        angle: angleParam(body.angle),
        avatarPersonas,
      });

  const saved = await getScriptRepository().create(script);
  return jsonOk({ script: saved }, 201);
}
