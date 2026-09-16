import { jsonError, jsonOk } from "@/lib/api-response";
import { MAX_FOOTAGE_BYTES, LIPSYNC_MAX_FOOTAGE_BYTES } from "@/lib/avatar-footage";
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

  // IDOR：人像素材必须属于本人、且确为人像视频（防拿 b-roll 素材建形象）。
  // 注意：属主校验必须先于一切 storageKey 使用——对口型形象把 storageKey 编码进
  // groupId，没有这道校验用户 A 就能拿用户 B 的素材建形象。
  const footage = await getAssetRepository().findById(String(body.footageAssetId));
  if (!footage || footage.ownerId !== ownerId || footage.type !== "video") {
    return jsonError("Footage asset not found", 404);
  }
  const store = await getStoreRepository().findById(String(body.storeId));
  if (!store || store.ownerId !== ownerId) {
    return jsonError("Store not found", 404);
  }

  try {
    // 创建 provider 由部署配置决定（新形象走哪条生产线）；老 HeyGen 形象渲染不受影响。
    const provider = createProviderFromEnv();
    const isLipSync = provider.name === "volcengine-lipsync";

    // category 与创建 provider 必须匹配：对口型接受 lipsync_footage + 旧 avatar_footage
    // （≤30MB/30s-5min 的旧素材天然满足对口型闸门，可直接当底板复用）；
    // HeyGen 只收 avatar_footage（lipsync_footage 可能超其 32MB 硬上限）。
    const allowedCategories = isLipSync ? ["avatar_footage", "lipsync_footage"] : ["avatar_footage"];
    if (!allowedCategories.includes(footage.category)) {
      return jsonError("Footage asset not found", 404);
    }
    // 创建时大小兜底闸（防 upload-intent/confirm 闸门上线前上传的旧素材超限）。
    if (!isLipSync && footage.sizeBytes > MAX_FOOTAGE_BYTES) {
      return jsonError("训练视频超过 30MB 上限，请重新上传 30 秒–5 分钟、30MB 以内的人像视频", 400);
    }
    if (isLipSync && footage.sizeBytes > LIPSYNC_MAX_FOOTAGE_BYTES) {
      return jsonError("出镜底板视频超过 200MB 上限，请剪辑到 3 分钟以内再上传", 400);
    }

    // presigned GET 供 provider 拉取训练视频（900s 默认过期，创建时立即拉取；
    // 对口型 provider 忽略此 URL，直接用 footageStorageKey）。
    const footageUrl = await createPresignedGetUrl(footage.storageKey);
    const { profile, consentUrl } = await createDigitalTwinProfile({
      ownerId,
      storeId: store.id,
      name,
      footageAssetId: footage.id,
      footageUrl,
      footageStorageKey: footage.storageKey,
      consentAccepted: true,
      provider,
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
