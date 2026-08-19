# Phase 2：脚本确认流重构（去分镜）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 去除分镜脚本环节，改为「整段口播稿 + AI 标黄 + 确认后选形象」两步流；`ScriptDraft` 扩展 `highlights`/`segments`，渲染 scenes 由服务端从口播派生。

**Architecture:** 口播稿（voiceover）成为唯一用户编辑对象；`segments`（按句分段）由服务端确定性切分（AI 只产出标黄词与出镜句选择），`scenes` 降级为渲染内部概念（首/末句派生 presenter 镜），现有 buildTimeline/渲染管线不动；字幕 ASS 在预设主色基础上对标黄词包 `{\c&H00FFFF&}`。

**Tech Stack:** Next.js 16 / TypeScript strict / Prisma 7 / Vitest / BullMQ worker / ffmpeg (ASS subtitles)。

**Spec:** `docs/superpowers/specs/2026-08-16-voiceover-centric-pipeline-design.md`（§5 Phase 2）

---

## 设计决策记录（含对 spec 字面的有理由偏离）

1. **标黄 ASS 包裹实现于 `buildAss` 而非 spec 字面写的 `buildCaptionCues(voiceover, highlights)`**：标黄词包完 `{\c&H00FFFF&}` 后必须 reset 回预设主色（如 `&H00FFFFFF`），而 preset 只有 `buildAss` 知道。行为与 spec 一致（标黄词包 `{\c&H00FFFF&}`），`buildCaptionCues` 保持 preset 无关。
2. **segments 由服务端从 voiceover 确定性切分**（复用 `splitVoiceoverSentences`），AI 仅产出 `highlights` 与 `onCameraSentences`（出镜句原文）。保证 segments 精确拼回 voiceover——「字幕 = 口播」不变式（B3 根治地基）不被 AI 输出漂移破坏。`onCamera` 判断仍是 AI 产出的，符合 spec §5.1。
3. **PATCH 契约替换**：编辑对象从逐镜 `scene.text`/`matchedAssetId` 改为 `voiceover` 全文。旧字段不再接受（分镜 UI 删除后无消费者）。
4. **`avatarProfileId`（单数）保留兼容**；新增 `avatarProfileIds[]`（本期长度 ≤1，>1 返回 400）；顺手补上 avatar 属主校验（foreign/不存在 → 404，不泄漏存在性）。
5. **`captions` 统一落 `[voiceover]`**：AI 契约移除 captions（该字段从未进渲染，spec §1.1 B3）。
6. **删除 `lib/services/script-match.ts`**：派生 scenes 无 assetHints，matchedAssetId pinning 随分镜 UI 退场；b-roll 顺序 = 素材池勾选顺序（spec §5.3「b-roll 段按素材交错」即 buildTimeline 现有池行为）。
7. **`highlights`/`segments` 在 TS 类型上为 optional**（与 Phase 1 `targetDurationSec` 同款先例，避免存量测试 fixture 批量编译错误）；Prisma 层 `NOT NULL DEFAULT`，mapper 兜底 `[]`。
8. **PATCH 不做敏感词清洗**：用户本人改稿，owner 对自己的 forbiddenWords 负责（与旧 PATCH 不清洗 scene.text 一致）。

---

## File Structure

| 文件 | 改动 | 责任 |
|---|---|---|
| `lib/types.ts` | 修改 | 新增 `ScriptSegment`；`ScriptDraft` 加 `highlights?`/`segments?` |
| `prisma/schema.prisma` + 新 migration | 修改/新建 | `ScriptDraft` 加 `highlights String[] @default([])`、`segments Json @default("[]")` |
| `lib/repositories/mappers.ts` | 修改 | `toScriptDraft`/`toScriptDraftInput` 透传两字段 |
| `lib/schemas.ts` | 修改 | `scriptSegmentSchema` 新增；`scriptDraftSchema` 补 optional 字段（含 Phase 1 漏掉的 targetDurationSec） |
| `lib/highlight-ranges.ts` | 新建 | 标黄词命中区间纯函数（UI 预览与 ASS 包裹共用，DRY） |
| `lib/services/scene-derive.ts` | 新建 | voiceover→segments、segments→scenes、highlights 过滤、句时长估算 |
| `lib/services/script-engine.ts` | 修改 | AI 契约改为 voiceover+highlights+onCameraSentences；三路径派生 segments/scenes；删模板镜与匹配 |
| `lib/services/script-match.ts` | 删除 | matchedAssetId 匹配随分镜 UI 退场 |
| `app/api/script-drafts/route.ts` | 修改 | forceTemplate 调用点适配新签名 |
| `app/api/script-drafts/[id]/route.ts` | 重写 | PATCH 改 voiceover 全文 + 重切 segments + 过滤标黄 + 重派生 scenes |
| `app/api/render-projects/route.ts` | 修改 | 接受 `avatarProfileIds[]`（≤1）+ avatar 属主 404 校验 |
| `lib/services/video-compose.ts` | 修改 | `buildAss` 加 `highlights?` 参数 + `wrapHighlightsInAss` |
| `worker/processors/video-render.ts` | 修改 | buildAss 接线 `draft.highlights` |
| `lib/api-client.ts` | 修改 | `updateScriptDraftApi` 改 voiceover；`createRenderProjectApi` 加 `avatarProfileIds?` |
| `components/script-confirm.tsx` | 新建 | 口播确认卡片（标黄预览 + 编辑 + 形象单选 + 字幕/BGM） |
| `components/dashboard.tsx` | 修改 | 智能成片内嵌两步流；删 StoryboardConfirm 引用 |
| `components/storyboard-confirm.tsx` | 删除 | 分镜确认流退场 |
| `tests/highlight-ranges.test.ts` | 新建 | 区间纯函数测试 |
| `tests/scene-derive.test.ts` | 新建 | 派生逻辑测试 |
| `tests/script-engine.test.ts` | 重写 | 新契约（highlights/segments/派生 scenes） |
| `tests/api/script-drafts-id.test.ts` | 重写 | PATCH voiceover 契约 |
| `tests/api/render-projects.test.ts` | 修改 | avatarProfileIds 用例追加 |
| `tests/repositories/mappers.test.ts` | 修改 | highlights/segments 往返追加 |
| `tests/video-compose.test.ts` | 修改 | buildAss 标黄用例追加 |
| `tests/video-render-processor-captions.test.ts` | 修改 | 处理器标黄接线用例追加 |
| `tests/script-confirm.test.tsx` | 新建 | 确认卡片组件测试 |
| `tests/dashboard.test.tsx` | 修改 | 按钮改名 + 确认流集成用例 |
| `tests/storyboard-confirm.test.tsx` | 删除 | 随组件删除 |
| `tests/script-match.test.ts` | 删除 | 随 script-match 删除 |

---

### Task 1: 数据模型——`ScriptSegment` 类型 + Prisma 持久化 + mappers + zod

**Files:**
- Modify: `lib/types.ts:102-135`
- Modify: `prisma/schema.prisma:132-151`
- Create: `prisma/migrations/<timestamp>_add_script_highlights_segments/migration.sql`
- Modify: `lib/repositories/mappers.ts:176-214`
- Modify: `lib/schemas.ts:102-124`
- Test: `tests/repositories/mappers.test.ts`（追加 describe）

- [ ] **Step 1: 写失败测试（mapper 往返透传 highlights/segments）**

打开 `tests/repositories/mappers.test.ts`（Phase 1 已建，内含 `draft`/`project` fixture 与 targetDurationSec 往返测试），在文件末尾追加：

```ts
describe("mappers: highlights/segments persistence (Phase 2)", () => {
  it("toScriptDraftInput / toScriptDraft roundtrip highlights + segments", () => {
    const draftWithHl: ScriptDraft = {
      ...draft,
      highlights: ["牛肉面", "第二份半价"],
      segments: [
        { index: 0, text: "第一句。", speakerIndex: 0, onCamera: true },
        { index: 1, text: "第二句。", speakerIndex: 0, onCamera: false },
      ],
    };
    const dbInput = toScriptDraftInput(draftWithHl);
    expect(dbInput.highlights).toEqual(["牛肉面", "第二份半价"]);
    const row = { ...dbInput, createdAt: new Date("2026-08-16T00:00:00.000Z") };
    const back = toScriptDraft(row as never);
    expect(back.highlights).toEqual(["牛肉面", "第二份半价"]);
    expect(back.segments).toEqual([
      { index: 0, text: "第一句。", speakerIndex: 0, onCamera: true },
      { index: 1, text: "第二句。", speakerIndex: 0, onCamera: false },
    ]);
  });

  it("defaults highlights/segments to empty when absent on the domain object", () => {
    const dbInput = toScriptDraftInput({ ...draft, highlights: undefined, segments: undefined });
    expect(dbInput.highlights).toEqual([]);
    expect(dbInput.segments).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/repositories/mappers.test.ts`
Expected: FAIL（TS 编译错误：`highlights`/`segments` 不在 `ScriptDraft` 类型上）

- [ ] **Step 3: `lib/types.ts` 加 `ScriptSegment` 与 `ScriptDraft` 扩展**

在 `ScriptScene` 接口之后、`ScriptDraft` 之前插入：

```ts
export interface ScriptSegment {
  /** 句序号（0 起，按口播稿句序）。 */
  index: number;
  /** 该句口播原文。 */
  text: string;
  /** 说话形象下标（Phase 2 恒 0；Phase 3 多形象轮播使用）。 */
  speakerIndex: number;
  /** 是否真人出镜段（Phase 2 渲染忽略；Phase 3 分段生成使用）。 */
  onCamera: boolean;
}
```

`ScriptDraft` 接口在 `targetDurationSec?: number;` 之后加两字段：

```ts
  /** 标黄关键词（AI 产出；用户改稿后文中不存在的词由服务端过滤失效）。 */
  highlights?: string[];
  /** 口播按句分段（服务端从 voiceover 派生/重切）。 */
  segments?: ScriptSegment[];
```

- [ ] **Step 4: Prisma schema + migration**

`prisma/schema.prisma` 的 `model ScriptDraft`，在 `targetDurationSec Int?` 之后加：

```prisma
  highlights         String[]  @default([])
  segments           Json      @default("[]")
```

生成迁移（本地有开发库时）：

Run: `npx prisma migrate dev --name add_script_highlights_segments`
Expected: 生成 `prisma/migrations/<timestamp>_add_script_highlights_segments/migration.sql`、应用到开发库、重新生成 client

**无本地开发库时的兜底**（测试走 memory repo，不依赖真实库）：手工创建目录与文件
`prisma/migrations/20260819120000_add_script_highlights_segments/migration.sql`：

```sql
ALTER TABLE "ScriptDraft" ADD COLUMN "highlights" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "ScriptDraft" ADD COLUMN "segments" JSONB NOT NULL DEFAULT '[]';
```

然后运行 `npx prisma generate` 更新 client 类型。

最后验证：Run: `npx prisma validate` → Expected: `The schema is valid`

注意（ops）：部署到生产后需对生产库执行 `npx prisma migrate deploy`（与 Phase 1 `targetDurationSec` 迁移同一流程）。

- [ ] **Step 5: `lib/repositories/mappers.ts` 透传**

`toScriptDraft` 在 `targetDurationSec: row.targetDurationSec ?? undefined,` 之后加：

```ts
    highlights: row.highlights ?? [],
    segments: (row.segments as unknown as ScriptSegment[] | null) ?? [],
```

`toScriptDraftInput` 在 `targetDurationSec: script.targetDurationSec ?? null,` 之后加：

```ts
    highlights: script.highlights ?? [],
    segments: (script.segments ?? []) as object,
```

文件顶部 import 行的 `ScriptScene` 旁加 `ScriptSegment`：

```ts
import type { ..., ScriptScene, ScriptSegment, ... } from "@/lib/types";
```

（按现有 import 实际内容合并，保持单行/多行风格不变。）

- [ ] **Step 6: `lib/schemas.ts` 同步 zod 契约**

在 `scriptSceneSchema` 之后插入：

```ts
export const scriptSegmentSchema = z.object({
  index: z.number().int().nonnegative(),
  text: z.string().min(1),
  speakerIndex: z.number().int().nonnegative(),
  onCamera: z.boolean()
});
```

`scriptDraftSchema` 在 `complianceWarnings` 之后加三个 optional 字段（顺带补齐 Phase 1 漏掉的 targetDurationSec）：

```ts
  targetDurationSec: z.number().int().positive().optional(),
  highlights: z.array(z.string()).optional(),
  segments: z.array(scriptSegmentSchema).optional(),
```

- [ ] **Step 7: 跑测试确认通过 + 全量类型检查**

Run: `npx vitest run tests/repositories/mappers.test.ts tests/repositories/script.test.ts tests/schemas.test.ts`
Expected: 全部 PASS

Run: `npm run typecheck`
Expected: 无错误

- [ ] **Step 8: Commit**

```bash
git add lib/types.ts prisma/schema.prisma prisma/migrations lib/repositories/mappers.ts lib/schemas.ts tests/repositories/mappers.test.ts
git commit -m "feat(script): persist highlights/segments on ScriptDraft (Phase 2 data model)"
```

---

### Task 2: 纯函数模块——`lib/highlight-ranges.ts` + `lib/services/scene-derive.ts`

**Files:**
- Create: `lib/highlight-ranges.ts`
- Create: `lib/services/scene-derive.ts`
- Test: `tests/highlight-ranges.test.ts`（新建）
- Test: `tests/scene-derive.test.ts`（新建）

- [ ] **Step 1: 写失败测试 `tests/highlight-ranges.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { findHighlightRanges } from "@/lib/highlight-ranges";

describe("findHighlightRanges", () => {
  it("finds a single word occurrence", () => {
    expect(findHighlightRanges("牛肉面今天半价", ["牛肉面"])).toEqual([[0, 3]]);
  });

  it("finds every occurrence of a word", () => {
    expect(findHighlightRanges("牛肉面配牛肉汤", ["牛肉"])).toEqual([
      [0, 2],
      [4, 6],
    ]);
  });

  it("prefers longer words on overlap", () => {
    // “牛肉面” 命中 [0,3] 后，“牛肉” 的 [0,2] 重叠跳过，只保留 [4,6]
    expect(findHighlightRanges("牛肉面配牛肉汤", ["牛肉", "牛肉面"])).toEqual([
      [0, 3],
      [4, 6],
    ]);
  });

  it("returns ranges sorted by start regardless of input order", () => {
    expect(findHighlightRanges("先汤后面", ["面", "汤"])).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("drops words not present, trims blanks, dedupes", () => {
    expect(findHighlightRanges("今天半价", ["不存在", "  ", "半价", "半价"])).toEqual([[2, 4]]);
  });

  it("no hits → empty array", () => {
    expect(findHighlightRanges("普通一句话", ["xyz"])).toEqual([]);
  });
});
```

- [ ] **Step 2: 写失败测试 `tests/scene-derive.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import {
  deriveScenesFromSegments,
  deriveSegmentsFromVoiceover,
  estimateSegmentSeconds,
  filterActiveHighlights,
} from "@/lib/services/scene-derive";

describe("deriveSegmentsFromVoiceover", () => {
  it("splits by sentence with index/speakerIndex=0 and defaults onCamera to first+last", () => {
    const segments = deriveSegmentsFromVoiceover("开场一句。中间一句。结尾一句。");
    expect(segments.map((s) => s.text)).toEqual(["开场一句。", "中间一句。", "结尾一句。"]);
    expect(segments.map((s) => s.index)).toEqual([0, 1, 2]);
    expect(segments.every((s) => s.speakerIndex === 0)).toBe(true);
    expect(segments.map((s) => s.onCamera)).toEqual([true, false, true]);
  });

  it("single sentence → single onCamera segment", () => {
    const segments = deriveSegmentsFromVoiceover("只有一句没有标点");
    expect(segments).toHaveLength(1);
    expect(segments[0]?.onCamera).toBe(true);
  });

  it("AI onCameraTexts win over the first/last default", () => {
    const segments = deriveSegmentsFromVoiceover("开场一句。中间一句。结尾一句。", {
      onCameraTexts: ["中间一句。"],
    });
    expect(segments.map((s) => s.onCamera)).toEqual([false, true, false]);
  });

  it("unchanged sentences inherit onCamera from prev; new sentences fall back to default", () => {
    const prev = deriveSegmentsFromVoiceover("旧开场。旧结尾。"); // [true, true]
    const segments = deriveSegmentsFromVoiceover("旧开场。新中段。新收尾。", { prev });
    expect(segments.map((s) => s.onCamera)).toEqual([true, false, true]);
  });

  it("empty voiceover → no segments", () => {
    expect(deriveSegmentsFromVoiceover("")).toEqual([]);
  });
});

describe("filterActiveHighlights", () => {
  it("keeps only words present in the voiceover, trimmed and deduped", () => {
    expect(
      filterActiveHighlights(["牛肉面", "不存在词", " 牛肉面 ", ""], "今天牛肉面半价"),
    ).toEqual(["牛肉面"]);
  });
});

describe("deriveScenesFromSegments", () => {
  it("empty → empty", () => {
    expect(deriveScenesFromSegments([])).toEqual([]);
  });

  it("single segment → single presenter scene", () => {
    const scenes = deriveScenesFromSegments([
      { index: 0, text: "唯一一句口播在这里。", speakerIndex: 0, onCamera: true },
    ]);
    expect(scenes).toHaveLength(1);
    expect(scenes[0]?.role).toBe("presenter");
    expect(scenes[0]?.text).toBe("唯一一句口播在这里。");
  });

  it("three segments → first/last presenter scenes with estimated durations", () => {
    const scenes = deriveScenesFromSegments([
      { index: 0, text: "阿姨手作面馆今天主推牛肉面，现熬牛骨汤。", speakerIndex: 0, onCamera: true },
      { index: 1, text: "除了牛肉面，葱油拌面也值得一试。", speakerIndex: 0, onCamera: false },
      { index: 2, text: "现在到店，直接报视频里的活动。", speakerIndex: 0, onCamera: true },
    ]);
    expect(scenes).toHaveLength(2);
    expect(scenes.map((s) => s.role)).toEqual(["presenter", "presenter"]);
    expect(scenes.map((s) => s.order)).toEqual([1, 2]);
    // 20 字 / 4.5 ≈ 4s；15 字 / 4.5 ≈ 3s
    expect(scenes.map((s) => s.durationSeconds)).toEqual([4, 3]);
    expect(scenes.every((s) => s.assetHints.length === 0)).toBe(true);
  });
});

describe("estimateSegmentSeconds", () => {
  it("rounds chars/4.5 with a 3s floor", () => {
    expect(estimateSegmentSeconds("短句。")).toBe(3); // 3 字 → floor 3
    expect(estimateSegmentSeconds("阿姨手作面馆今天主推牛肉面，现熬牛骨汤。")).toBe(4); // 20 字
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run tests/highlight-ranges.test.ts tests/scene-derive.test.ts`
Expected: FAIL（模块不存在：`@/lib/highlight-ranges`、`@/lib/services/scene-derive`）

- [ ] **Step 4: 实现 `lib/highlight-ranges.ts`**

```ts
/**
 * 找出 text 中所有标黄词命中区间：长词优先（避免“牛肉面”被“牛肉”截断）、
 * 跳过重叠、按起点升序。UI 预览与 ASS 包裹共用（DRY）。
 */
export function findHighlightRanges(text: string, words: string[]): Array<[number, number]> {
  const active = [...new Set(words.map((w) => w.trim()).filter(Boolean))]
    .filter((w) => text.includes(w))
    .sort((a, b) => b.length - a.length);

  const ranges: Array<[number, number]> = [];
  for (const word of active) {
    let from = 0;
    for (;;) {
      const start = text.indexOf(word, from);
      if (start === -1) break;
      const end = start + word.length;
      if (!ranges.some(([s, e]) => start < e && end > s)) {
        ranges.push([start, end]);
      }
      from = end;
    }
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}
```

- [ ] **Step 5: 实现 `lib/services/scene-derive.ts`**

```ts
import { splitVoiceoverSentences } from "@/lib/services/video-compose";
import type { ScriptScene, ScriptSegment } from "@/lib/types";

/** 中文口播语速假设：约 4.5 字/秒（spec §4.1，Phase 1 上线后按实测校准）。 */
const CHARS_PER_SECOND = 4.5;
/** presenter 镜最短时长，避免退化 trim 窗口。 */
const MIN_PRESENTER_SEC = 3;

/** 口播句时长估算：字数 / 4.5，下限 3s。 */
export function estimateSegmentSeconds(text: string): number {
  return Math.max(MIN_PRESENTER_SEC, Math.round(Array.from(text).length / CHARS_PER_SECOND));
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
```

注意：`splitVoiceoverSentences` 从 `@/lib/services/video-compose` 复用（Phase 1 已导出；video-compose 只 import types，无循环依赖）。

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run tests/highlight-ranges.test.ts tests/scene-derive.test.ts`
Expected: 全部 PASS

- [ ] **Step 7: Commit**

```bash
git add lib/highlight-ranges.ts lib/services/scene-derive.ts tests/highlight-ranges.test.ts tests/scene-derive.test.ts
git commit -m "feat(script): add voiceover segment/scene derivation + highlight range utils"
```

---

### Task 3: script-engine——三路径产出 highlights/segments + 派生 scenes

**Files:**
- Modify: `lib/services/script-engine.ts`（大改）
- Modify: `app/api/script-drafts/route.ts:44-58`（forceTemplate 调用点）
- Delete: `lib/services/script-match.ts`
- Delete: `tests/script-match.test.ts`
- Test: `tests/script-engine.test.ts`（整文件重写）

- [ ] **Step 1: 重写失败测试 `tests/script-engine.test.ts`（整文件替换）**

```ts
import { describe, expect, it, vi } from "vitest";
import { createScriptDraft, createTemplateScriptDraft, warnIfVoiceoverOffTarget } from "@/lib/services/script-engine";
import * as aiClient from "@/lib/services/ai-client";
import type { AssetAnalysis, StoreProfile } from "@/lib/types";

const store: StoreProfile = {
  id: "store_1",
  ownerId: "user_1",
  name: "阿姨手作面馆",
  industry: "餐饮",
  location: "上海市徐汇区",
  mainProducts: ["牛肉面", "葱油拌面"],
  averageOrderValue: 38,
  targetCustomers: ["附近上班族"],
  sellingPoints: ["现熬牛骨汤", "午市出餐快"],
  promotions: ["工作日午餐第二份半价"],
  brandTone: "亲切接地气",
  forbiddenWords: ["最便宜", "全网第一"],
  contactPhone: "13800138000",
  logoAssetId: "asset_logo",
  storefrontAssetId: "asset_front",
  createdAt: "2026-06-03T10:00:00.000Z",
  updatedAt: "2026-06-03T10:00:00.000Z"
};

const analysis: AssetAnalysis[] = [
  {
    id: "analysis_1",
    assetId: "asset_1",
    visualTags: ["食物", "热汤", "门店环境"],
    businessTags: ["招牌菜", "到店引流"],
    transcript: "牛肉面热气腾腾，午餐很快出餐",
    keywords: ["牛肉面", "午餐", "快"],
    confidence: 0.86,
    recommendedUses: ["new_product", "store_traffic"],
    createdAt: "2026-06-03T10:00:00.000Z",
    analysisStatus: "succeeded"
  }
];

describe("script engine (voiceover-centric)", () => {
  it("creates structured short-video copy from store profile and asset analysis", async () => {
    const draft = await createScriptDraft({
      store,
      assetAnalyses: analysis,
      purpose: "store_traffic",
      platform: "douyin"
    });

    expect(draft.title).toContain("阿姨手作面馆");
    expect(draft.hook).toContain("牛肉面");
    expect(draft.voiceover).toContain("现熬牛骨汤");
    expect(draft.cta).toContain("到店");
    expect(draft.complianceWarnings).not.toContain("全网第一");
    // Phase 2：口播为中心——30s 模板 2 句 → 2 segments / 2 presenter scenes
    expect(draft.segments ?? []).toHaveLength(2);
    expect(draft.highlights).toEqual(expect.arrayContaining(["牛肉面", "现熬牛骨汤"]));
    expect(draft.scenes).toHaveLength(2);
    expect(draft.scenes.every((s) => s.role === "presenter")).toBe(true);
    expect(draft.scenes[0]?.text).toBe(draft.segments?.[0]?.text);
  });

  it("falls back to a deterministic industry template when AI generation is unavailable", () => {
    const draft = createTemplateScriptDraft({
      store,
      purpose: "new_product",
      reason: "ai_unavailable"
    });

    expect(draft.generationMode).toBe("template_fallback");
    expect(draft.title).toContain("牛肉面");
    expect(draft.voiceover).toContain("牛肉面");
  });

  it("removes forbidden words from generated copy", async () => {
    const draft = await createScriptDraft({
      store,
      assetAnalyses: analysis,
      purpose: "promotion",
      platform: "wechat_channels",
      forcedRawCopy: "全网第一便宜，附近最便宜的牛肉面"
    });

    expect(draft.voiceover).not.toContain("全网第一");
    expect(draft.voiceover).not.toContain("最便宜");
    expect(draft.complianceWarnings).toContain("Removed forbidden words: 最便宜, 全网第一");
    expect(draft.highlights).toEqual(["牛肉面"]);
  });

  it("derives presenter scenes from the first and last voiceover sentences", () => {
    const draft = createTemplateScriptDraft({ store, purpose: "promotion", reason: "test" });
    const segments = draft.segments ?? [];
    expect(draft.scenes.map((s) => s.role)).toEqual(["presenter", "presenter"]);
    expect(draft.scenes[0]?.text).toBe(segments[0]?.text);
    expect(draft.scenes[1]?.text).toBe(segments[segments.length - 1]?.text);
  });

  it("accepts targetDurationSec and carries it onto the draft", async () => {
    const draft = await createScriptDraft({
      store,
      assetAnalyses: analysis,
      purpose: "promotion",
      platform: "douyin",
      forcedRawCopy: "短文案测试",
      targetDurationSec: 15,
    });
    expect(draft.targetDurationSec).toBe(15);
    expect((draft.segments ?? []).length).toBeGreaterThan(0);
  });

  it("template 45s slot: 3 segments, 2 derived presenter scenes with estimated durations", () => {
    const d45 = createTemplateScriptDraft({
      store, purpose: "store_traffic", reason: "test", targetDurationSec: 45,
    });
    expect(d45.targetDurationSec).toBe(45);
    // 45s 档口播 3 句（主推 + 第二产品 + CTA）
    expect(d45.segments ?? []).toHaveLength(3);
    expect(d45.scenes).toHaveLength(2);
    // 首句 20 字 ≈ 4s；末句 15 字 ≈ 3s
    expect(d45.scenes.map((s) => s.durationSeconds)).toEqual([4, 3]);
  });

  it("template default (no target) keeps the 30s 2-sentence layout", () => {
    const d = createTemplateScriptDraft({ store, purpose: "store_traffic", reason: "test" });
    expect(d.segments ?? []).toHaveLength(2);
    expect(d.scenes).toHaveLength(2);
    expect(d.targetDurationSec).toBeUndefined();
  });

  it("template 60s slot produces more segments and store-field highlights", () => {
    const d30 = createTemplateScriptDraft({
      store, purpose: "store_traffic", reason: "test", targetDurationSec: 30,
    });
    const d60 = createTemplateScriptDraft({
      store, purpose: "store_traffic", reason: "test", targetDurationSec: 60,
    });
    expect((d60.segments ?? []).length).toBeGreaterThan((d30.segments ?? []).length);
    expect(d60.voiceover.length).toBeGreaterThan(d30.voiceover.length);
    expect(d60.voiceover).toContain("工作日午餐第二份半价");
    expect(d60.highlights).toEqual(expect.arrayContaining(["工作日午餐第二份半价", "葱油拌面"]));
  });

  it("warnIfVoiceoverOffTarget warns when voiceover length deviates >50% from the slot", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    warnIfVoiceoverOffTarget("太短了。", 45); // 4 字 vs 预期 ≈202 字
    expect(spy).toHaveBeenCalledOnce();
    spy.mockClear();
    warnIfVoiceoverOffTarget("字".repeat(200), 45); // 200 字 ≈ 预期 202 字
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("AI path filters highlights to words present in the voiceover and derives segments/scenes", async () => {
    const hasAISpy = vi.spyOn(aiClient, "hasAI").mockReturnValue(true);
    const aiSpy = vi.spyOn(aiClient, "chatCompletionJSON").mockResolvedValue({
      title: "测试标题",
      hook: "测试钩子",
      voiceover: "第一句口播内容。第二句口播内容。第三句口播内容。",
      highlights: ["口播", "稿里不存在的词"],
      onCameraSentences: ["第二句口播内容。"],
      cta: "到店体验",
    });
    try {
      const draft = await createScriptDraft({
        store, assetAnalyses: analysis, purpose: "store_traffic", platform: "douyin",
      });
      expect(draft.generationMode).toBe("ai");
      expect(draft.highlights).toEqual(["口播"]);
      const segments = draft.segments ?? [];
      expect(segments.map((s) => s.text)).toEqual(["第一句口播内容。", "第二句口播内容。", "第三句口播内容。"]);
      expect(segments.map((s) => s.onCamera)).toEqual([false, true, false]);
      expect(segments.every((s) => s.speakerIndex === 0)).toBe(true);
      expect(draft.scenes).toHaveLength(2);
      expect(draft.scenes[0]?.text).toBe("第一句口播内容。");
    } finally {
      hasAISpy.mockRestore();
      aiSpy.mockRestore();
    }
  });

  it("AI path tolerates missing highlights/onCameraSentences (defaults: first+last on-camera)", async () => {
    const hasAISpy = vi.spyOn(aiClient, "hasAI").mockReturnValue(true);
    const aiSpy = vi.spyOn(aiClient, "chatCompletionJSON").mockResolvedValue({
      title: "t",
      hook: "h",
      voiceover: "开场一句。中间一句。结尾一句。",
      cta: "到店",
    });
    try {
      const draft = await createScriptDraft({
        store, assetAnalyses: analysis, purpose: "store_traffic", platform: "douyin",
      });
      expect(draft.highlights).toEqual([]);
      expect((draft.segments ?? []).map((s) => s.onCamera)).toEqual([true, false, true]);
    } finally {
      hasAISpy.mockRestore();
      aiSpy.mockRestore();
    }
  });

  it("forcedRawCopy path derives segments, scenes and store-field highlights", async () => {
    const draft = await createScriptDraft({
      store, assetAnalyses: analysis, purpose: "promotion", platform: "douyin",
      forcedRawCopy: "现熬牛骨汤，午市出餐快。欢迎来尝。",
    });
    expect(draft.segments ?? []).toHaveLength(2);
    expect(draft.scenes.map((s) => s.role)).toEqual(["presenter", "presenter"]);
    expect(draft.highlights).toEqual(expect.arrayContaining(["现熬牛骨汤", "午市出餐快"]));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/script-engine.test.ts`
Expected: FAIL（`warnIfVoiceoverOffTarget` 未导出；`createTemplateScriptDraft` 入参不再含 assetAnalyses 导致 TS 错误等）

- [ ] **Step 3: 改造 `lib/services/script-engine.ts`**

以下为改动块的完整代码。未列出的函数（`purposeLabels`/`purposeCta`/`platformNames`/`buildUserPrompt`/`collectAssetHints`/`sanitizeCopy`/`buildTemplateVoiceover`）保持不变。

**3a. 文件顶部 import**（移除 script-match、SceneRole、ScriptScene；加入 scene-derive 与 ScriptSegment）：

```ts
import { createId, nowIso } from "@/lib/ids";
import { hasAI, chatCompletionJSON, sanitizePromptField } from "@/lib/services/ai-client";
import {
  deriveScenesFromSegments,
  deriveSegmentsFromVoiceover,
  filterActiveHighlights,
} from "@/lib/services/scene-derive";
import type { AssetAnalysis, MarketingPurpose, Platform, ScriptDraft, ScriptSegment, StoreProfile } from "@/lib/types";
```

**3b. `TemplateDraftInput` 移除 assetAnalyses**（模板路径不再用素材匹配）：

```ts
interface TemplateDraftInput {
  store: StoreProfile;
  purpose: MarketingPurpose;
  reason: string;
  /** 目标时长（秒）：30 / 45 / 60，影响模板文案量。 */
  targetDurationSec?: number;
}
```

**3c. `AIScriptResponse` 换契约**（voiceover 为中心；scenes/captions 移出 AI 契约）：

```ts
interface AIScriptResponse {
  title: string;
  hook: string;
  voiceover: string;
  /** 口播稿中需标黄的关键词原文（产品名/价格/活动/CTA）。 */
  highlights?: string[];
  /** 适合真人出镜的口播句原文（开场/CTA 优先）。 */
  onCameraSentences?: string[];
  cta: string;
}
```

**3d. SYSTEM_PROMPT / SCHEMA_DESCRIPTION / durationGuidance 替换**：

```ts
const SYSTEM_PROMPT = `你是为本地实体店创作短视频口播稿的营销文案专家。
你的文案必须口语化、有网感、适合短视频配音。口播稿总长度按用户给的【目标时长】控制（中文配音约每秒4.5字）。

要求：
- 开头3秒内抓住注意力（hook）
- 突出产品卖点和门店特色
- 语言自然不僵硬，像真人说话
- 结尾有明确的行动号召（CTA）
- 每句控制在8-15个字，方便朗读，句与句之间用中文句号分隔
- highlights：从口播稿中挑出需要字幕标黄的关键词（产品名/价格/活动/CTA），必须逐字摘自你写好的口播稿
- onCameraSentences：从口播稿中挑出适合真人出镜的句子（开场与结尾 CTA 优先），必须逐字摘自你写好的口播稿

你会收到门店信息、素材分析结果、营销目的和发布平台，请根据这些信息创作口播稿。`;

const SCHEMA_DESCRIPTION = `{
  "title": "视频标题（10字以内）",
  "hook": "开头吸引句（15字以内）",
  "voiceover": "完整口播文案（按目标时长控制总字数）",
  "highlights": ["口播稿中需标黄的关键词原文"],
  "onCameraSentences": ["适合真人出镜的口播句原文"],
  "cta": "行动号召文案"
}`;
```

```ts
function durationGuidance(target?: number): string {
  if (target === 45) return "约45秒，口播全文约190-210字";
  if (target === 60) return "约60秒，口播全文约260-280字";
  return "约30秒，口播全文约130-150字";
}
```

**3e. `createScriptDraft` forcedRawCopy 分支替换**：

```ts
  // 1. Forced raw copy bypasses AI
  if (input.forcedRawCopy) {
    const cleaned = sanitizeCopy(input.forcedRawCopy, input.store.forbiddenWords);
    return buildDraft({
      store: input.store,
      purpose: input.purpose,
      platform: input.platform ?? "douyin",
      generationMode: "ai",
      title: `${input.store.name}本期推荐`,
      hook: cleaned.copy,
      voiceover: cleaned.copy,
      highlights: storeFieldHighlights(input.store, cleaned.copy),
      segments: deriveSegmentsFromVoiceover(cleaned.copy),
      cta: purposeCta[input.purpose],
      warnings: cleaned.warnings,
      targetDurationSec: input.targetDurationSec,
    });
  }
```

**3f. `createScriptDraftWithAI` 整体替换**：

```ts
export async function createScriptDraftWithAI(
  input: ScriptDraftInput,
): Promise<ScriptDraft> {
  const userPrompt = buildUserPrompt(input);
  const aiResponse = await chatCompletionJSON<AIScriptResponse>(
    SYSTEM_PROMPT,
    userPrompt,
    { schemaDescription: SCHEMA_DESCRIPTION, temperature: 0.8, maxTokens: 1500 },
  );

  if (!aiResponse) {
    throw new Error("AI returned empty response");
  }

  const voiceover = sanitizeCopy(
    aiResponse.voiceover || `${input.store.name}欢迎你`,
    input.store.forbiddenWords,
  );
  warnIfVoiceoverOffTarget(voiceover.copy, input.targetDurationSec);

  // 标黄词必须逐字出现在最终口播稿中（用户改稿后同理），否则渲染端无法命中。
  const highlights = filterActiveHighlights(
    (Array.isArray(aiResponse.highlights) ? aiResponse.highlights : []).map((h) =>
      String(h).slice(0, 20),
    ),
    voiceover.copy,
  ).slice(0, 10);
  const segments = deriveSegmentsFromVoiceover(voiceover.copy, {
    onCameraTexts: Array.isArray(aiResponse.onCameraSentences)
      ? aiResponse.onCameraSentences.map(String)
      : [],
  });

  return buildDraft({
    store: input.store,
    purpose: input.purpose,
    platform: input.platform ?? "douyin",
    generationMode: "ai",
    title: String(aiResponse.title || `${input.store.name}推荐`).slice(0, 30),
    hook: String(aiResponse.hook || voiceover.copy.slice(0, 15)),
    voiceover: voiceover.copy,
    highlights,
    segments,
    cta: String(aiResponse.cta || purposeCta[input.purpose]),
    warnings: voiceover.warnings,
    targetDurationSec: input.targetDurationSec,
  });
}
```

**3g. `createTemplateScriptDraft` 整体替换**：

```ts
export function createTemplateScriptDraft(input: TemplateDraftInput): ScriptDraft {
  const warnings = [`AI unavailable, used template fallback: ${input.reason}`];
  const voiceover = buildTemplateVoiceover(input.store, input.purpose, input.targetDurationSec);
  const cleaned = sanitizeCopy(voiceover, input.store.forbiddenWords);
  const primaryProduct = input.store.mainProducts[0] ?? "招牌产品";

  return buildDraft({
    store: input.store,
    purpose: input.purpose,
    platform: "douyin",
    generationMode: "template_fallback",
    title: `${input.store.name}｜${primaryProduct}到店推荐`,
    hook: `今天推荐${input.store.name}的${primaryProduct}`,
    voiceover: cleaned.copy,
    highlights: storeFieldHighlights(input.store, cleaned.copy),
    segments: deriveSegmentsFromVoiceover(cleaned.copy),
    cta: purposeCta[input.purpose],
    warnings: [...warnings, ...cleaned.warnings],
    targetDurationSec: input.targetDurationSec,
  });
}
```

**3h. `buildDraft` 整体替换**（scenes 派生、captions=[voiceover]、不再跑素材匹配），并新增 `storeFieldHighlights`：

```ts
function buildDraft(input: {
  store: StoreProfile;
  purpose: MarketingPurpose;
  platform: Platform;
  generationMode: "ai" | "template_fallback";
  title: string;
  hook: string;
  voiceover: string;
  highlights: string[];
  segments: ScriptSegment[];
  cta: string;
  warnings: string[];
  targetDurationSec?: number;
}): ScriptDraft {
  return {
    id: createId("script"),
    ownerId: input.store.ownerId,
    storeId: input.store.id,
    purpose: input.purpose,
    platform: input.platform,
    title: input.title,
    hook: input.hook,
    scenes: deriveScenesFromSegments(input.segments),
    voiceover: input.voiceover,
    highlights: input.highlights,
    segments: input.segments,
    captions: [input.voiceover],
    cta: input.cta,
    generationMode: input.generationMode,
    complianceWarnings: input.warnings,
    ...(input.targetDurationSec ? { targetDurationSec: input.targetDurationSec } : {}),
    createdAt: nowIso(),
  };
}

/** 模板/强制文案路径的标黄词：门店真实字段（产品/活动/卖点）命中口播稿的部分。 */
function storeFieldHighlights(store: StoreProfile, voiceover: string): string[] {
  return filterActiveHighlights(
    [...store.mainProducts, ...(store.promotions ?? []), ...store.sellingPoints],
    voiceover,
  );
}
```

**3i. `warnIfDurationOffTarget` 替换为 `warnIfVoiceoverOffTarget`**：

```ts
/** AI 口播字数偏离目标档位（约 4.5 字/秒）>50% 时打警告日志（不重试，仅观测）。 */
export function warnIfVoiceoverOffTarget(voiceover: string, targetDurationSec?: number): void {
  if (!targetDurationSec) return;
  const chars = Array.from(voiceover).length;
  const expected = targetDurationSec * 4.5;
  if (Math.abs(chars - expected) > expected * 0.5) {
    console.warn(
      `[script-engine] voiceover ${chars} chars deviates >50% from target ${targetDurationSec}s (~${Math.round(expected)} chars)`,
    );
  }
}
```

**3j. 删除**：`buildTemplateScenes` 函数、旧的 `warnIfDurationOffTarget` 函数。同时删除文件：

```bash
git rm lib/services/script-match.ts tests/script-match.test.ts
```

验证无其他引用：Run: `grep -rn "script-match\|matchAssetsToScenes" lib app worker components tests --include="*.ts" --include="*.tsx"`
Expected: 无输出（script-engine.ts 已清理）

- [ ] **Step 4: 适配 `app/api/script-drafts/route.ts` 调用点**

`createTemplateScriptDraft` 调用移除 `assetAnalyses` 字段（第 44-51 行附近）：

```ts
  const script = body.forceTemplate
    ? createTemplateScriptDraft({
        store,
        purpose,
        reason: "manual_template_mode",
        targetDurationSec: durationSlot(body.targetDurationSec),
      })
    : await createScriptDraft({
        store,
        assetAnalyses,
        purpose,
        platform: (body.platform ?? "douyin") as Platform,
        targetDurationSec: durationSlot(body.targetDurationSec),
      });
```

- [ ] **Step 5: 跑测试确认通过 + 类型检查**

Run: `npx vitest run tests/script-engine.test.ts tests/scene-derive.test.ts`
Expected: 全部 PASS

Run: `npm run typecheck`
Expected: 无错误（`splitVoiceoverSentences`/`buildCaptionCues` 保留在 video-compose.ts 不动）

Run: `npx vitest run tests/api/error-handling.test.ts tests/api/json-body-validation.test.ts`
Expected: PASS（forceTemplate POST 走新签名仍 201）

- [ ] **Step 6: Commit**

```bash
git add lib/services/script-engine.ts app/api/script-drafts/route.ts tests/script-engine.test.ts
git commit -m "feat(script): voiceover-centric engine — AI highlights + derived segments/scenes"
```

---

### Task 4: PATCH `/api/script-drafts/[id]`——voiceover 全文编辑

**Files:**
- Modify: `app/api/script-drafts/[id]/route.ts`（整文件重写）
- Test: `tests/api/script-drafts-id.test.ts`（整文件重写）

- [ ] **Step 1: 重写失败测试 `tests/api/script-drafts-id.test.ts`（整文件替换）**

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PATCH } from "@/app/api/script-drafts/[id]/route";
import * as repositories from "@/lib/repositories";
import { MemoryScriptRepository } from "@/lib/repositories/memory";
import { resetRuntimeStateForTests } from "@/lib/runtime-store";
import type { ScriptDraft } from "@/lib/types";

function draftRow(id: string, ownerId: string): ScriptDraft {
  return {
    id, ownerId, storeId: "store_1", purpose: "store_traffic", platform: "douyin",
    title: "t", hook: "h",
    scenes: [{ order: 1, text: "旧镜", durationSeconds: 4, assetHints: [], role: "presenter" }],
    voiceover: "开场介绍产品词。结尾欢迎光临。",
    highlights: ["产品词", "已删词"],
    segments: [
      { index: 0, text: "开场介绍产品词。", speakerIndex: 0, onCamera: true },
      { index: 1, text: "结尾欢迎光临。", speakerIndex: 0, onCamera: false },
    ],
    captions: [], cta: "c", generationMode: "ai", complianceWarnings: [],
    createdAt: "2026-08-19T00:00:00.000Z",
  };
}

function req(body: unknown, id: string): [Request, { params: Promise<{ id: string }> }] {
  return [
    new Request(`http://localhost/api/script-drafts/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  ];
}

describe("PATCH /api/script-drafts/[id] (voiceover-centric)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetRuntimeStateForTests();
    vi.spyOn(repositories, "getScriptRepository").mockImplementation(() => new MemoryScriptRepository());
  });

  it("rewrites voiceover, re-derives segments/scenes and drops stale highlights", async () => {
    const scripts = new MemoryScriptRepository();
    await scripts.create(draftRow("script_patch", "demo_user"));

    const [request, ctx] = req({ voiceover: "全新的开场。全新的收尾。" }, "script_patch");
    const res = await PATCH(request, ctx);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.script.voiceover).toBe("全新的开场。全新的收尾。");
    expect(json.script.segments.map((s: { text: string }) => s.text)).toEqual([
      "全新的开场。", "全新的收尾。",
    ]);
    expect(
      json.script.segments.every((s: { speakerIndex: number }) => s.speakerIndex === 0),
    ).toBe(true);
    // 旧标黄词均不在新稿 → 全部失效
    expect(json.script.highlights).toEqual([]);
    // scenes 重派生：首/末句 presenter
    expect(json.script.scenes).toHaveLength(2);
    expect(json.script.scenes[0].text).toBe("全新的开场。");
    expect(json.script.scenes[0].role).toBe("presenter");
  });

  it("keeps highlights still present and inherits onCamera for unchanged sentences", async () => {
    const scripts = new MemoryScriptRepository();
    await scripts.create(draftRow("script_patch", "demo_user"));

    const [request, ctx] = req(
      { voiceover: "开场介绍产品词。全新中段。全新收尾。" },
      "script_patch",
    );
    const res = await PATCH(request, ctx);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.script.highlights).toEqual(["产品词"]);
    expect(json.script.segments.map((s: { onCamera: boolean }) => s.onCamera)).toEqual([
      true, false, true,
    ]);
  });

  it("returns 400 when voiceover is missing or empty", async () => {
    const scripts = new MemoryScriptRepository();
    await scripts.create(draftRow("script_patch", "demo_user"));
    for (const body of [{}, { voiceover: "   " }, { voiceover: 42 }]) {
      const [request, ctx] = req(body, "script_patch");
      const res = await PATCH(request, ctx);
      expect(res.status).toBe(400);
    }
  });

  it("returns 404 for a draft owned by someone else (no existence leak)", async () => {
    const scripts = new MemoryScriptRepository();
    await scripts.create(draftRow("script_other", "user_other"));
    const [request, ctx] = req({ voiceover: "x" }, "script_other");
    const res = await PATCH(request, ctx);
    expect(res.status).toBe(404);
  });

  it("returns 400 when body is not valid JSON", async () => {
    const request = new Request("http://localhost/api/script-drafts/script_patch", {
      method: "PATCH",
      body: "not json",
    });
    const ctx = { params: Promise.resolve({ id: "script_patch" }) };
    const res = await PATCH(request, ctx);
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/api/script-drafts-id.test.ts`
Expected: FAIL（现 PATCH 要求 `scenes` 数组，voiceover body 返回 400）

- [ ] **Step 3: 重写 `app/api/script-drafts/[id]/route.ts`（整文件替换）**

```ts
import { jsonError, jsonOk } from "@/lib/api-response";
import { applyRateLimit } from "@/lib/rate-limit";
import { getOwnerId } from "@/lib/auth-helpers";
import { getScriptRepository } from "@/lib/repositories";
import {
  deriveScenesFromSegments,
  deriveSegmentsFromVoiceover,
  filterActiveHighlights,
} from "@/lib/services/scene-derive";

const MAX_VOICEOVER_CHARS = 2000;

/**
 * 编辑口播稿全文（Phase 2：编辑对象从逐镜 scene.text 改为 voiceover）。
 * 保存后服务端重切 segments（未改句继承 onCamera）、过滤失效标黄词、
 * 重新派生渲染用 scenes。IDOR：他人或不存在的 draft 一律 404，不泄漏存在性。
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return jsonError("Request body must be valid JSON", 400);
  }

  const ownerId = await getOwnerId();
  const limited = await applyRateLimit(request, ownerId);
  if (limited) return limited;

  const draft = await getScriptRepository().findById(id);
  if (!draft || draft.ownerId !== ownerId) {
    return jsonError("Script draft not found", 404);
  }

  const voiceover = typeof body.voiceover === "string" ? body.voiceover.trim() : "";
  if (!voiceover) {
    return jsonError("voiceover is required", 400);
  }
  if (Array.from(voiceover).length > MAX_VOICEOVER_CHARS) {
    return jsonError(`voiceover must be at most ${MAX_VOICEOVER_CHARS} characters`, 400);
  }

  const segments = deriveSegmentsFromVoiceover(voiceover, { prev: draft.segments });
  const highlights = filterActiveHighlights(draft.highlights ?? [], voiceover);
  const scenes = deriveScenesFromSegments(segments);

  const updated = await getScriptRepository().update(id, { voiceover, segments, highlights, scenes });
  return jsonOk({ script: updated });
}
```

注意：`getAssetRepository` import 随之移除（matchedAssetId 属主校验随旧契约退场）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/api/script-drafts-id.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add app/api/script-drafts/[id]/route.ts tests/api/script-drafts-id.test.ts
git commit -m "feat(api): PATCH script-drafts edits full voiceover, re-derives segments/scenes/highlights"
```

---

### Task 5: POST `/api/render-projects`——`avatarProfileIds[]` + avatar 属主校验

**Files:**
- Modify: `app/api/render-projects/route.ts:58-80`
- Test: `tests/api/render-projects.test.ts`（追加用例）

- [ ] **Step 1: 写失败测试（追加到 `tests/api/render-projects.test.ts` 的 describe 内）**

文件已有 `createTestStore`/`createTestScript` helper 与 legacy `avatarProfileId` 用例。追加：

```ts
  it("accepts avatarProfileIds (single) and plans the avatar pipeline", async () => {
    const store = createTestStore();
    await getStoreRepository().upsert(store);
    const script = createTestScript(store.id);
    await getScriptRepository().create(script);

    const avatar: AvatarProfile = {
      id: createId("avatar"),
      ownerId: "demo_user",
      storeId: store.id,
      provider: "heygen",
      providerAvatarId: "ext_avatar_1",
      providerVoiceId: "ext_voice_1",
      consentAcceptedAt: nowIso(),
      trainingStatus: "ready",
      fallbackMode: "tts_voiceover",
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    await getAvatarRepository().create(avatar);

    const req = new Request("http://localhost/api/render-projects", {
      method: "POST",
      body: JSON.stringify({
        scriptDraftId: script.id,
        selectedAssetIds: [],
        avatarProfileIds: [avatar.id],
        aspectRatio: "9:16",
        subtitleStyle: "bold_bottom"
      })
    });

    const res = await POST(req);
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.project.avatarProfileId).toBe(avatar.id);
    const jobTypes = body.jobs.map((j: { type: string }) => j.type);
    expect(jobTypes).toContain("avatar_generation");
    expect(jobTypes).toContain("video_render");
  });

  it("returns 400 when avatarProfileIds has more than one entry (single-avatar phase)", async () => {
    const store = createTestStore();
    await getStoreRepository().upsert(store);
    const script = createTestScript(store.id);
    await getScriptRepository().create(script);

    const req = new Request("http://localhost/api/render-projects", {
      method: "POST",
      body: JSON.stringify({
        scriptDraftId: script.id,
        selectedAssetIds: [],
        avatarProfileIds: ["avatar_a", "avatar_b"]
      })
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 404 when the avatar belongs to another owner (IDOR guard)", async () => {
    const store = createTestStore();
    await getStoreRepository().upsert(store);
    const script = createTestScript(store.id);
    await getScriptRepository().create(script);

    const foreign: AvatarProfile = {
      id: createId("avatar"),
      ownerId: "user_other",
      storeId: store.id,
      provider: "heygen",
      providerAvatarId: "ext_avatar_x",
      providerVoiceId: "ext_voice_x",
      consentAcceptedAt: nowIso(),
      trainingStatus: "ready",
      fallbackMode: "tts_voiceover",
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    await getAvatarRepository().create(foreign);

    const req = new Request("http://localhost/api/render-projects", {
      method: "POST",
      body: JSON.stringify({
        scriptDraftId: script.id,
        selectedAssetIds: [],
        avatarProfileIds: [foreign.id]
      })
    });

    const res = await POST(req);
    expect(res.status).toBe(404);
  });

  it("returns 404 when the avatar does not exist", async () => {
    const store = createTestStore();
    await getStoreRepository().upsert(store);
    const script = createTestScript(store.id);
    await getScriptRepository().create(script);

    const req = new Request("http://localhost/api/render-projects", {
      method: "POST",
      body: JSON.stringify({
        scriptDraftId: script.id,
        selectedAssetIds: [],
        avatarProfileIds: ["avatar_missing"]
      })
    });

    const res = await POST(req);
    expect(res.status).toBe(404);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/api/render-projects.test.ts`
Expected: FAIL（avatarProfileIds 被忽略 → project.avatarProfileId undefined；>1 不报错；foreign 不 404）

注意：legacy `avatarProfileId` 用例必须继续通过（向后兼容）。

- [ ] **Step 3: 修改 `app/api/render-projects/route.ts`**

将现有的 avatar 解析（第 68-70 行，`const avatarProfile = body.avatarProfileId ? ... : undefined;`）替换为以下块，并把整块**移动到 `consumeQuota` 之前**（无效请求不消耗配额）。即：scriptDraft IDOR 检查（第 53-56 行）之后、quota 之前插入：

```ts
  // Phase 2：avatarProfileIds[]（本期单选，长度 ≤1）；legacy avatarProfileId 兼容。
  const avatarIds = Array.isArray(body.avatarProfileIds)
    ? (body.avatarProfileIds as unknown[]).filter((x): x is string => typeof x === "string")
    : undefined;
  if (avatarIds && avatarIds.length > 1) {
    return jsonError("avatarProfileIds supports a single avatar in this phase", 400);
  }
  const avatarProfileId = avatarIds?.[0] ?? (body.avatarProfileId as string | undefined);
  const avatarProfile = avatarProfileId
    ? ((await getAvatarRepository().findById(avatarProfileId)) ?? undefined)
    : undefined;
  // IDOR guard：foreign/不存在一律 404，不泄漏存在性（调整前为静默降级 asset_only）。
  if (avatarProfileId && (!avatarProfile || avatarProfile.ownerId !== ownerId)) {
    return jsonError("Avatar profile not found", 404);
  }
```

quota 块保持原样位于其后；删除原来的第 68-70 行 avatar 解析（已被上面替代）。`createRenderProject({ ..., avatarProfile, ... })` 调用不变。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/api/render-projects.test.ts`
Expected: 全部 PASS（含 legacy avatarProfileId 用例）

- [ ] **Step 5: Commit**

```bash
git add app/api/render-projects/route.ts tests/api/render-projects.test.ts
git commit -m "feat(api): render-projects accepts avatarProfileIds[] (single) + avatar owner guard"
```

---

### Task 6: 字幕标黄——`buildAss` highlights + worker 接线

**Files:**
- Modify: `lib/services/video-compose.ts`（`buildAss` 加参数 + `wrapHighlightsInAss` 导出）
- Modify: `worker/processors/video-render.ts:162`
- Test: `tests/video-compose.test.ts`（追加 describe）
- Test: `tests/video-render-processor-captions.test.ts`（追加用例）

背景：ASS 覆盖标签 `{<反斜杠>c&H00FFFF&}` 把后续文字染黄；染黄后必须 reset 回预设主色（如 default 预设的 `&H00FFFFFF`），否则整行后续文字都会变黄。reset 色取自当前 preset 的 `primaryColour`——这就是包裹逻辑放在 `buildAss` 而非 `buildCaptionCues` 的原因（设计决策 §1）。

- [ ] **Step 1: 写失败测试（追加到 `tests/video-compose.test.ts` 末尾）**

文件已 import `buildAss`（合并进既有 import 行即可）：

```ts
describe("buildAss highlights (Phase 2)", () => {
  it("wraps active highlight words in yellow ASS override and resets to preset color", () => {
    const ass = buildAss(
      [{ startSec: 0, endSec: 2, text: "牛肉面今天半价" }],
      "default",
      ["牛肉面"],
    );
    expect(ass).toContain("{\\c&H00FFFF&}牛肉面{\\c&H00FFFFFF&}");
  });

  it("ignores highlights not present in the cue text", () => {
    const ass = buildAss([{ startSec: 0, endSec: 2, text: "普通一句话" }], "default", ["不存在"]);
    expect(ass).not.toContain("\\c&H00FFFF&");
  });

  it("resets to the preset primary colour (bold_bottom is itself yellowish)", () => {
    const ass = buildAss(
      [{ startSec: 0, endSec: 2, text: "第二份半价" }],
      "bold_bottom",
      ["半价"],
    );
    expect(ass).toContain("{\\c&H00FFFF&}半价{\\c&H0000F4FF&}");
  });

  it("wraps every occurrence and prefers longer words on overlap", () => {
    const out = wrapHighlightsInAss("牛肉面配牛肉汤", ["牛肉", "牛肉面"], "&H00FFFFFF");
    expect(out).toBe(
      "{\\c&H00FFFF&}牛肉面{\\c&H00FFFFFF&}配{\\c&H00FFFF&}牛肉{\\c&H00FFFFFF&}汤",
    );
  });

  it("omitting highlights keeps cue text untouched", () => {
    const ass = buildAss([{ startSec: 0, endSec: 2, text: "没有标黄" }], "default");
    expect(ass).toContain("没有标黄");
    expect(ass).not.toContain("\\c&H00FFFF&");
  });
});
```

注意：`wrapHighlightsInAss` 需加入 import：`import { ..., buildAss, wrapHighlightsInAss } from "@/lib/services/video-compose";`

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/video-compose.test.ts`
Expected: FAIL（`wrapHighlightsInAss` 未导出；`buildAss` 第三参数不存在 → TS 错误）

- [ ] **Step 3: 修改 `lib/services/video-compose.ts`**

**3a. 文件顶部加 import**：

```ts
import { findHighlightRanges } from "@/lib/highlight-ranges";
```

**3b. 在 `buildAss` 之前新增 `wrapHighlightsInAss`**：

```ts
/**
 * 标黄包裹：命中词前插 {\c&H00FFFF&}（黄），词后 reset 回预设主色。
 * 命中区间由 findHighlightRanges 提供（长词优先、跳过重叠）。
 */
export function wrapHighlightsInAss(text: string, highlights: string[], resetColor: string): string {
  const ranges = findHighlightRanges(text, highlights);
  if (ranges.length === 0) return text;
  let out = "";
  let cursor = 0;
  for (const [s, e] of ranges) {
    out += text.slice(cursor, s);
    out += `{\\c&H00FFFF&}${text.slice(s, e)}{\\c${resetColor}&}`;
    cursor = e;
  }
  return out + text.slice(cursor);
}
```

**3c. `buildAss` 加第三参数**（签名与 Dialogue 行生成两处改动）：

```ts
export function buildAss(
  cues: Array<{ startSec: number; endSec: number; text: string }>,
  preset: SubtitleStylePreset,
  highlights?: string[],
): string {
  const s = SUBTITLE_PRESETS[preset] ?? SUBTITLE_PRESETS.default;
  // ...header 部分不变...
  const dialogues = cues
    .filter((cue) => cue.text.length > 0)
    .map((cue) => {
      const text = highlights?.length
        ? wrapHighlightsInAss(cue.text, highlights, s.primaryColour)
        : cue.text;
      return `Dialogue: 0,${assTimestamp(cue.startSec)},${assTimestamp(cue.endSec)},Default,,0,0,0,,${text}`;
    });
  return [...header, ...dialogues].join("\n");
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/video-compose.test.ts`
Expected: 全部 PASS（既有 buildAss/buildTimeline 用例不受影响——第三参数 optional）

- [ ] **Step 5: worker 接线 + 处理器测试**

先写失败测试——追加到 `tests/video-render-processor-captions.test.ts` 的 describe 内：

```ts
  it("burns yellow ASS overrides for the draft's active highlights", async () => {
    const captured: { input?: RenderCompositeInput } = {};
    const hlDraft: ScriptDraft = { ...draft, highlights: ["冰美式", "稿外词"] };
    const deps = makeDeps(captured);
    deps.scriptRepository = {
      findById: async () => hlDraft,
    } as unknown as VideoRenderDeps["scriptRepository"];
    await processVideoRender(fakeJob, deps);
    const ass = captured.input?.assContent ?? "";
    expect(ass).toContain("{\\c&H00FFFF&}冰美式{\\c&H00FFFFFF&}");
    // 不出现在口播稿中的词不会被包裹（也不会凭空出现）
    expect(ass).not.toContain("稿外词");
  });
```

Run: `npx vitest run tests/video-render-processor-captions.test.ts`
Expected: FAIL（assContent 不含标黄标签）

修改 `worker/processors/video-render.ts`（第 162 行附近）：

```ts
    assContent: buildAss(captionCues, resolveSubtitlePreset(project.subtitleStyle), draft.highlights),
```

再跑：Run: `npx vitest run tests/video-render-processor-captions.test.ts`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add lib/services/video-compose.ts worker/processors/video-render.ts tests/video-compose.test.ts tests/video-render-processor-captions.test.ts
git commit -m "feat(render): burn yellow ASS overrides for draft highlights into subtitles"
```

---

### Task 7: api-client 契约更新

**Files:**
- Modify: `lib/api-client.ts:235-277`

无独立测试文件——由 Task 8/9 的组件与 dashboard 集成测试经 fetch mock 间接覆盖。

- [ ] **Step 1: 验证 updateScriptDraftApi 唯一调用方**

Run: `grep -rn "updateScriptDraftApi" components lib app tests --include="*.ts" --include="*.tsx"`
Expected: 仅 `lib/api-client.ts`（定义）与 `components/dashboard.tsx`（调用，Task 9 改造）

- [ ] **Step 2: 修改 `lib/api-client.ts`**

`createRenderProjectApi` 加 `avatarProfileIds`（替换第 235-247 行）：

```ts
export async function createRenderProjectApi(input: {
  scriptDraftId: string;
  selectedAssetIds: string[];
  /** Phase 2：形象选择（本期单选，长度 ≤1；空/缺省 = 不用数字人）。 */
  avatarProfileIds?: string[];
  aspectRatio?: string;
  subtitleStyle?: string;
  bgmTrackId?: string;
}) {
  return api<{ project: unknown; jobs: Job[] }>("/api/render-projects", {
    method: "POST",
    body: JSON.stringify(input)
  });
}
```

`updateScriptDraftApi` 改 voiceover 契约（替换第 268-277 行）：

```ts
export async function updateScriptDraftApi(input: {
  scriptDraftId: string;
  voiceover: string;
}): Promise<ScriptDraft> {
  const data = await api<{ script: ScriptDraft }>(
    `/api/script-drafts/${encodeURIComponent(input.scriptDraftId)}`,
    { method: "PATCH", body: JSON.stringify({ voiceover: input.voiceover }) },
  );
  return data.script;
}
```

- [ ] **Step 3: 类型检查（dashboard 旧调用此时会报错——Task 9 修复，本步只确认 api-client 自身无误）**

Run: `npx tsc --noEmit lib/api-client.ts 2>&1 | head -5`（或直接跳到 Task 9 后统一 `npm run typecheck`）
Expected: api-client.ts 自身无错；dashboard.tsx 的 `patchStoryboard` 报错属预期，Task 9 消除。

- [ ] **Step 4: Commit**

```bash
git add lib/api-client.ts
git commit -m "feat(api-client): voiceover PATCH contract + avatarProfileIds on render-projects"
```

---

### Task 8: `components/script-confirm.tsx`——口播确认卡片

**Files:**
- Create: `components/script-confirm.tsx`
- Delete: 无（StoryboardConfirm 在 Task 9 随 dashboard 切换一并删除）
- Test: `tests/script-confirm.test.tsx`（新建）

- [ ] **Step 1: 写失败测试 `tests/script-confirm.test.tsx`**

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ScriptConfirm } from "@/components/script-confirm";
import type { AvatarProfile, ScriptDraft } from "@/lib/types";

const draft: ScriptDraft = {
  id: "script_1", ownerId: "u", storeId: "s", purpose: "store_traffic", platform: "douyin",
  title: "t", hook: "h",
  scenes: [],
  voiceover: "阿姨手作面馆今天主推牛肉面，现熬牛骨汤。现在到店，直接报视频里的活动。",
  highlights: ["牛肉面", "现熬牛骨汤"],
  segments: [
    { index: 0, text: "阿姨手作面馆今天主推牛肉面，现熬牛骨汤。", speakerIndex: 0, onCamera: true },
    { index: 1, text: "现在到店，直接报视频里的活动。", speakerIndex: 0, onCamera: true },
  ],
  captions: [], cta: "c", generationMode: "ai", complianceWarnings: [],
  createdAt: "2026-08-19T00:00:00.000Z",
};

const avatars: AvatarProfile[] = [
  {
    id: "avatar_ready", ownerId: "u", storeId: "s", provider: "heygen",
    providerAvatarId: "x", consentAcceptedAt: "2026-08-01T00:00:00.000Z",
    trainingStatus: "ready", fallbackMode: "tts_voiceover",
    createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
  },
  {
    id: "avatar_training", ownerId: "u", storeId: "s", provider: "heygen",
    consentAcceptedAt: "2026-08-01T00:00:00.000Z",
    trainingStatus: "processing", fallbackMode: "tts_voiceover",
    createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
  },
];

const bgmTracks = [{ id: "bgm_upbeat_01", name: "欢快01", category: "general" }];

function renderConfirm(overrides: Partial<Parameters<typeof ScriptConfirm>[0]> = {}) {
  const onConfirm = vi.fn(async () => {});
  render(
    <ScriptConfirm
      draft={draft}
      avatars={avatars}
      bgmTracks={bgmTracks}
      librarySelectedAssetIds={["asset_a", "asset_b"]}
      onConfirm={onConfirm}
      pending={false}
      {...overrides}
    />,
  );
  return { onConfirm };
}

describe("ScriptConfirm", () => {
  it("renders the voiceover preview with active highlights marked yellow", () => {
    renderConfirm();
    expect(screen.getByText("牛肉面", { selector: "mark" })).toBeInTheDocument();
    expect(screen.getByText("现熬牛骨汤", { selector: "mark" })).toBeInTheDocument();
    // 编辑器里是完整口播稿
    expect(screen.getByLabelText("口播稿编辑")).toHaveValue(draft.voiceover);
  });

  it("defaults to the first ready avatar and confirms with the full library selection", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderConfirm();
    await user.click(screen.getByRole("button", { name: /确认生成/ }));
    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith({
        voiceover: draft.voiceover,
        selectedAssetIds: ["asset_a", "asset_b"],
        avatarProfileIds: ["avatar_ready"],
        subtitleStyle: "bold_bottom",
        bgmTrackId: "bgm_upbeat_01",
      });
    });
  });

  it("non-ready avatars are disabled; 不用数字人 confirms with empty avatarProfileIds", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderConfirm();
    expect(screen.getByLabelText(/AI 形象 2/)).toBeDisabled();
    await user.click(screen.getByLabelText(/不用数字人/));
    await user.click(screen.getByRole("button", { name: /确认生成/ }));
    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith(
        expect.objectContaining({ avatarProfileIds: [] }),
      );
    });
  });

  it("editing the voiceover drops stale highlight marks and confirms the edited text", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderConfirm();
    const editor = screen.getByLabelText("口播稿编辑");
    await user.clear(editor);
    await user.type(editor, "今天全场半价，欢迎光临。");
    // “牛肉面/现熬牛骨汤” 已不在稿中 → 预览无标黄
    expect(screen.queryByText("牛肉面", { selector: "mark" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /确认生成/ }));
    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith(
        expect.objectContaining({ voiceover: "今天全场半价，欢迎光临。" }),
      );
    });
  });

  it("offers a 无音乐 option that confirms with empty bgmTrackId", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderConfirm();
    await user.selectOptions(screen.getByLabelText(/背景音乐/), "");
    await user.click(screen.getByRole("button", { name: /确认生成/ }));
    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ bgmTrackId: "" }));
    });
  });

  it("disables confirm when the voiceover is empty", async () => {
    const user = userEvent.setup();
    renderConfirm();
    const editor = screen.getByLabelText("口播稿编辑");
    await user.clear(editor);
    expect(screen.getByRole("button", { name: /确认生成/ })).toBeDisabled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/script-confirm.test.tsx`
Expected: FAIL（`@/components/script-confirm` 不存在）

- [ ] **Step 3: 实现 `components/script-confirm.tsx`**

```tsx
"use client";

import { useMemo, useState } from "react";
import { findHighlightRanges } from "@/lib/highlight-ranges";
import type { AvatarProfile, ScriptDraft } from "@/lib/types";

const SUBTITLE_OPTIONS = [
  { value: "bold_bottom", label: "综艺黄（粗体底部）" },
  { value: "default", label: "标准白字" },
  { value: "minimal", label: "极简小字" },
];

/** 中文口播语速假设（与 scene-derive 一致），仅用于预估时长提示。 */
const CHARS_PER_SECOND = 4.5;

export interface ScriptConfirmSelection {
  voiceover: string;
  selectedAssetIds: string[];
  avatarProfileIds: string[];
  subtitleStyle: string;
  bgmTrackId: string;
}

interface Props {
  draft: ScriptDraft;
  avatars: AvatarProfile[];
  bgmTracks: { id: string; name: string; category: string }[];
  /** 素材库完整勾选集合（未匹配的素材也必须进入渲染，B2 修复语义不变）。 */
  librarySelectedAssetIds: string[];
  onConfirm: (selection: ScriptConfirmSelection) => Promise<void>;
  pending: boolean;
}

/** 把口播稿按命中关键词切为 text/mark 片段（区间来自共享的 findHighlightRanges）。 */
function highlightParts(text: string, words: string[]): Array<{ text: string; hit: boolean }> {
  const ranges = findHighlightRanges(text, words);
  if (ranges.length === 0) return [{ text, hit: false }];
  const parts: Array<{ text: string; hit: boolean }> = [];
  let cursor = 0;
  for (const [s, e] of ranges) {
    if (s > cursor) parts.push({ text: text.slice(cursor, s), hit: false });
    parts.push({ text: text.slice(s, e), hit: true });
    cursor = e;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), hit: false });
  return parts;
}

/**
 * 口播确认卡片（Phase 2 去分镜）：标黄高亮预览 + 整稿编辑 + 形象单选 +
 * 字幕样式 + BGM（自 StoryboardConfirm 挪入）→ 确认生成。
 */
export function ScriptConfirm({ draft, avatars, bgmTracks, librarySelectedAssetIds, onConfirm, pending }: Props) {
  const [voiceover, setVoiceover] = useState(draft.voiceover);
  const [avatarId, setAvatarId] = useState(
    () => avatars.find((a) => a.trainingStatus === "ready")?.id ?? "",
  );
  const [subtitleStyle, setSubtitleStyle] = useState("bold_bottom");
  const [bgmTrackId, setBgmTrackId] = useState(bgmTracks[0]?.id ?? "");

  // 标黄词随编辑实时失效（spec §5.1：文中不存在的词渲染时自动失效）
  const parts = useMemo(
    () => highlightParts(voiceover, draft.highlights ?? []),
    [voiceover, draft.highlights],
  );
  const charCount = Array.from(voiceover).length;
  const estimatedSec = Math.round(charCount / CHARS_PER_SECOND);
  const canConfirm = voiceover.trim().length > 0 && !pending;

  async function handleConfirm() {
    await onConfirm({
      voiceover: voiceover.trim(),
      selectedAssetIds: librarySelectedAssetIds,
      avatarProfileIds: avatarId ? [avatarId] : [],
      subtitleStyle,
      bgmTrackId,
    });
  }

  return (
    <div className="scriptConfirm" id="script-confirm">
      <h3>确认口播稿</h3>
      <p className="scriptMeta">
        约 {charCount} 字 · 预计 {estimatedSec}s · 黄色为关键词高亮
      </p>

      <div className="voiceoverPreview" aria-label="口播稿预览">
        {parts.map((p, i) =>
          p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>,
        )}
      </div>

      <textarea
        aria-label="口播稿编辑"
        value={voiceover}
        onChange={(e) => setVoiceover(e.target.value)}
        rows={5}
        style={{ width: "100%", margin: "6px 0" }}
      />

      <fieldset className="avatarPicker">
        <legend>出镜形象</legend>
        <label>
          <input
            type="radio"
            name="avatar"
            checked={avatarId === ""}
            onChange={() => setAvatarId("")}
          />
          不用数字人（纯素材成片）
        </label>
        {avatars.map((a, i) => (
          <label key={a.id}>
            <input
              type="radio"
              name="avatar"
              checked={avatarId === a.id}
              disabled={a.trainingStatus !== "ready"}
              onChange={() => setAvatarId(a.id)}
            />
            AI 形象 {i + 1}
            {a.trainingStatus === "ready" ? "" : "（训练中）"}
          </label>
        ))}
      </fieldset>

      <div style={{ marginTop: 12, display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <label>
          字幕样式
          <select value={subtitleStyle} onChange={(e) => setSubtitleStyle(e.target.value)}>
            {SUBTITLE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <label>
          背景音乐
          <select value={bgmTrackId} onChange={(e) => setBgmTrackId(e.target.value)}>
            <option value="">无音乐</option>
            {bgmTracks.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </label>
      </div>

      <button
        type="button"
        className="primaryButton"
        disabled={!canConfirm}
        onClick={handleConfirm}
        style={{ marginTop: 16 }}
      >
        {pending ? <span className="spinner" aria-hidden="true" /> : null}
        确认生成
      </button>
    </div>
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/script-confirm.test.tsx`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add components/script-confirm.tsx tests/script-confirm.test.tsx
git commit -m "feat(ui): ScriptConfirm card — voiceover edit + highlight preview + avatar pick"
```

---

### Task 9: Dashboard 集成——智能成片内嵌两步流 + 删除 StoryboardConfirm

**Files:**
- Modify: `components/dashboard.tsx`
- Delete: `components/storyboard-confirm.tsx`
- Delete: `tests/storyboard-confirm.test.tsx`
- Test: `tests/dashboard.test.tsx`（按钮改名 + 确认流集成用例）

- [ ] **Step 1: 更新失败测试 `tests/dashboard.test.tsx`**

**1a. 按钮改名（两处）**：

- 约第 1266 行：`expect(screen.getByRole("button", { name: "生成分镜脚本" })).toBeEnabled();` → 名称改 `"生成脚本"`
- 约第 1444 行：`await user.click(screen.getByRole("button", { name: "生成分镜脚本" }));` → 同上

**1b. 追加确认流集成用例**（追加到文件末尾；fetch mock 模式与同文件的 passall 用例一致）：

```tsx
  it("confirm card: edits voiceover, PATCHes, then creates render project with full selection", async () => {
    const user = userEvent.setup();
    const savedStore = {
      id: "store_confirm",
      ownerId: "demo_user",
      name: "确认店",
      industry: "餐饮",
      location: "上海",
      mainProducts: ["牛肉面"],
      targetCustomers: ["上班族"],
      sellingPoints: ["现熬牛骨汤"],
      promotions: [],
      brandTone: "亲切接地气",
      forbiddenWords: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    const savedAssets = [
      { id: "asset_c1", ownerId: "demo_user", storeId: "store_confirm", type: "video", originalFilename: "c1.mp4", storageKey: "k1", mimeType: "video/mp4", sizeBytes: 1000, tags: [], businessTags: [], status: "uploaded", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "asset_c2", ownerId: "demo_user", storeId: "store_confirm", type: "image", originalFilename: "c2.jpg", storageKey: "k2", mimeType: "image/jpeg", sizeBytes: 1000, tags: [], businessTags: [], status: "uploaded", createdAt: "2026-01-01T00:00:00.000Z" }
    ];
    const savedAnalyses = [
      { id: "analysis_c1", assetId: "asset_c1", visualTags: ["food"], businessTags: ["招牌菜"], keywords: [], confidence: 0.9, recommendedUses: [], analysisStatus: "succeeded", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "analysis_c2", assetId: "asset_c2", visualTags: ["food"], businessTags: ["招牌菜"], keywords: [], confidence: 0.9, recommendedUses: [], analysisStatus: "succeeded", createdAt: "2026-01-01T00:00:00.000Z" }
    ];
    const scriptPayload = {
      id: "script_confirm",
      ownerId: "demo_user",
      storeId: "store_confirm",
      purpose: "store_traffic",
      platform: "douyin",
      title: "引流",
      hook: "来店",
      scenes: [],
      voiceover: "原口播稿。",
      highlights: ["口播"],
      segments: [{ index: 0, text: "原口播稿。", speakerIndex: 0, onCamera: true }],
      captions: [],
      cta: "到店",
      generationMode: "ai",
      complianceWarnings: [],
      createdAt: "2026-01-02T00:00:00.000Z"
    };
    const fetchedBodies: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (method !== "GET") {
          fetchedBodies[`${method} ${url}`] = init?.body ? JSON.parse(init.body as string) : {};
        }
        return {
          ok: true,
          json: async () => {
            if (url === "/api/script-drafts" && method === "POST") return { script: scriptPayload };
            if (url === `/api/script-drafts/${scriptPayload.id}` && method === "PATCH") {
              const patchBody = JSON.parse(init?.body as string) as { voiceover: string };
              return { script: { ...scriptPayload, voiceover: patchBody.voiceover } };
            }
            if (url === "/api/render-projects" && method === "POST") {
              return { project: { id: "proj_confirm" }, jobs: [] };
            }
            if (url === "/api/store-profiles") return { stores: [savedStore] };
            if (url === "/api/assets") return { assets: savedAssets };
            if (url === "/api/asset-analyses") return { analyses: savedAnalyses };
            if (url === "/api/avatars") return { avatars: [] };
            if (url === "/api/jobs") return { jobs: [] };
            if (url === "/api/script-drafts") return { scripts: [] };
            return {};
          }
        };
      })
    );

    renderDashboard();

    await screen.findByText("已选 2 / 共 2");
    await user.click(screen.getByRole("button", { name: "生成脚本" }));

    // 确认卡片出现：口播稿可编辑
    const editor = await screen.findByLabelText("口播稿编辑");
    await user.clear(editor);
    await user.type(editor, "改后的口播稿。");
    await user.click(screen.getByRole("button", { name: /确认生成/ }));

    // 先 PATCH 改后的口播稿，再建渲染项目（avatars 为空 → 不带 avatarProfileIds）
    await waitFor(() => {
      expect(fetchedBodies[`PATCH /api/script-drafts/${scriptPayload.id}`]).toEqual({
        voiceover: "改后的口播稿。"
      });
    });
    await waitFor(() => {
      expect(fetchedBodies["POST /api/render-projects"]).toMatchObject({
        scriptDraftId: "script_confirm",
        selectedAssetIds: expect.arrayContaining(["asset_c1", "asset_c2"])
      });
    });
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/dashboard.test.tsx`
Expected: FAIL（按钮名还是「生成分镜脚本」；确认卡片不存在）

- [ ] **Step 3: 改造 `components/dashboard.tsx`（按下列编辑点逐一应用）**

**3a. import 替换**（第 32 行）：

```ts
import { ScriptConfirm } from "@/components/script-confirm";
```
（删除 `import { StoryboardConfirm } from "@/components/storyboard-confirm";`）

**3b. state 改名**（第 281 行）：

```ts
const [confirmDraft, setConfirmDraft] = useState<ScriptDraft | null>(null);
```
（`storyboardDraft`/`setStoryboardDraft` 全部改名，引用点见下）

**3c. 新增 storeAvatars memo**（紧跟现有 `const avatar = localAvatar ?? ...` 之后）：

```ts
  // 形象选择器数据源：本店形象列表（含本会话新建、尚未回源的）。
  const storeAvatars = useMemo(() => {
    const list = store ? serverAvatars.filter((a) => a.storeId === store.id) : [];
    return localAvatar && !list.some((a) => a.id === localAvatar.id)
      ? [localAvatar, ...list]
      : list;
  }, [serverAvatars, localAvatar, store]);
```

**3d. `generateStoryboard` 改名 `generateScript`**（函数体两处改动：setState 名 + 成功文案）：

```ts
  async function generateScript() {
    if (pendingAction || generating) return;
    if (!store) {
      setMessage("请先完成门店档案。");
      return;
    }

    if (selectedAnalyses.length === 0 || selectedAssets.length === 0) {
      setMessage("请先上传素材，让 AI 完成识别。");
      return;
    }

    setGenerating(true);

    try {
      const draft = await createScriptDraftApi({
        storeId: store.id,
        assetAnalysisIds: selectedAnalyses.map((a) => a.id),
        purpose: selectedPurpose,
        platform: "douyin",
        targetDurationSec: targetDuration
      });
      setConfirmDraft(draft);
      setLocalScript(draft);
      await queryClient.invalidateQueries({ queryKey: ["script-drafts"] });
      setMessage("脚本已生成：确认口播稿与出镜形象后，点「确认生成」出片。");
    } finally {
      setGenerating(false);
    }
  }
```

**3e. 删除 `patchStoryboard`，`confirmAndRender` 替换为 `confirmScriptAndRender`**：

```ts
  async function confirmScriptAndRender(selection: {
    voiceover: string;
    selectedAssetIds: string[];
    avatarProfileIds: string[];
    subtitleStyle: string;
    bgmTrackId: string;
  }) {
    if (!confirmDraft) return;
    setPendingAction("render");

    try {
      // 口播稿有改动先落库（服务端重切 segments / 过滤失效标黄 / 重派生 scenes），
      // 再建渲染项目——worker 读的始终是最新 draft。
      let draftToRender = confirmDraft;
      if (selection.voiceover !== confirmDraft.voiceover) {
        draftToRender = await updateScriptDraftApi({
          scriptDraftId: confirmDraft.id,
          voiceover: selection.voiceover
        });
        setConfirmDraft(draftToRender);
        setLocalScript(draftToRender);
      }

      const { jobs: plannedJobs } = await createRenderProjectApi({
        scriptDraftId: draftToRender.id,
        selectedAssetIds: selection.selectedAssetIds,
        avatarProfileIds: selection.avatarProfileIds.length > 0 ? selection.avatarProfileIds : undefined,
        aspectRatio: "9:16",
        subtitleStyle: selection.subtitleStyle,
        bgmTrackId: selection.bgmTrackId || undefined
      });
      setLocalJobs(plannedJobs);
      setConfirmDraft(null);
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
      setMessage("AI 正在生成你的视频：自动写文案、剪画面、加字幕、配音乐。");
    } finally {
      setPendingAction(null);
    }
  }
```

**3f. 生成按钮**（智能成片卡片内，原 `generateStoryboard` + 「生成分镜脚本」处）：

```tsx
          <button
            className="primaryButton"
            disabled={renderLocked || Boolean(renderMissingAssets) || generating || Boolean(pendingAction)}
            onClick={generateScript}
            type="button"
          >
            {generating ? <span className="spinner" aria-hidden="true" /> : null}
            {renderLocked
              ? "请先完成门店档案"
              : renderMissingAssets
                ? "请至少勾选一个素材"
                : "生成脚本"}
          </button>
```

**3g. 按钮之后内嵌确认卡片**（`{script ? (<div className="result">...)` 块之前插入）：

```tsx
          {confirmDraft ? (
            <ScriptConfirm
              key={confirmDraft.id}
              draft={confirmDraft}
              avatars={storeAvatars}
              bgmTracks={bgmTracks}
              librarySelectedAssetIds={selectedAssets.map((a) => a.id)}
              onConfirm={confirmScriptAndRender}
              pending={pendingAction === "render"}
            />
          ) : null}
```

**3h. 删除 grid section 尾部的 StoryboardConfirm 渲染块**：

```tsx
        {storyboardDraft ? (
          <StoryboardConfirm ... />
        ) : null}
```
整块删除（`</section>` 之前的整段）。

**3i. 删除组件与组件测试文件**：

```bash
git rm components/storyboard-confirm.tsx tests/storyboard-confirm.test.tsx
```

验证无残留引用：Run: `grep -rn "StoryboardConfirm\|storyboard-confirm\|storyboardDraft\|patchStoryboard\|生成分镜" components lib app tests --include="*.ts" --include="*.tsx"`
Expected: 无输出

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/dashboard.test.tsx tests/script-confirm.test.tsx`
Expected: 全部 PASS

- [ ] **Step 5: 类型检查 + lint**

Run: `npm run typecheck`
Expected: 无错误

Run: `npm run lint`
Expected: 无错误（若 ScriptConfirm 的 label 结构触发 jsx-a11y 规则，按提示微调 label/control 关联）

- [ ] **Step 6: Commit**

```bash
git add components/dashboard.tsx tests/dashboard.test.tsx
git commit -m "feat(ui): two-step script confirm flow in 智能成片; drop storyboard section"
```

---

### Task 10: 全量验证 + 收尾

**Files:** 无新增（验证 + 文档）

- [ ] **Step 1: 全量测试**

Run: `npm test`
Expected: 全部 PASS（约 290+ 用例；Phase 1 基线 291，本期净增若干）

如有失败：按 systematic-debugging 定位，禁止带红收尾。常见预期坑：
- `tests/repositories/script.test.ts` 若构造完整 ScriptDraft 字面量——optional 字段不破坏编译，无需改。
- `tests/talking-head-processor.test.ts` 若 mock draft——同样不受影响（talking-head 只读 `draft.voiceover`，契约未变）。

- [ ] **Step 2: 静态检查三件套**

Run: `npm run typecheck && npm run lint && npx prisma validate`
Expected: 全部无错误

- [ ] **Step 3: 生产构建**

Run: `npm run build`
Expected: 构建成功（prisma generate + next build 通过）

- [ ] **Step 4: 更新路线图记忆点（spec 文档状态标注）**

编辑 `docs/superpowers/specs/2026-08-16-voiceover-centric-pipeline-design.md` 第 4 行状态：

```md
状态：已确认（三期设计均已获用户批准）。Phase 1 已上线（2026-08-17）；Phase 2 已实施（2026-08-19）。
```

- [ ] **Step 5: Commit + push 前安全检查**

```bash
git add docs/superpowers/specs/2026-08-16-voiceover-centric-pipeline-design.md
git commit -m "docs(spec): mark Phase 2 implemented"
```

push 前对照 CLAUDE.md 安全清单自查本期变更面：
- 新/改路由均走 `getOwnerId()` + `applyRateLimit`，无 ad-hoc auth ✓
- PATCH：voiceover 长度 cap 2000、trim、非字符串 400；IDOR 404 ✓
- render-projects：avatarProfileIds 长度白名单（≤1）+ 属主 404；quota 在全部校验通过后消耗 ✓
- AI prompt：system prompt 服务端作者；门店字段仍经 `sanitizePromptField`；highlights/onCameraSentences 服务端过滤后才落库 ✓
- 无密钥/凭据进入 job payload 或日志 ✓

- [ ] **Step 6: push + ops 提醒**

```bash
git push origin main
```

push 后提醒用户（Zeabur 自动部署）：
1. **生产库迁移**：部署完成后对生产库执行 `npx prisma migrate deploy`（新增 `highlights`/`segments` 两列；与 Phase 1 迁移同流程）。
2. **观察 AI 输出**：prompt 契约已换（voiceover+highlights+onCameraSentences），上线后抽查生成稿的标黄命中率与 `warnIfVoiceoverOffTarget` 日志。

---

## Self-Review 记录（计划落笔后自查）

**Spec 覆盖**：
- §5.1 voiceover 复用 ✓（Task 3/4）、highlights ✓（Task 1/3/4/6/8）、segments（index/text/speakerIndex/onCamera）✓（Task 1/2/3/4）、onCamera 渲染忽略 ✓（派生 scenes 固定首/末 presenter，不读 onCamera）
- §5.2 POST 返回 highlights+segments ✓（Task 3）、PATCH voiceover 全文 + 重切 + 过滤 ✓（Task 4）、render-projects avatarProfileIds 长度 1 ✓（Task 5）
- §5.3 智能成片内嵌两步 ✓（Task 9）、StoryboardConfirm 删除 ✓（Task 9）、派生 scenes 喂管线、管线不动 ✓（Task 2/3；worker 仅 buildAss 加参，属 §5.4 范围）
- §5.4 标黄词包 `{\c&H00FFFF&}` ✓（Task 6，实现位置偏离已记录于设计决策 §1）、字数加权对齐沿用 Phase 1 buildCaptionCues ✓
- §5.5 测试：AI/模板双路径 ✓（Task 3）、PATCH ✓（Task 4）、scenes 派生 ✓（Task 2）、UI 两步流 ✓（Task 8/9）
- §7 安全：getOwnerId 沿用 ✓、无新路由 ✓、avatar 属主校验 ✓（Task 5）

**Placeholder 扫描**：无 TBD/TODO；所有代码步骤均含完整代码与预期输出。

**类型一致性**：`ScriptSegment{index,text,speakerIndex,onCamera}`、`deriveSegmentsFromVoiceover(voiceover, opts)`、`deriveScenesFromSegments(segments)`、`filterActiveHighlights(highlights, voiceover)`、`findHighlightRanges(text, words)`、`wrapHighlightsInAss(text, highlights, resetColor)`、`buildAss(cues, preset, highlights?)`、`updateScriptDraftApi({scriptDraftId, voiceover})`、`createRenderProjectApi({..., avatarProfileIds?})`、`ScriptConfirmSelection{voiceover, selectedAssetIds, avatarProfileIds, subtitleStyle, bgmTrackId}`——全部在定义任务与消费任务间一致。
