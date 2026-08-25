import type { ScriptSegment } from "@/lib/types";
import { estimateSegmentSeconds } from "@/lib/services/scene-derive";

/** HeyGen 定价（spec §2）：数字人视频 $0.0667/s；克隆声音 TTS ≈ $0.000333/s。 */
export const AVATAR_VIDEO_USD_PER_SEC = 0.0667;
export const CLONED_TTS_USD_PER_SEC = 0.000333;

export interface RenderCostEstimate {
  onCameraSec: number;
  voiceoverSec: number;
  videoUsd: number;
  ttsUsd: number;
  totalUsd: number;
}

/**
 * 确认卡片预估成本（spec §6.4）：按段字数 / 4.5 字每秒估算时长，
 * 出镜段计视频价、画外音段计 TTS 价。未选形象 = 纯素材成片，零数字人成本。
 */
export function estimateRenderCost(
  segments: ScriptSegment[] | undefined,
  avatarCount = 1,
): RenderCostEstimate {
  if (avatarCount <= 0) {
    return { onCameraSec: 0, voiceoverSec: 0, videoUsd: 0, ttsUsd: 0, totalUsd: 0 };
  }
  let onCameraSec = 0;
  let voiceoverSec = 0;
  for (const seg of segments ?? []) {
    const sec = estimateSegmentSeconds(seg.text);
    if (seg.onCamera) onCameraSec += sec;
    else voiceoverSec += sec;
  }
  const videoUsd = onCameraSec * AVATAR_VIDEO_USD_PER_SEC;
  const ttsUsd = voiceoverSec * CLONED_TTS_USD_PER_SEC;
  return { onCameraSec, voiceoverSec, videoUsd, ttsUsd, totalUsd: videoUsd + ttsUsd };
}
