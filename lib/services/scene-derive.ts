import { SPEECH_CHARS_PER_SECOND } from "@/lib/speech-rate";
import { splitVoiceoverSentences } from "@/lib/services/video-compose";
import type { ScriptScene, ScriptSegment } from "@/lib/types";

/** presenter 镜最短时长，避免退化 trim 窗口。 */
const MIN_PRESENTER_SEC = 3;

/** 口播句时长估算：字数 / 4.5，下限 3s。 */
export function estimateSegmentSeconds(text: string): number {
  return Math.max(MIN_PRESENTER_SEC, Math.round(Array.from(text).length / SPEECH_CHARS_PER_SECOND));
}

/**
 * 从 voiceover 确定性重切 segments（spec §5.2）：
 * - speakerIndex 本期恒 0（Phase 3 多形象预留）；
 * - onCamera 优先级：prev 同文句继承 > AI 出镜句选择 > 首/末句默认。
 */
export function deriveSegmentsFromVoiceover(
  voiceover: string,
  opts: { onCameraTexts?: string[]; prev?: ScriptSegment[] } = {},
): ScriptSegment[] {
  const sentences = splitVoiceoverSentences(voiceover);
  const onCameraSet = new Set((opts.onCameraTexts ?? []).map((s) => s.trim()).filter(Boolean));
  const prevByText = new Map((opts.prev ?? []).map((s) => [s.text, s]));
  const last = sentences.length - 1;

  return sentences.map((text, index) => {
    const prev = prevByText.get(text);
    const onCamera = prev
      ? prev.onCamera
      : onCameraSet.size > 0
        ? onCameraSet.has(text)
        : index === 0 || index === last;
    return { index, text, speakerIndex: 0, onCamera };
  });
}

/** 标黄词过滤：只保留仍出现在 voiceover 中的词（trim + 去重，保序）。 */
export function filterActiveHighlights(highlights: string[], voiceover: string): string[] {
  const seen = new Set<string>();
  const active: string[] = [];
  for (const raw of highlights) {
    const word = raw.trim();
    if (!word || seen.has(word) || !voiceover.includes(word)) continue;
    seen.add(word);
    active.push(word);
  }
  return active;
}

/**
 * scenes 是渲染内部概念（spec §3）：首/末口播句派生 presenter 镜；
 * b-roll 无需 broll 镜——素材池在 buildTimeline 中按勾选顺序交错铺满。
 */
export function deriveScenesFromSegments(segments: ScriptSegment[]): ScriptScene[] {
  if (segments.length === 0) return [];
  const first = segments[0] as ScriptSegment;
  const last = segments[segments.length - 1] as ScriptSegment;
  const picks = segments.length === 1 ? [first] : [first, last];
  return picks.map((seg, i) => ({
    order: i + 1,
    text: seg.text,
    durationSeconds: estimateSegmentSeconds(seg.text),
    assetHints: [],
    role: "presenter" as const,
  }));
}
