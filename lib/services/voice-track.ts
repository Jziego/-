import type { ScriptSegment } from "@/lib/types";
import type { WordTimestamp } from "@/lib/services/avatar-provider";

/** 合成用的形象解析结果（provider ids 已就绪）。 */
export interface ResolvedSpeaker {
  profileId: string;
  providerAvatarId: string;
  providerVoiceId?: string;
}

export interface VoiceTrackSegment {
  /** 对齐 ScriptSegment.index。 */
  index: number;
  speakerIndex: number;
  onCamera: boolean;
  text: string;
  /** onCamera 段 / TTS 降级段：数字人视频（音视频一体）storageKey。 */
  videoStorageKey?: string;
  /** 画外音段：TTS 音频 storageKey。 */
  audioStorageKey?: string;
  durationSec: number;
  /** TTS 词级时间轴（相对本段起点的秒）；onCamera 段没有（HeyGen 视频不返回）。 */
  words?: WordTimestamp[];
  /** TTS 重试失败后降级为数字人视频的标记（spec §6.5）。 */
  fellBackToVideo?: boolean;
}

export interface VoiceTrackManifest {
  version: 1;
  segments: VoiceTrackSegment[];
  totalDurationSec: number;
}

export function voiceTrackManifestKey(projectId: string): string {
  return `voice-tracks/${projectId}/manifest.json`;
}

export interface SegmentSynthesisPlan {
  segment: ScriptSegment;
  speaker: ResolvedSpeaker;
}

/**
 * 逐段 → 说话人解析。speakerIndex 经 draft.speakerAvatarIds 对齐到本次选中的
 * 形象列表；id 不在选中集（用户取消勾选）或下标越界 → 回退第一个选中形象。
 */
export function planSegmentSynthesis(
  segments: ScriptSegment[],
  speakers: ResolvedSpeaker[],
  speakerAvatarIds?: string[],
): SegmentSynthesisPlan[] {
  if (speakers.length === 0) {
    throw new Error("planSegmentSynthesis requires at least one speaker");
  }
  return segments.map((segment) => {
    const wantedId = speakerAvatarIds?.[segment.speakerIndex];
    const byId = wantedId ? speakers.find((s) => s.profileId === wantedId) : undefined;
    const byIndex = speakers[Math.min(Math.max(segment.speakerIndex, 0), speakers.length - 1)];
    return { segment, speaker: byId ?? byIndex ?? (speakers[0] as ResolvedSpeaker) };
  });
}
