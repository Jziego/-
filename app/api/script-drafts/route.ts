import { jsonError, jsonOk } from "@/lib/api-response";
import { applyRateLimit } from "@/lib/rate-limit";
import { getAssetAnalysisRepository, getAvatarRepository, getScriptRepository, getStoreRepository } from "@/lib/repositories";
import { getOwnerId } from "@/lib/auth-helpers";
import { createScriptDraft, createTemplateScriptDraft } from "@/lib/services/script-engine";
import type { MarketingPurpose, Platform } from "@/lib/types";

// targetDurationSec drives worker render loops — only the UI duration slots are accepted.
const DURATION_SLOTS = [30, 45, 60];
const durationSlot = (v: unknown): number | undefined =>
  typeof v === "number" && DURATION_SLOTS.includes(v) ? v : undefined;

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
        avatarPersonas,
      });

  const saved = await getScriptRepository().create(script);
  return jsonOk({ script: saved }, 201);
}
