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

/**
 * manifest 是 R2 上的跨 job 持久化契约，读端做最小防御性校验：
 * version===1、segments 非空数组、每段 onCamera 为布尔、durationSec 为正数，
 * 且 videoStorageKey / audioStorageKey 至少有一个字符串（否则该段被下载循环与
 * 音频 concat 双双跳过，apad 只在结尾补静音 → 整条音轨静默前移）。
 * 不满足则抛描述性错误（不含密钥/内部路径）。
 */
export function parseVoiceTrackManifest(raw: unknown): VoiceTrackManifest {
  if (raw === null || typeof raw !== "object") {
    throw new Error("voice-track manifest is not an object");
  }
  const m = raw as Record<string, unknown>;
  if (m.version !== 1) {
    throw new Error(`unsupported voice-track manifest version: ${String(m.version)}`);
  }
  if (!Array.isArray(m.segments)) {
    throw new Error("voice-track manifest segments must be an array");
  }
  if (m.segments.length === 0) {
    throw new Error("voice-track manifest segments must not be empty");
  }
  for (const [i, seg] of (m.segments as unknown[]).entries()) {
    if (seg === null || typeof seg !== "object") {
      throw new Error(`voice-track manifest segment ${i} is not an object`);
    }
    const s = seg as Record<string, unknown>;
    if (typeof s.onCamera !== "boolean") {
      throw new Error(`voice-track manifest segment ${i}: onCamera must be a boolean`);
    }
    if (typeof s.durationSec !== "number" || !Number.isFinite(s.durationSec) || s.durationSec <= 0) {
      throw new Error(`voice-track manifest segment ${i}: durationSec must be a positive number`);
    }
    if (typeof s.videoStorageKey !== "string" && typeof s.audioStorageKey !== "string") {
      throw new Error(
        `voice-track manifest segment ${i}: videoStorageKey or audioStorageKey is required`,
      );
    }
  }
  return raw as VoiceTrackManifest;
}

export interface SegmentSynthesisPlan {
  segment: ScriptSegment;
  speaker: ResolvedSpeaker;
}

/**
 * 逐段 → 说话人解析。speakerIndex 先经 draft.speakerAvatarIds 对齐到本次选中的
 * 形象列表（byId）；id 不在选中集（用户取消勾选）→ 按 clamp 后的 speakerIndex
 * 位置回退（byIndex，保持轮播节奏）；speakers[0] 仅作最终兜底。
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
