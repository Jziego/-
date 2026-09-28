# 字幕逐词动效实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 分段链路字幕从「整句静态」升级为「逐词动效」（highlight/pop/bounce/karaoke 四档，新项目默认 pop），顺手修复 buildAss 两个既有 bug。

**Architecture:** 每词一条 ASS Dialogue 事件，事件边界即动画时钟；数据来自已落库的 `VoiceTrackSegment.words`（字级时间戳，段内相对秒）。ffmpeg/libass/渲染管线零改动。无 words 段回退整句（行为与现状逐字节一致）。

**Tech Stack:** TypeScript / Vitest / ASS (libass) / Next.js / React

**Spec:** `docs/superpowers/specs/2026-09-28-subtitle-word-animation-design.md`

---

## 现状关键坐标（实施前必读）

| 位置 | 内容 |
|------|------|
| `lib/services/video-compose.ts:199` | `SubtitleStylePreset = "default" \| "bold_bottom" \| "minimal"` |
| `lib/services/video-compose.ts:201-212` | `AssStyleSpec`（无 secondaryColour/backColour/animation） |
| `lib/services/video-compose.ts:216-220` | `SUBTITLE_PRESETS` 三个静态预设 |
| `lib/services/video-compose.ts:222-228` | `assTimestamp`——厘秒进位 bug |
| `lib/services/video-compose.ts:250-254` | `CaptionCue {startSec, endSec, text}` |
| `lib/services/video-compose.ts:312-340` | `buildAss`——Style Format 字段错位 bug（L325-326） |
| `lib/services/segmented-compose.ts:111-118` | `buildSegmentedCaptionCues` 每段一条整句 cue |
| `lib/services/voice-track.ts:13-34` | `VoiceTrackSegment`（含 `words?: WordTimestamp[]`）/ `VoiceTrackManifest` |
| `lib/services/avatar-provider.ts:5-9` | `WordTimestamp {word, startSec, endSec}` |
| `worker/processors/video-render.ts:199-203` | 字幕 cue 分支：分段 ? buildSegmentedCaptionCues : presenter_broll ? buildCaptionCues : [] |
| `worker/processors/video-render.ts:209` | `buildAss(captionCues, resolveSubtitlePreset(project.subtitleStyle), draft.highlights)` |
| `lib/schemas.ts:168` | `subtitleStyle: z.enum(["default", "bold_bottom", "minimal"])` |
| `lib/types.ts:199` | `subtitleStyle` 联合类型 |
| `components/script-confirm.tsx:10-14,73` | `SUBTITLE_OPTIONS` + `useState("bold_bottom")` |
| `app/api/render-projects/route.ts:109` | API 默认 `?? "bold_bottom"` |
| 测试 | `tests/video-compose.test.ts`（34 用例）、`tests/segmented-compose.test.ts`、`tests/video-render-processor-captions.test.ts` |

---

### Task 1: 既有 bug 修复包（assTimestamp 厘秒 + Style Format 字段位）

**Files:**
- Modify: `lib/services/video-compose.ts`（L201-228、L325-326）
- Test: `tests/video-compose.test.ts`（追加 describe）

- [ ] **Step 1: 写失败测试**

追加到 `tests/video-compose.test.ts` 末尾：

```ts
describe("assTimestamp 厘秒进位（bug fix）", () => {
  it("2.999 不产生非法三位厘秒 .100", () => {
    const ass = buildAss([{ startSec: 2.999, endSec: 3.5, text: "测试" }], "default");
    expect(ass).toContain("0:00:02.99");
    expect(ass).not.toContain(".100");
  });

  it("整秒与常规值不受影响", () => {
    const ass = buildAss([{ startSec: 0, endSec: 3.001, text: "测试" }], "default");
    expect(ass).toContain("0:00:00.00");
    expect(ass).toContain("0:00:03.00");
  });

  it("小时位正常进位", () => {
    const ass = buildAss([{ startSec: 3661.25, endSec: 3662, text: "测试" }], "default");
    expect(ass).toContain("1:01:01.25");
  });
});

describe("buildAss Style Format 字段位（bug fix）", () => {
  it("Format 声明与 Style 值逐列对齐，OutlineColour 列拿到描边色", () => {
    const ass = buildAss([{ startSec: 0, endSec: 1, text: "测试" }], "minimal");
    const lines = ass.split("\n");
    const formatLine = lines.find((l) => l.startsWith("Format: Name,"));
    const styleLine = lines.find((l) => l.startsWith("Style: Default,"));
    expect(formatLine).toBeDefined();
    expect(styleLine).toBeDefined();
    const cols = (formatLine as string).replace("Format: ", "").split(",").map((s) => s.trim());
    const vals = (styleLine as string).replace("Style: ", "").split(",");
    expect(cols.length).toBe(vals.length);
    // minimal 的半透明描边必须落在 OutlineColour 列（修复前错位到 BackColour）
    expect(vals[cols.indexOf("OutlineColour")]).toBe("&H80000000");
    // karaoke 前置：SecondaryColour 列必须存在
    expect(cols).toContain("SecondaryColour");
    expect(cols).toContain("BackColour");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/video-compose.test.ts`
Expected: FAIL——`.100` 出现在输出中 / `OutlineColour` 列值不是 `&H80000000` / 无 `SecondaryColour` 列

- [ ] **Step 3: 修复实现**

`lib/services/video-compose.ts`：

1. `AssStyleSpec`（L201-212）加两个字段：

```ts
interface AssStyleSpec {
  fontname: string;
  fontsize: number;
  primaryColour: string; // &H00BBGGRR (ASS alpha+BGR)
  /** karaoke 未读色（\kf 起点色）；非 karaoke 预设填与主色同值占位。 */
  secondaryColour: string;
  /** 关键词高亮 override 色（{\c...&}）；须与 primaryColour 对比明显（黄底预设用红）。 */
  highlightColour: string;
  outlineColour: string;
  /** 阴影/底色（BackColour 列）；本管线 Shadow=0，填不透明黑占位。 */
  backColour: string;
  bold: 0 | 1;
  outline: number;
  alignment: number; // 2 = bottom-center
  marginV: number;
}
```

2. `SUBTITLE_PRESETS`（L216-220）三预设补字段（动画字段 Task 4 再加）：

```ts
const SUBTITLE_PRESETS: Record<SubtitleStylePreset, AssStyleSpec> = {
  default: { fontname: CJK_FONT, fontsize: 72, primaryColour: "&H00FFFFFF", secondaryColour: "&H00FFFFFF", highlightColour: "&H00FFFF", outlineColour: "&H00000000", backColour: "&H00000000", bold: 1, outline: 4, alignment: 2, marginV: 80 },
  bold_bottom: { fontname: CJK_FONT, fontsize: 84, primaryColour: "&H0000F4FF", secondaryColour: "&H0000F4FF", highlightColour: "&H000000FF", outlineColour: "&H00000000", backColour: "&H00000000", bold: 1, outline: 6, alignment: 2, marginV: 60 },
  minimal: { fontname: CJK_FONT, fontsize: 56, primaryColour: "&H00EEEEEE", secondaryColour: "&H00EEEEEE", highlightColour: "&H00FFFF", outlineColour: "&H80000000", backColour: "&H00000000", bold: 0, outline: 2, alignment: 2, marginV: 100 }
};
```

3. `assTimestamp`（L222-228）改总厘秒 floor 拆分：

```ts
function assTimestamp(sec: number): string {
  // 总厘秒 floor 后拆分：round 在 x.999 时会进位出非法三位厘秒 ".100"（libass 解析漂移）。
  const totalCs = Math.max(0, Math.floor(sec * 100));
  const h = Math.floor(totalCs / 360000);
  const m = Math.floor((totalCs % 360000) / 6000);
  const s = Math.floor((totalCs % 6000) / 100);
  const cs = totalCs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}
```

4. `buildAss` 的 Format/Style 行（L325-326）补全字段位：

```ts
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,${s.fontname},${s.fontsize},${s.primaryColour},${s.secondaryColour},${s.outlineColour},${s.backColour},${s.bold},0,1,${s.outline},0,${s.alignment},40,40,${s.marginV},1`,
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/video-compose.test.ts`
Expected: PASS（含既有 34 用例全绿——若有旧断言锁了 Format 行原文，更新为新字段位）

- [ ] **Step 5: Commit**

```bash
git add lib/services/video-compose.ts tests/video-compose.test.ts
git commit -m "fix(subtitle): assTimestamp 厘秒进位 + buildAss Style Format 补全 SecondaryColour/OutlineColour 列——minimal 半透明描边生效，karaoke 前置就绪"
```

---

### Task 2: ASS 文本安全纯函数（escapeAssText + stripEmoji）

**Files:**
- Modify: `lib/services/video-compose.ts`（CaptionCue 上方新增导出函数）
- Test: `tests/video-compose.test.ts`（追加 describe）

- [ ] **Step 1: 写失败测试**

```ts
describe("escapeAssText / stripEmoji", () => {
  it("剔除花括号（防 ASS tag 注入）", () => {
    expect(escapeAssText("价格{100}元")).toBe("价格100元");
  });

  it("反斜杠换全角（防 \\N 被解释成换行）", () => {
    expect(escapeAssText("A\\N B")).toBe("A＼N B");
  });

  it("剔除 emoji（libass 渲染不了彩色 emoji）", () => {
    expect(stripEmoji("好消息🔥快来💰")).toBe("好消息快来");
  });

  it("普通中文文本原样通过", () => {
    expect(escapeAssText(stripEmoji("龙岗君姐15年助300家店"))).toBe("龙岗君姐15年助300家店");
  });
});
```

并在文件头部 import 中追加 `escapeAssText, stripEmoji`（从 `@/lib/services/video-compose`）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/video-compose.test.ts`
Expected: FAIL——`escapeAssText is not a function` / 导出不存在

- [ ] **Step 3: 实现**

`lib/services/video-compose.ts`，在 `CaptionCue` 接口定义上方新增：

```ts
/**
 * ASS 文本转义：{ } 是 override tag 定界符、\ 起始 \N/\n/\h 转义序列——AI 文案
 * 若含之会注入 tag 或破坏渲染。ASS 无转义机制，策略：花括号剔除、反斜杠换全角。
 */
export function escapeAssText(text: string): string {
  return text.replace(/[{}]/g, "").replace(/\\/g, "＼");
}

/** 剔除 emoji（libass 无彩色 emoji 字形，烧录后变豆腐块）。口播稿已禁 emoji，此为防御兜底。 */
export function stripEmoji(text: string): string {
  return text.replace(/[\p{Extended_Pictographic}]/gu, "").replace(/️/g, "");
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/video-compose.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/services/video-compose.ts tests/video-compose.test.ts
git commit -m "feat(subtitle): ASS 文本安全纯函数——escapeAssText 防 tag 注入 + stripEmoji 防豆腐块"
```

---

### Task 3: 逐词事件生成（CaptionCue 扩展 + word-captions.ts）

**Files:**
- Modify: `lib/services/video-compose.ts:250-254`（CaptionCue 加三个可选字段）
- Create: `lib/services/word-captions.ts`
- Test: `tests/word-captions.test.ts`（新建）

- [ ] **Step 1: 扩展 CaptionCue**

`lib/services/video-compose.ts` L250-254 改为：

```ts
export interface CaptionCue {
  startSec: number;
  endSec: number;
  text: string;
  /** 逐词事件：当前词在 pageWords 中的下标；undefined = 整句 cue（回退路径，行为不变）。 */
  wordIndex?: number;
  /** 逐词事件：页内词文本序列（渲染时逐词包动效 tag）。 */
  pageWords?: string[];
  /** 逐词事件：两行页的第一行末词下标（其后插 \N 换行）。 */
  lineBreakAfter?: number;
}
```

- [ ] **Step 2: 写失败测试**

新建 `tests/word-captions.test.ts`：

```ts
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
    const pages = paginateWords(wordsOf("一二三四五六七八九十一二三四五六")); // 15 字
    expect(pages).toHaveLength(1);
    expect(pages[0]!.lineBreakAfter).toBe(11); // 前 12 字一行
    expect(pages[0]!.words).toHaveLength(15);
  });

  it("满 2 行翻页", () => {
    const pages = paginateWords(wordsOf("一二三四五六七八九十一二三四五六七八九十一二三四五六")); // 25 字
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
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run tests/word-captions.test.ts`
Expected: FAIL——模块不存在

- [ ] **Step 4: 实现**

新建 `lib/services/word-captions.ts`：

```ts
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
 * 标点永不触发换行/翻页——页首与行首不会是标点。
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
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/word-captions.test.ts tests/video-compose.test.ts tests/segmented-compose.test.ts`
Expected: PASS（新 8 用例 + 既有全绿）

- [ ] **Step 6: Commit**

```bash
git add lib/services/word-captions.ts lib/services/video-compose.ts tests/word-captions.test.ts
git commit -m "feat(subtitle): 逐词字幕事件生成——paginateWords 分页（≤12字/行·2行/页·标点不置行首）+ buildWordCaptionEvents 段偏移回退整句"
```

---

### Task 4: buildAss 逐词渲染四档动效

**Files:**
- Modify: `lib/services/video-compose.ts`（AssStyleSpec 加 animation、buildAss 判别渲染、新增 renderWordEventText）
- Test: `tests/video-compose.test.ts`（追加 describe）

- [ ] **Step 1: 写失败测试**

```ts
describe("buildAss 逐词动效", () => {
  const wordCue = (over: Partial<import("@/lib/services/video-compose").CaptionCue> = {}) => ({
    startSec: 0.2, endSec: 0.4, text: "大家好", wordIndex: 1,
    pageWords: ["大", "家", "好"], ...over,
  });

  it("pop：当前词放大 115% + 高亮色 + \\r 复位", () => {
    const ass = buildAss([wordCue()], "pop");
    expect(ass).toContain("{\\fscx115\\fscy115\\c&H0000FFFF&}家{\\r}");
    expect(ass).toContain("Dialogue: 0,0:00:00.20,0:00:00.40");
  });

  it("highlight：当前词仅变色", () => {
    const ass = buildAss([wordCue()], "highlight");
    expect(ass).toContain("{\\c&H0000FFFF&}家{\\r}");
    expect(ass).not.toContain("fscx");
  });

  it("bounce：两段 100ms 过冲", () => {
    const ass = buildAss([wordCue()], "bounce");
    expect(ass).toContain("{\\t(0,50,\\fscx120\\fscy120)\\t(50,100,\\fscx100\\fscy100)\\c&H0000FFFF&}家{\\r}");
  });

  it("karaoke：当前词 \\kf 厘秒扫色，已读词主色、未读词 SecondaryColour", () => {
    const ass = buildAss([wordCue()], "karaoke");
    expect(ass).toContain("{\\kf20}家"); // (0.4-0.2)*100 = 20 厘秒
    expect(ass).toContain("{\\c&H0000FFFF&}大");   // 已读：主色（黄）
    expect(ass).toContain("{\\c&H99FFFFFF&}好");   // 未读：半透明白
  });

  it("两行页：\\N 插在 lineBreakAfter 之后", () => {
    const ass = buildAss([wordCue({ wordIndex: 0, pageWords: ["一", "二", "三"], lineBreakAfter: 1 })], "highlight");
    expect(ass).toContain("二\\N三");
  });

  it("逐词事件中的危险字符被转义", () => {
    const ass = buildAss([wordCue({ pageWords: ["价", "{", "格"], text: "价{格" })], "pop");
    expect(ass).not.toContain("价{格");
  });

  it("整句 cue（无 wordIndex）走原路径不变", () => {
    const ass = buildAss([{ startSec: 0, endSec: 1, text: "整句字幕" }], "default");
    expect(ass).toContain("Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,整句字幕");
  });
});
```

import 追加 `escapeAssText, stripEmoji` 已有则不动。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/video-compose.test.ts`
Expected: FAIL——`"pop"` 不是合法 preset（类型错误或回退 default 无 fscx）

- [ ] **Step 3: 实现**

`lib/services/video-compose.ts`：

1. `SubtitleStylePreset`（L199）扩展：

```ts
export type SubtitleStylePreset = "default" | "bold_bottom" | "minimal" | "pop" | "highlight" | "bounce" | "karaoke";
```

2. `AssStyleSpec` 加 animation 字段：

```ts
  /** 逐词动效档位；"none" = 静态（现有三预设）。 */
  animation: "none" | "highlight" | "pop" | "bounce" | "karaoke";
```

3. `SUBTITLE_PRESETS` 三旧预设补 `animation: "none"`，新增四预设：

```ts
  pop: { fontname: CJK_FONT, fontsize: 84, primaryColour: "&H00FFFFFF", secondaryColour: "&H00FFFFFF", highlightColour: "&H0000FFFF", outlineColour: "&H00000000", backColour: "&H00000000", bold: 1, outline: 6, alignment: 2, marginV: 60, animation: "pop" },
  highlight: { fontname: CJK_FONT, fontsize: 84, primaryColour: "&H00FFFFFF", secondaryColour: "&H00FFFFFF", highlightColour: "&H0000FFFF", outlineColour: "&H00000000", backColour: "&H00000000", bold: 1, outline: 6, alignment: 2, marginV: 60, animation: "highlight" },
  bounce: { fontname: CJK_FONT, fontsize: 84, primaryColour: "&H00FFFFFF", secondaryColour: "&H00FFFFFF", highlightColour: "&H0000FFFF", outlineColour: "&H00000000", backColour: "&H00000000", bold: 1, outline: 6, alignment: 2, marginV: 60, animation: "bounce" },
  // karaoke：PrimaryColour=已读色（黄），SecondaryColour=未读色（半透明白）——\kf 从后者扫向前者。
  karaoke: { fontname: CJK_FONT, fontsize: 84, primaryColour: "&H0000FFFF", secondaryColour: "&H99FFFFFF", highlightColour: "&H0000FFFF", outlineColour: "&H00000000", backColour: "&H00000000", bold: 1, outline: 6, alignment: 2, marginV: 60, animation: "karaoke" },
```

4. `resolveSubtitlePreset`（L244-246）扩展：

```ts
export function resolveSubtitlePreset(style: string | undefined | null): SubtitleStylePreset {
  return style === "bold_bottom" || style === "minimal" || style === "pop" || style === "highlight" || style === "bounce" || style === "karaoke" ? style : "default";
}
```

5. 新增逐词渲染函数（放在 `wrapHighlightsInAss` 之后）：

```ts
/** 文本清洗组合：emoji 剔除 + ASS 转义（所有进 buildAss 的文本必经）。 */
function sanitizeAssText(text: string): string {
  return escapeAssText(stripEmoji(text));
}

/**
 * 逐词事件文本渲染：整页词序列拼接，当前词按档位包动效 tag，tag 后 {\r} 复位防串色；
 * lineBreakAfter 后插 \N 换行。karaoke 特例：已读词显式主色、未读词显式 SecondaryColour、
 * 当前词 \kf<厘秒> 扫色（每词颜色全覆盖，无需 \r）。
 */
function renderWordEventText(
  cue: { endSec: number; startSec: number; wordIndex?: number; pageWords?: string[]; lineBreakAfter?: number },
  s: AssStyleSpec,
): string {
  const words = cue.pageWords ?? [];
  const idx = cue.wordIndex ?? 0;
  const parts = words.map((word, i) => {
    const text = sanitizeAssText(word);
    if (s.animation === "karaoke") {
      if (i === idx) {
        const durCs = Math.max(1, Math.round((cue.endSec - cue.startSec) * 100));
        return `{\\kf${durCs}}${text}`;
      }
      return i < idx ? `{\\c${s.primaryColour}&}${text}` : `{\\c${s.secondaryColour}&}${text}`;
    }
    if (i !== idx) return text;
    switch (s.animation) {
      case "pop":
        return `{\\fscx115\\fscy115\\c${s.highlightColour}&}${text}{\\r}`;
      case "bounce":
        return `{\\t(0,50,\\fscx120\\fscy120)\\t(50,100,\\fscx100\\fscy100)\\c${s.highlightColour}&}${text}{\\r}`;
      default: // highlight
        return `{\\c${s.highlightColour}&}${text}{\\r}`;
    }
  });
  if (cue.lineBreakAfter !== undefined) {
    parts.splice(cue.lineBreakAfter + 1, 0, "\\N");
  }
  return parts.join("");
}
```

6. `buildAss` 的 dialogues 段（L331-338）改判别渲染 + 文本清洗：

```ts
  const dialogues = cues
    .filter((cue) => cue.text.length > 0)
    .map((cue) => {
      const text = cue.wordIndex !== undefined
        ? renderWordEventText(cue, s)
        : highlights?.length
          ? wrapHighlightsInAss(sanitizeAssText(cue.text), highlights, s.highlightColour, s.primaryColour)
          : sanitizeAssText(cue.text);
      return `Dialogue: 0,${assTimestamp(cue.startSec)},${assTimestamp(cue.endSec)},Default,,0,0,0,,${text}`;
    });
```

（注意：逐词事件路径**不**叠加关键词 highlights——逐词动效本身就是高亮，叠加会乱。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/video-compose.test.ts tests/word-captions.test.ts`
Expected: PASS（若有旧快照断言锁了整句 Dialogue 原文，确认仅时间戳/Style 行差异后更新）

- [ ] **Step 5: Commit**

```bash
git add lib/services/video-compose.ts tests/video-compose.test.ts
git commit -m "feat(subtitle): buildAss 逐词渲染四档——pop放大/bounce弹跳/highlight变色/karaoke扫色，整句路径行为不变"
```

---

### Task 5: schema/types/UI/API 接入新预设 + 默认 pop

**Files:**
- Modify: `lib/schemas.ts:168`、`lib/types.ts:199`、`components/script-confirm.tsx:10-14,73`、`app/api/render-projects/route.ts:109`
- Test: `tests/video-compose.test.ts`（追加预设解析用例）

- [ ] **Step 1: 写失败测试**

```ts
describe("resolveSubtitlePreset 新预设", () => {
  it.each(["pop", "highlight", "bounce", "karaoke"] as const)("%s 映射到自身", (p) => {
    expect(resolveSubtitlePreset(p)).toBe(p);
  });

  it("未知值与 undefined 仍回退 default（旧数据语义不动）", () => {
    expect(resolveSubtitlePreset("legacy_x")).toBe("default");
    expect(resolveSubtitlePreset(undefined)).toBe("default");
  });

  it("karaoke 预设 Style 行 SecondaryColour 为半透明白", () => {
    const ass = buildAss([{ startSec: 0, endSec: 1, text: "测试" }], "karaoke");
    const styleLine = ass.split("\n").find((l) => l.startsWith("Style: Default,"));
    expect(styleLine).toContain("&H99FFFFFF");
  });
});
```

- [ ] **Step 2: 跑确认失败（pop 等新值未入类型/枚举）**

Run: `npx vitest run tests/video-compose.test.ts`
Expected: Task 4 已让 resolveSubtitlePreset 支持新预设——此步应**已通过**（Task 4 实现了映射）；本 Task 的测试价值在锁定回归。若全绿直接进入 Step 3。

- [ ] **Step 3: schema/types/UI/API 改动**

1. `lib/schemas.ts:168`：

```ts
  subtitleStyle: z.enum(["default", "bold_bottom", "minimal", "pop", "highlight", "bounce", "karaoke"]),
```

2. `lib/types.ts:199`：

```ts
  subtitleStyle: "default" | "bold_bottom" | "minimal" | "pop" | "highlight" | "bounce" | "karaoke";
```

3. `components/script-confirm.tsx` L10-14：

```ts
const SUBTITLE_OPTIONS = [
  { value: "pop", label: "动感放大（推荐）" },
  { value: "highlight", label: "逐词变色" },
  { value: "bounce", label: "弹跳入场" },
  { value: "karaoke", label: "卡拉OK扫色" },
  { value: "bold_bottom", label: "综艺黄（粗体底部·静态）" },
  { value: "default", label: "标准白字（静态）" },
  { value: "minimal", label: "极简小字（静态）" },
];
```

L73：`useState("bold_bottom")` → `useState("pop")`。

4. `app/api/render-projects/route.ts` L109：`?? "bold_bottom"` → `?? "pop"`（API 默认只影响新请求；存量 DB 值不动）。

- [ ] **Step 4: 跑测试 + typecheck**

Run: `npx vitest run tests/video-compose.test.ts && npm run typecheck`
Expected: PASS + 类型零错误

- [ ] **Step 5: Commit**

```bash
git add lib/schemas.ts lib/types.ts components/script-confirm.tsx app/api/render-projects/route.ts tests/video-compose.test.ts
git commit -m "feat(subtitle): 四档动效预设接入 schema/types/UI/API——新项目默认 pop，存量项目样式不动"
```

---

### Task 6: 分段链路接入（video-render.ts）

**Files:**
- Modify: `worker/processors/video-render.ts:18-28`（import）、`199-203`（cue 分支）
- Test: `tests/video-render-processor-captions.test.ts`（追加链路用例）

- [ ] **Step 1: 写失败测试**

追加到 `tests/video-render-processor-captions.test.ts`（mock 风格对齐该文件既有用例）：

```ts
it("manifest 带 words 时产出逐词字幕事件（每词一条 Dialogue）", async () => {
  // 参照本文件既有用例构造 deps/project/draft；voiceTrack manifest 的段带 words：
  //   words = [{word:"大",startSec:0,endSec:0.2},{word:"家",startSec:0.2,endSec:0.4}]
  // 断言 renderComposite 收到的 assContent：
  //   - Dialogue 行数 = 词数（2 条而非 1 条整句）
  //   - 含当前词动效 tag（pop 预设下 \\fscx115）
});

it("manifest 无 words 时回退整句（每段一条 Dialogue，与改造前一致）", async () => {
  // manifest 段不带 words；断言 Dialogue 行数 = 段数，且不含 \\fscx
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/video-render-processor-captions.test.ts`
Expected: FAIL——带 words 时 Dialogue 仍是每段 1 条

- [ ] **Step 3: 接入**

`worker/processors/video-render.ts`：

1. import 区：`buildSegmentedCaptionCues` 替换为 `buildWordCaptionEvents`（来源 `@/lib/services/word-captions`）。
2. L199-203：

```ts
  const captionCues = voiceTrack
    ? buildWordCaptionEvents(voiceTrack)
    : mode === "presenter_broll"
      ? buildCaptionCues(draft.voiceover, totalDurationSec)
      : [];
```

（`buildSegmentedCaptionCues` 保留在 segmented-compose.ts 不删——新函数的回退分支与其行为一致，旧函数留作参照实现；若 lint 报未使用则从 segmented-compose 的导出/ import 中清理。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/video-render-processor-captions.test.ts tests/segmented-compose.test.ts`
Expected: PASS（既有 7 + 12 用例全绿 + 新增 2 绿）

- [ ] **Step 5: Commit**

```bash
git add worker/processors/video-render.ts tests/video-render-processor-captions.test.ts
git commit -m "feat(render): 分段链路接入逐词字幕事件——有 words 段每词一条事件，无 words 段回退整句"
```

---

### Task 7: 五件套 + 抽帧验收

**Files:** 无新增（验证任务）

- [ ] **Step 1: 五件套**

```bash
npm test && npm run typecheck && npm run lint && npx prisma validate && npm run build
```
Expected: 全绿

- [ ] **Step 2: demo 模式抽帧验收**

demo 模式起 web + worker，创建分段渲染项目（字幕样式选 pop），等产出后抽帧：

```bash
# 产物 mp4 抽 4 帧（开场/中段两个词切换点/结尾）
ffmpeg -i <output>.mp4 -vf "select='eq(n\,30)+eq(n\,90)+eq(n\,150)+eq(n\,210)'" -vsync vfr frame_%d.png
```

人工确认：①当前词放大变色 ②词切换跟随语音节奏 ③两行页 `\N` 换行正常 ④无豆腐块/乱 tag。

- [ ] **Step 3: 若验收通过——push**

```bash
git push
```
Zeabur 自动部署（无迁移、无新环境变量）。

- [ ] **Step 4: 更新记忆/roadmap**（主会话负责，非 subagent）

---

## Self-Review 记录

- **Spec 覆盖**：四档（Task 4/5）✓ 默认 pop（Task 5）✓ 只分段链路（Task 6，整片分支不动）✓ 无 words 回退（Task 3/6）✓ 两 bug（Task 1）✓ 文本安全（Task 2/4）✓ 抽帧验收（Task 7）✓ 停顿分页不做（spec §6，无对应任务）✓
- **Placeholder 扫描**：无 TBD/TODO；每个代码步骤含完整代码。
- **类型一致性**：`CaptionCue` 扩展（Task 3）→ `renderWordEventText` 入参（Task 4）→ 测试工厂（Task 3/4）一致；`paginateWords` 返回 `CaptionPage` 在 Task 3 定义并消费；`SUBTITLE_OPTIONS`/enum 值在 Task 5 三处一致。
