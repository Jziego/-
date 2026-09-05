import { jsonError, jsonOk } from "@/lib/api-response";
import { MAX_FOOTAGE_BYTES } from "@/lib/avatar-footage";
import { applyRateLimit } from "@/lib/rate-limit";
import { getAssetRepository, getAvatarRepository, getStoreRepository } from "@/lib/repositories";
import { getOwnerId } from "@/lib/auth-helpers";
import { createDigitalTwinProfile, createProviderFromEnv, AvatarProviderNotConfiguredError } from "@/lib/services/avatar-provider";
import { buildPlatformAvatar } from "@/lib/services/platform-avatar";
import { createPresignedGetUrl } from "@/lib/storage";

export async function GET(request: Request) {
  const ownerId = await getOwnerId();
  const limited = await applyRateLimit(request, ownerId);
  if (limited) return limited;
  const avatars = await getAvatarRepository().listByOwner(ownerId);
  // 平台公共形象兜底：用户没有任何可用形象时提供开箱即用的数字人（demo/新用户）。
  if (!avatars.some((a) => a.trainingStatus === "ready")) {
    avatars.push(buildPlatformAvatar(ownerId));
  }
  return jsonOk({ avatars });
}

export async function POST(request: Request) {
  let body: {
    storeId?: unknown;
    footageAssetId?: unknown;
    name?: unknown;
    consentAccepted?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return jsonError("Request body must be valid JSON", 400);
  }

  if (!body.storeId || !body.footageAssetId || !body.name) {
    return jsonError("storeId, footageAssetId and name are required", 400);
  }
  const name = String(body.name).trim();
  if (name.length === 0 || Array.from(name).length > 20) {
    return jsonError("name must be 1-20 characters", 400);
  }
  if (body.consentAccepted !== true) {
    return jsonError("创建数字人前必须确认肖像和声音授权", 400);
  }

  const ownerId = await getOwnerId();
  const limited = await applyRateLimit(request, ownerId);
  if (limited) return limited;

  // IDOR：人像素材必须属于本人、且确为 avatar_footage 视频（防拿 b-roll 素材建分身）。
  const footage = await getAssetRepository().findById(String(body.footageAssetId));
  if (
    !footage ||
    footage.ownerId !== ownerId ||
    footage.category !== "avatar_footage" ||
    footage.type !== "video"
  ) {
    return jsonError("Footage asset not found", 404);
  }
  // 兜底：30MB 闸门（upload-intent/confirm）上线前上传的旧素材可能仍超
  // HeyGen 32MB 硬上限——创建时明确 400，不再让 HeyGen 的 400 变成 502。
  if (footage.sizeBytes > MAX_FOOTAGE_BYTES) {
    return jsonError("训练视频超过 30MB 上限，请重新上传 30 秒–5 分钟、30MB 以内的人像视频", 400);
  }
  const store = await getStoreRepository().findById(String(body.storeId));
  if (!store || store.ownerId !== ownerId) {
    return jsonError("Store not found", 404);
  }

  try {
    // presigned GET 供 HeyGen 拉取训练视频（900s 默认过期，HeyGen 创建时立即拉取）。
    const footageUrl = await createPresignedGetUrl(footage.storageKey);
    const { profile, consentUrl } = await createDigitalTwinProfile({
      ownerId,
      storeId: store.id,
      name,
      footageAssetId: footage.id,
      footageUrl,
      consentAccepted: true,
      provider: createProviderFromEnv(),
    });
    const saved = await getAvatarRepository().create(profile);
    return jsonOk({ avatar: saved, consentUrl }, 201);
  } catch (error) {
    // production 未配置数字人提供商：明确 503，绝不静默造假授权链接。
    if (error instanceof AvatarProviderNotConfiguredError) {
      return jsonError("数字人服务未配置，请联系管理员", 503);
    }
    // provider/presign 错误可能含内部细节——日志留全文，客户端只收通用文案（§8）。
    console.error("[avatars] digital twin creation failed:", error);
    return jsonError("Avatar creation failed", 502);
  }
}
