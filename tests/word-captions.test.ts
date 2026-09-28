import { describe, it, expect } from "vitest";
import { paginateWords, buildWordCaptionEvents } from "@/lib/services/word-captions";
import type { WordTimestamp } from "@/lib/services/avatar-provider";
import type { VoiceTrackManifest } from "@/lib/services/voice-track";

const w = (word: string, startSec: number, endSec: number): WordTimestamp => ({ word, startSec, endSec });

/** 造 n 个单字词，每词 0.2s 连续。 */
function wordsOf(text: string, start = 0, step = 0.2): WordTimestamp[] {
  return Array.from(text).map((ch, i) => w(ch, start + i * step, start + (i + 1) * step));
}

describe("paginateWords", () => {
  it("每行 ≤12 字，超出换行", () => {
    const pages = paginateWords(wordsOf("一二三四五六七八九十一二三四五")); // 15 字（10+5）
    expect(pages).toHaveLength(1);
    expect(pages[0]!.lineBreakAfter).toBe(11); // 前 12 字一行
    expect(pages[0]!.words).toHaveLength(15);
  });

  it("满 2 行翻页", () => {
    const pages = paginateWords(wordsOf("一二三四五六七八九十一二三四五六七八九十一二三四五")); // 25 字（10+10+5）
    expect(pages).toHaveLength(2);
    expect(pages[0]!.words).toHaveLength(24); // 12+12
    expect(pages[1]!.words).toHaveLength(1);
  });

  it("标点不置行首：超宽标点并入当前行", () => {
    // 12 字后紧跟句号——句号不应单独开行
    const pages = paginateWords(wordsOf("一二三四五六七八九十一二，三四")); // 12 字 + ，+ 2 字
    expect(pages[0]!.lineBreakAfter).toBe(12); // 句号并入第一行（下标 12），第二行从「三」开始
  });

  it("空数组返回空页列", () => {
    expect(paginateWords([])).toEqual([]);
  });
});

describe("buildWordCaptionEvents", () => {
  it("有 words 段：每词一条事件，时间连续（词 i 结束 = 词 i+1 开始）", () => {
    const manifest: VoiceTrackManifest = {
      version: 1,
      totalDurationSec: 1.0,
      segments: [
        { index: 0, speakerIndex: 0, onCamera: true, text: "大家好啊", durationSec: 0.8, words: wordsOf("大家好啊") },
      ],
    };
    const cues = buildWordCaptionEvents(manifest);
    expect(cues).toHaveLength(4);
    expect(cues[0]).toMatchObject({ startSec: 0, endSec: 0.2, wordIndex: 0, text: "大家好啊" });
    expect(cues[1]).toMatchObject({ startSec: 0.2, endSec: 0.4, wordIndex: 1 });
    expect(cues[3]!.wordIndex).toBe(3);
    expect(cues[3]!.endSec).toBeCloseTo(0.8); // 末词延伸到词自身 endSec
  });

  it("段偏移正确叠加", () => {
    const manifest: VoiceTrackManifest = {
      version: 1,
      totalDurationSec: 2.0,
      segments: [
        { index: 0, speakerIndex: 0, onCamera: true, text: "你好", durationSec: 1.0, words: wordsOf("你好", 0) },
        { index: 1, speakerIndex: 0, onCamera: true, text: "再见", durationSec: 1.0, words: wordsOf("再见", 0) },
      ],
    };
    const cues = buildWordCaptionEvents(manifest);
    expect(cues).toHaveLength(4);
    expect(cues[2]).toMatchObject({ startSec: 1.0, wordIndex: 0, text: "再见" }); // 第二段词时间 + 段偏移
  });

  it("无 words 段回退整句 cue（与 buildSegmentedCaptionCues 行为一致）", () => {
    const manifest: VoiceTrackManifest = {
      version: 1,
      totalDurationSec: 3.0,
      segments: [
        { index: 0, speakerIndex: 0, onCamera: true, text: "你好", durationSec: 1.0, words: wordsOf("你好", 0) },
        { index: 1, speakerIndex: 0, onCamera: true, text: "HeyGen出镜段", durationSec: 2.0 }, // 无 words
      ],
    };
    const cues = buildWordCaptionEvents(manifest);
    expect(cues).toHaveLength(3);
    expect(cues[2]).toEqual({ startSec: 1.0, endSec: 3.0, text: "HeyGen出镜段" }); // 无 wordIndex
  });

  it("words 为空数组同样回退整句", () => {
    const manifest: VoiceTrackManifest = {
      version: 1,
      totalDurationSec: 1.0,
      segments: [{ index: 0, speakerIndex: 0, onCamera: false, text: "画外音", durationSec: 1.0, words: [] }],
    };
    const cues = buildWordCaptionEvents(manifest);
    expect(cues).toEqual([{ startSec: 0, endSec: 1.0, text: "画外音" }]);
  });
});
