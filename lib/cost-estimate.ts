import type { ScriptSegment } from "@/lib/types";
import { estimateSegmentSeconds } from "@/lib/services/scene-derive";

/** HeyGen 定价（spec §2）：数字人视频 $0.0667/s；克隆声音 TTS ≈ $0.000333/s。 */
export const AVATAR_VIDEO_USD_PER_SEC = 0.0667;
export const CLONED_TTS_USD_PER_SEC = 0.000333;
/** 火山 MediaKit 对口型定价（2026-09 官网）：¥1/分钟按输出时长。豆包 TTS 字符费量级为几分钱/条，预估忽略。 */
export const LIPSYNC_VIDEO_CNY_PER_SEC = 1 / 60;

export interface RenderCostEstimate {
  onCameraSec: number;
  voiceoverSec: number;
  videoUsd: number;
  ttsUsd: number;
  totalUsd: number;
  /** 对口型计价（¥）：仅 pricing="lipsync" 时非零。 */
  totalCny: number;
}

/**
 * 确认卡片预估成本（spec §6.4）：按段字数 / 4.5 字每秒估算时长。
 * pricing="heygen"（默认）：出镜段计视频价、画外音段计 TTS 价（$）。
 * pricing="lipsync"：出镜段按 MediaKit ¥1/分钟；画外音段只有 TTS 字符费（微量，不计）。
 * 混合选择（老 HeyGen + 新对口型）按 heygen 估——保守高估，且无法预知段级说话人分配。
 * 未选形象 = 纯素材成片，零数字人成本。
 */
export function estimateRenderCost(
  segments: ScriptSegment[] | undefined,
  avatarCount = 1,
  pricing: "heygen" | "lipsync" = "heygen",
): RenderCostEstimate {
  if (avatarCount <= 0) {
    return { onCameraSec: 0, voiceoverSec: 0, videoUsd: 0, ttsUsd: 0, totalUsd: 0, totalCny: 0 };
  }
  let onCameraSec = 0;
  let voiceoverSec = 0;
  for (const seg of segments ?? []) {
    const sec = estimateSegmentSeconds(seg.text);
    if (seg.onCamera) onCameraSec += sec;
    else voiceoverSec += sec;
  }
  if (pricing === "lipsync") {
    const totalCny = onCameraSec * LIPSYNC_VIDEO_CNY_PER_SEC;
    return { onCameraSec, voiceoverSec, videoUsd: 0, ttsUsd: 0, totalUsd: 0, totalCny };
  }
  const videoUsd = onCameraSec * AVATAR_VIDEO_USD_PER_SEC;
  const ttsUsd = voiceoverSec * CLONED_TTS_USD_PER_SEC;
  return { onCameraSec, voiceoverSec, videoUsd, ttsUsd, totalUsd: videoUsd + ttsUsd, totalCny: 0 };
}
