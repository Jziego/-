import type { WordTimestamp } from "@/lib/services/avatar-provider";
import type { VoiceTrackManifest } from "@/lib/services/voice-track";
import type { CaptionCue } from "@/lib/services/video-compose";

/** 每行最大字数（84px 粗体在 1080 宽、左右各 40 margin 下的安全值）。 */
const MAX_CHARS_PER_LINE = 12;
/** 每页（一屏字幕块）最大行数。 */
const MAX_LINES_PER_PAGE = 2;
/** 行首禁置标点：命中则并入上一行（宁可略宽不孤标）。 */
const LINE_START_FORBIDDEN = /^[，。！？；：、,.!?;:…—）】》」』%]/;

export interface CaptionPage {
  words: WordTimestamp[];
  /** 两行页的第一行末词下标；单行页为 undefined。 */
  lineBreakAfter?: number;
}

/**
 * 词序列 → 分页（每页 ≤2 行、每行 ≤12 字，贪心填充）。
 * 标点永不触发换行/翻页——行首不会是标点；页首仅在输入本身以标点起始时例外。
 */
export function paginateWords(words: WordTimestamp[]): CaptionPage[] {
  const pages: CaptionPage[] = [];
  let current: WordTimestamp[] = [];
  let lineLens: number[] = [0];
  let breakAfter: number | undefined;

  const flush = () => {
    if (current.length === 0) return;
    pages.push({ words: current, lineBreakAfter: breakAfter });
    current = [];
    lineLens = [0];
    breakAfter = undefined;
  };

  for (const word of words) {
    const len = Math.max(Array.from(word.word).length, 1);
    const lineIdx = lineLens.length - 1;
    const isPunctuation = LINE_START_FORBIDDEN.test(word.word);
    const overflow =
      (lineLens[lineIdx] as number) + len > MAX_CHARS_PER_LINE &&
      (lineLens[lineIdx] as number) > 0 &&
      !isPunctuation;

    if (overflow && lineLens.length < MAX_LINES_PER_PAGE) {
      // 换行：当前词开第二行
      breakAfter = current.length - 1;
      lineLens.push(len);
    } else if (overflow) {
      // 翻页：当前词开新页
      flush();
      lineLens = [len];
    } else {
      lineLens[lineIdx] = (lineLens[lineIdx] as number) + len;
    }
    current.push(word);
  }
  flush();
  return pages;
}

/**
 * 分段音轨清单 → 字幕 cue 序列。
 * 有 words 的段：分页后每词一条逐词事件（页内时间连续，全局时间 = 段偏移 + 段内相对秒）；
 * 无 words 的段（HeyGen 出镜段等）：回退整句 cue，与 buildSegmentedCaptionCues 行为一致。
 */
export function buildWordCaptionEvents(manifest: VoiceTrackManifest): CaptionCue[] {
  const cues: CaptionCue[] = [];
  let segOffset = 0;
  for (const seg of manifest.segments) {
    const words = seg.words ?? [];
    if (words.length === 0) {
      cues.push({ startSec: segOffset, endSec: segOffset + seg.durationSec, text: seg.text });
    } else {
      for (const page of paginateWords(words)) {
        const pageWords = page.words.map((word) => word.word);
        page.words.forEach((word, i) => {
          const next = page.words[i + 1];
          cues.push({
            startSec: segOffset + word.startSec,
            // 页内连续：当前词结束 = 下一词开始；末词延伸到词自身 endSec
            endSec: next ? segOffset + next.startSec : segOffset + word.endSec,
            text: pageWords.join(""),
            wordIndex: i,
            pageWords,
            lineBreakAfter: page.lineBreakAfter,
          });
        });
      }
    }
    segOffset += seg.durationSec;
  }
  return cues;
}
