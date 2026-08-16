# Phase 1：渲染 bug 修复 + 时长档位 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 3 个线上渲染 bug（时长不符/素材用不全/音字不符），时长档位改为 30/45/60 默认 45。

**Architecture:** 目标时长落库（ScriptDraft→RenderProject→worker），`buildTimeline` 按目标时长归一化（素材循环复用铺满）；字幕数据源从 `scene.text`（画面描述）切换为 `draft.voiceover`（口播全文按句切分）；分镜确认页改为透传素材库完整勾选集合。

**Tech Stack:** Next.js 16 / TypeScript strict / Prisma 7 / Vitest / BullMQ worker / ffmpeg。

**Spec:** `docs/superpowers/specs/2026-08-16-voiceover-centric-pipeline-design.md`（§4 Phase 1）

---

## File Structure

| 文件 | 改动 | 责任 |
|---|---|---|
| `lib/types.ts` | 修改 | `ScriptDraft`/`RenderProject` 加 `targetDurationSec?: number` |
| `prisma/schema.prisma` + 新 migration | 修改/新建 | 两表加 `targetDurationSec Int?` |
| `lib/repositories/mappers.ts` | 修改 | 4 个 mapper 透传新字段 |
| `lib/services/script-engine.ts` | 修改 | 档位文案量、模板时长缩放、targetDurationSec 落库、AI 偏离警告 |
| `lib/services/video-compose.ts` | 修改 | `buildTimeline` 目标时长归一化；新增 `buildCaptionCues`/`splitVoiceoverSentences`；`buildAss` 泛化 |
| `lib/services/render-pipeline.ts` | 修改 | `createRenderProject` 继承 targetDurationSec |
| `worker/processors/video-render.ts` | 修改 | 接线 targetDurationSec + 口播字幕 |
| `components/storyboard-confirm.tsx` | 修改 | 确认时透传完整勾选集合（新 prop） |
| `components/dashboard.tsx` | 修改 | 传新 prop；档位 30/45/60 默认 45 |
| `tests/video-compose.test.ts` | 修改 | 归一化 + 字幕 cues 测试 |
| `tests/script-engine.test.ts` | 修改 | 模板缩放/落库/警告测试 |
| `tests/repositories/mappers.test.ts` | 新建 | mapper 往返测试 |
| `tests/render-pipeline.test.ts` | 修改 | 继承测试 |
| `tests/video-render-processor-captions.test.ts` | 新建 | 处理器接线测试 |
| `tests/storyboard-confirm.test.tsx` | 修改 | 全量素材测试 |
| `tests/dashboard.test.tsx` | 修改 | 档位默认值测试 |

---

### Task 1: `targetDurationSec` 类型 + Prisma 持久化

**Files:**
- Modify: `lib/types.ts:118-149`
- Modify: `prisma/schema.prisma:132-172`
- Modify: `lib/repositories/mappers.ts:176-248`
- Test: `tests/repositories/mappers.test.ts`（新建）

- [ ] **Step 1: 写失败测试（mapper 往返透传）**

新建 `tests/repositories/mappers.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import {
  toRenderProject,
  toRenderProjectInput,
  toScriptDraft,
  toScriptDraftInput,
} from "@/lib/repositories/mappers";
import type { RenderProject, ScriptDraft } from "@/lib/types";

const draft: ScriptDraft = {
  id: "script_1",
  ownerId: "u",
  storeId: "s",
  purpose: "store_traffic",
  platform: "douyin",
  title: "t",
  hook: "h",
  scenes: [{ order: 1, text: "x", durationSeconds: 5, assetHints: [], role: "presenter" }],
  voiceover: "v",
  captions: [],
  cta: "c",
  generationMode: "ai",
  complianceWarnings: [],
  targetDurationSec: 45,
  createdAt: "2026-08-16T00:00:00.000Z",
};

const project: RenderProject = {
  id: "render_1",
  ownerId: "u",
  storeId: "s",
  scriptDraftId: "script_1",
  selectedAssetIds: ["a1"],
  purpose: "store_traffic",
  aspectRatio: "9:16",
  subtitleStyle: "default",
  targetDurationSec: 45,
  status: "queued",
  createdAt: "2026-08-16T00:00:00.000Z",
  updatedAt: "2026-08-16T00:00:00.000Z",
};

describe("mappers: targetDurationSec persistence", () => {
  it("toScriptDraftInput / toScriptDraft roundtrip targetDurationSec", () => {
    const dbInput = toScriptDraftInput(draft);
    expect(dbInput.targetDurationSec).toBe(45);
    const row = { ...dbInput, createdAt: new Date("2026-08-16T00:00:00.000Z") };
    const back = toScriptDraft(row as never);
    expect(back.targetDurationSec).toBe(45);
  });

  it("toRenderProjectInput / toRenderProject roundtrip targetDurationSec", () => {
    const dbInput = toRenderProjectInput(project);
    expect(dbInput.targetDurationSec).toBe(45);
    const row = {
      ...dbInput,
      createdAt: new Date("2026-08-16T00:00:00.000Z"),
      updatedAt: new Date("2026-08-16T00:00:00.000Z"),
    };
    const back = toRenderProject(row as never);
    expect(back.targetDurationSec).toBe(45);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/repositories/mappers.test.ts`
Expected: FAIL（编译错误：`targetDurationSec` 不在 `ScriptDraft` 类型上）

- [ ] **Step 3: 类型 + schema + mapper 实现**

`lib/types.ts` — `ScriptDraft` 接口 `complianceWarnings` 后加一行；`RenderProject` 接口 `bgmTrackId?` 后加一行：

```ts
// ScriptDraft 内（complianceWarnings: string[]; 之后）
  /** 目标成片时长（秒）：30 / 45 / 60。 */
  targetDurationSec?: number;
```

```ts
// RenderProject 内（bgmTrackId?: string; 之后）
  /** 继承自 ScriptDraft：目标成片时长（秒）。 */
  targetDurationSec?: number;
```

`prisma/schema.prisma` — `ScriptDraft` model 加字段（`complianceWarnings String[]` 之后）；`RenderProject` model 加字段（`bgmTrackId String?` 之后）：

```prisma
// ScriptDraft model 内
  targetDurationSec Int?
// RenderProject model 内
  targetDurationSec Int?
```

`lib/repositories/mappers.ts`：

`toScriptDraft` 返回对象中 `complianceWarnings: row.complianceWarnings,` 之后加：

```ts
    targetDurationSec: row.targetDurationSec ?? undefined,
```

`toScriptDraftInput` 返回对象中 `complianceWarnings: script.complianceWarnings,` 之后加：

```ts
    targetDurationSec: script.targetDurationSec ?? null,
```

`toRenderProject` 返回对象中 `bgmTrackId: row.bgmTrackId ?? undefined,` 之后加：

```ts
    targetDurationSec: row.targetDurationSec ?? undefined,
```

`toRenderProjectInput` 返回对象中 `bgmTrackId: project.bgmTrackId ?? null,` 之后加：

```ts
    targetDurationSec: project.targetDurationSec ?? null,
```

- [ ] **Step 4: 生成 migration 并重跑测试**

Run: `npx prisma migrate dev --name add_target_duration_sec`
Expected: 创建 migration 并应用；Prisma Client 重新生成。若本地数据库不可用导致失败，**停止并向用户报告**（不要跳过此步手写 SQL）。

Run: `npx vitest run tests/repositories/mappers.test.ts`
Expected: PASS（2 个用例）

- [ ] **Step 5: 确认无破坏性后提交**

Run: `npm run typecheck`
Expected: 0 errors（新字段为可选，既有构造不受影响）

```bash
git add lib/types.ts prisma/schema.prisma prisma/migrations lib/repositories/mappers.ts tests/repositories/mappers.test.ts
git commit -m "feat(render): persist targetDurationSec on ScriptDraft and RenderProject"
```

---

### Task 2: script-engine — 档位文案量 + 模板时长缩放 + 偏离警告

**Files:**
- Modify: `lib/services/script-engine.ts`
- Modify: `app/api/script-drafts/route.ts:39-47`
- Test: `tests/script-engine.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/script-engine.test.ts` 文件末尾的 `describe` 块内追加（文件顶部 import 需补 `vi`：`import { describe, expect, it, vi } from "vitest";`）：

```ts
  it("template draft carries targetDurationSec and scales scene durations to the slot", () => {
    const d45 = createTemplateScriptDraft({
      store, assetAnalyses: analysis, purpose: "store_traffic",
      reason: "test", targetDurationSec: 45,
    });
    expect(d45.targetDurationSec).toBe(45);
    // 45s 档：4 镜（开场 presenter + 2 broll + 结尾 presenter），presenter 镜各 ≈45*0.15≈7s
    expect(d45.scenes).toHaveLength(4);
    const presenters = d45.scenes.filter((s) => s.role === "presenter");
    expect(presenters).toHaveLength(2);
    for (const p of presenters) expect(p.durationSeconds).toBe(7);
  });

  it("template default (no target) keeps the 3-scene 30s layout", () => {
    const d = createTemplateScriptDraft({
      store, assetAnalyses: analysis, purpose: "store_traffic", reason: "test",
    });
    expect(d.scenes).toHaveLength(3);
    expect(d.targetDurationSec).toBeUndefined();
  });

  it("template 60s slot produces 5 scenes and longer voiceover than 30s slot", () => {
    const d30 = createTemplateScriptDraft({
      store, assetAnalyses: analysis, purpose: "store_traffic",
      reason: "test", targetDurationSec: 30,
    });
    const d60 = createTemplateScriptDraft({
      store, assetAnalyses: analysis, purpose: "store_traffic",
      reason: "test", targetDurationSec: 60,
    });
    expect(d60.scenes).toHaveLength(5);
    expect(d60.voiceover.length).toBeGreaterThan(d30.voiceover.length);
    // 60s 档口播包含活动信息（store.promotions[0] 存在时）
    expect(d60.voiceover).toContain("工作日午餐第二份半价");
  });

  it("warnIfDurationOffTarget warns when scene sum deviates >50% from target", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    warnIfDurationOffTarget(
      [{ order: 1, text: "x", durationSeconds: 5, assetHints: [], role: "presenter" }],
      45,
    );
    expect(spy).toHaveBeenCalledOnce();
    spy.mockClear();
    warnIfDurationOffTarget(
      [
        { order: 1, text: "a", durationSeconds: 20, assetHints: [], role: "presenter" },
        { order: 2, text: "b", durationSeconds: 20, assetHints: [], role: "broll" },
      ],
      45,
    );
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
```

import 处加 `warnIfDurationOffTarget`：

```ts
import { createScriptDraft, createTemplateScriptDraft, warnIfDurationOffTarget } from "@/lib/services/script-engine";
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/script-engine.test.ts`
Expected: FAIL（`warnIfDurationOffTarget` 未导出 / `targetDurationSec` 不在 TemplateDraftInput）

- [ ] **Step 3: 实现**

`lib/services/script-engine.ts`：

(1) `TemplateDraftInput` 加字段：

```ts
interface TemplateDraftInput {
  store: StoreProfile;
  assetAnalyses: AssetAnalysis[];
  purpose: MarketingPurpose;
  reason: string;
  /** 目标时长（秒）：30 / 45 / 60，影响模板镜数与文案量。 */
  targetDurationSec?: number;
}
```

(2) `durationGuidance` 整体替换为：

```ts
function durationGuidance(target?: number): string {
  if (target === 45) return "约45秒，分4-6个场景，配音全文约190-210字";
  if (target === 60) return "约60秒，分6-8个场景，配音全文约260-280字";
  return "约30秒，分3-5个场景，配音全文约130-150字";
}
```

(3) `SYSTEM_PROMPT` 中 `- 分3-4个场景，每个场景标注需要的画面素材提示` 一行替换为：

```ts
- 按【目标时长】决定场景数与配音总字数（中文配音约每秒4.5字），每个场景标注需要的画面素材提示
```

(4) 新增导出函数（放在 `buildTemplateScenes` 之前）：

```ts
/** AI 返回的各镜时长之和偏离目标 >50% 时打警告日志（不重试，仅观测）。 */
export function warnIfDurationOffTarget(
  scenes: ScriptScene[],
  targetDurationSec?: number,
): void {
  if (!targetDurationSec || scenes.length === 0) return;
  const sum = scenes.reduce((acc, s) => acc + (s.durationSeconds || 0), 0);
  if (Math.abs(sum - targetDurationSec) > targetDurationSec * 0.5) {
    console.warn(
      `[script-engine] scene duration sum ${sum}s deviates >50% from target ${targetDurationSec}s`,
    );
  }
}
```

(5) `createScriptDraftWithAI` 中 `return buildDraft({...})` 之前插入调用：

```ts
  warnIfDurationOffTarget(scenes, input.targetDurationSec);
```

(6) `createTemplateScriptDraft` 整体替换为：

```ts
export function createTemplateScriptDraft(input: TemplateDraftInput): ScriptDraft {
  const warnings = [`AI unavailable, used template fallback: ${input.reason}`];
  const voiceover = buildTemplateVoiceover(input.store, input.purpose, input.targetDurationSec);
  const cleaned = sanitizeCopy(voiceover, input.store.forbiddenWords);
  const primaryProduct = input.store.mainProducts[0] ?? "招牌产品";

  return buildDraft({
    store: input.store,
    assetAnalyses: input.assetAnalyses,
    purpose: input.purpose,
    platform: "douyin",
    generationMode: "template_fallback",
    title: `${input.store.name}｜${primaryProduct}到店推荐`,
    hook: `今天推荐${input.store.name}的${primaryProduct}`,
    voiceover: cleaned.copy,
    scenes: buildTemplateScenes(input.store, input.assetAnalyses, input.targetDurationSec),
    captions: [cleaned.copy],
    cta: purposeCta[input.purpose],
    warnings: [...warnings, ...cleaned.warnings],
    targetDurationSec: input.targetDurationSec,
  });
}

/** 模板口播：按档位拼装门店真实字段（产品/卖点/活动/客群），不虚构承诺。 */
function buildTemplateVoiceover(
  store: StoreProfile,
  purpose: MarketingPurpose,
  targetDurationSec?: number,
): string {
  const primaryProduct = store.mainProducts[0] ?? "招牌产品";
  const target = targetDurationSec ?? 30;
  const parts: string[] = [
    `${store.name}今天主推${primaryProduct}，${store.sellingPoints[0] ?? "门店现做现卖"}。`,
  ];
  if (target >= 45) {
    if (store.mainProducts[1]) parts.push(`除了${primaryProduct}，${store.mainProducts[1]}也值得一试。`);
    else if (store.sellingPoints[1]) parts.push(`${store.sellingPoints[1]}。`);
    else if (store.location) parts.push(`就在${store.location}，路过进来看看。`);
  }
  if (target >= 60) {
    if (store.promotions?.[0]) parts.push(`现在到店${store.promotions[0]}。`);
    if (store.targetCustomers[0]) parts.push(`特别适合${store.targetCustomers[0]}。`);
  }
  parts.push(`${purposeCta[purpose]}。`);
  return parts.join("");
}
```

(7) `buildTemplateScenes` 整体替换为：

```ts
function buildTemplateScenes(
  store: StoreProfile,
  assetAnalyses: AssetAnalysis[],
  targetDurationSec?: number,
): ScriptScene[] {
  const hints = collectAssetHints(assetAnalyses);
  const primaryProduct = store.mainProducts[0] ?? "招牌产品";
  const target = targetDurationSec ?? 30;
  const presenterSec = Math.max(3, Math.round(target * 0.15));
  const brollSec = Math.max(4, Math.round(target * 0.25));

  const scenes: ScriptScene[] = [
    {
      order: 1,
      text: `开场展示${store.name}门店或招牌`,
      durationSeconds: presenterSec,
      assetHints: hints.length ? hints : ["门店环境"],
      role: "presenter",
    },
    {
      order: 2,
      text: `展示${primaryProduct}和制作/服务过程`,
      durationSeconds: brollSec,
      assetHints: [primaryProduct, ...hints].slice(0, 3),
      role: "broll",
    },
  ];
  if (target >= 45) {
    scenes.push({
      order: scenes.length + 1,
      text: `展示${store.name}店内环境和氛围`,
      durationSeconds: brollSec,
      assetHints: ["门店环境", ...hints].slice(0, 3),
      role: "broll",
    });
  }
  if (target >= 60) {
    scenes.push({
      order: scenes.length + 1,
      text: `展示${primaryProduct}细节特写和顾客反馈`,
      durationSeconds: brollSec,
      assetHints: [primaryProduct, "口碑"].slice(0, 3),
      role: "broll",
    });
  }
  scenes.push({
    order: scenes.length + 1,
    text: "展示优惠、地址或到店 CTA",
    durationSeconds: presenterSec,
    assetHints: ["促销", "到店引流"],
    role: "presenter",
  });
  return scenes;
}
```

(8) `buildDraft` 入参类型加 `targetDurationSec?: number;`，返回对象中 `complianceWarnings: input.warnings,` 之后加：

```ts
    ...(input.targetDurationSec ? { targetDurationSec: input.targetDurationSec } : {}),
```

(9) `createScriptDraft` 三处接线：
- `forcedRawCopy` 分支的 `buildDraft({...})` 加 `targetDurationSec: input.targetDurationSec,`
- AI 失败 fallback 的 `createTemplateScriptDraft({...})` 加 `targetDurationSec: input.targetDurationSec,`
- `createScriptDraftWithAI` 的 `buildDraft({...})` 加 `targetDurationSec: input.targetDurationSec,`

`app/api/script-drafts/route.ts:39-40` — `forceTemplate` 分支加透传：

```ts
  const script = body.forceTemplate
    ? createTemplateScriptDraft({
        store,
        assetAnalyses,
        purpose,
        reason: "manual_template_mode",
        targetDurationSec: typeof body.targetDurationSec === "number" ? body.targetDurationSec : undefined,
      })
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/script-engine.test.ts`
Expected: PASS（含既有用例——默认无 target 仍为 3 镜）

- [ ] **Step 5: 提交**

```bash
git add lib/services/script-engine.ts app/api/script-drafts/route.ts tests/script-engine.test.ts
git commit -m "feat(script): scale template scenes/voiceover to 30/45/60s slots, persist targetDurationSec"
```

---

### Task 3: video-compose — `buildTimeline` 目标时长归一化（B1 核心）

**Files:**
- Modify: `lib/services/video-compose.ts:41-164`
- Test: `tests/video-compose.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/video-compose.test.ts` 第一个 `describe("video-compose buildTimeline")` 块内追加：

```ts
  it("target slot: asset_only loops the pool to fill the target duration", () => {
    // 1 个 5s 视频 + 1 张图片（3s），目标 20s：循环复用铺满
    const { segments, totalDurationSec } = buildTimeline({
      scenes, assets, selectedAssetIds: ["a1", "a2"],
      assetDurations: { a1: 5 }, targetDurationSec: 20,
    });
    expect(totalDurationSec).toBeCloseTo(20, 1);
    const a1Beats = segments.filter((s) => s.assetId === "a1");
    expect(a1Beats.length).toBeGreaterThan(1); // 循环复用
    // 每个素材至少出现一次（第一遍保底）
    expect(segments.some((s) => s.assetId === "a2")).toBe(true);
  });

  it("target slot: presenter mode fills broll up to target minus presenter total", () => {
    // presenter 镜 4+4=8s，目标 30s → broll 填 ≈22s；TH 60s 不限制
    const { segments, totalDurationSec } = buildTimeline({
      scenes, assets, selectedAssetIds: ["a1"],
      assetDurations: { a1: 5 }, talkingHeadDurationSec: 60, targetDurationSec: 30,
    });
    expect(totalDurationSec).toBeCloseTo(30, 1);
    const brollSum = segments.filter((s) => s.role === "broll").reduce((acc, s) => acc + s.durationSec, 0);
    expect(brollSum).toBeGreaterThan(15); // 远大于单遍的 5s
  });

  it("target slot: talking-head shorter than target still caps the total (voice wins)", () => {
    const { totalDurationSec } = buildTimeline({
      scenes, assets, selectedAssetIds: ["a1"],
      assetDurations: { a1: 5 }, talkingHeadDurationSec: 10, targetDurationSec: 30,
    });
    expect(totalDurationSec).toBeCloseTo(10, 1);
  });

  it("target slot omitted: single pass, no looping (backward compatible)", () => {
    const { segments } = buildTimeline({
      scenes, assets, selectedAssetIds: ["a1", "a2"],
      assetDurations: { a1: 5 }, talkingHeadDurationSec: 20,
    });
    const brollIds = segments.filter((s) => s.role === "broll").map((s) => s.assetId);
    expect(brollIds).toEqual(["a1", "a2"]); // 无重复
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/video-compose.test.ts`
Expected: 新用例 FAIL（`targetDurationSec` 不在 BuildTimelineArgs）

- [ ] **Step 3: 实现**

`lib/services/video-compose.ts`：

(1) `BuildTimelineArgs` 加字段（`talkingHeadDurationSec?` 之后）：

```ts
  /** 目标成片时长（秒）。提供时 b-roll 循环复用素材铺满；省略时保持单遍旧行为。 */
  targetDurationSec?: number;
```

(2) `buildTimeline` 函数体替换 beats 生成与 total 计算部分。完整新实现（替换原 60-164 行函数整体，注释同步更新）：

```ts
export function buildTimeline(args: BuildTimelineArgs): BuildTimelineResult {
  const assetDurations = args.assetDurations ?? {};
  const imageDefaultSec = args.imageDefaultSec ?? 3;
  const maxClipSec = args.maxClipSec ?? 12;
  const hasTalkingHead =
    typeof args.talkingHeadDurationSec === "number" && args.talkingHeadDurationSec > 0;
  const target =
    typeof args.targetDurationSec === "number" && args.targetDurationSec > 0
      ? args.targetDurationSec
      : undefined;

  // Ordered, existing, de-duped selected assets = the broll pool.
  const seen = new Set<string>();
  const pool: Asset[] = [];
  for (const id of args.selectedAssetIds) {
    if (seen.has(id)) continue;
    const asset = args.assets.find((a) => a.id === id);
    if (asset) {
      seen.add(id);
      pool.push(asset);
    }
  }

  // Scene-pinned ordering: assets matched to broll scenes (via matchedAssetId) come first,
  // in scene order; any remaining pool assets are appended after.
  const poolById = new Map(pool.map((a) => [a.id, a]));
  const usedAssetIds = new Set<string>();
  const orderedAssets: Asset[] = [];
  for (const s of args.scenes) {
    if (s.role !== "broll") continue;
    const mid = s.matchedAssetId ?? null;
    if (mid && poolById.has(mid) && !usedAssetIds.has(mid)) {
      orderedAssets.push(poolById.get(mid) as Asset);
      usedAssetIds.add(mid);
    }
  }
  for (const a of pool) {
    if (!usedAssetIds.has(a.id)) {
      orderedAssets.push(a);
      usedAssetIds.add(a.id);
    }
  }

  // Natural duration: video = real (capped) length; image = default slot.
  const naturalFor = (a: Asset): number =>
    a.type === "video"
      ? Math.min(Math.max(assetDurations[a.id] ?? imageDefaultSec, 0.5), maxClipSec)
      : imageDefaultSec;

  // Subtitle text pool: cycle scene texts across broll beats.
  const subtitlePool = args.scenes.map((s) => s.text).filter((t) => t.length > 0);
  let textCursor = 0;
  const nextText = (): string =>
    subtitlePool.length > 0 ? subtitlePool[textCursor++ % subtitlePool.length] : "";

  type Beat = { role: SceneRole; assetId: string | null; text: string; natural: number };
  const beats: Beat[] = [];

  const presenterScenes = args.scenes.filter((s) => s.role === "presenter");
  const openers = presenterScenes.slice(0, -1);
  const closer = presenterScenes.length > 0 ? presenterScenes[presenterScenes.length - 1] : undefined;
  const presenterTotal = presenterScenes.reduce(
    (acc, s) => acc + Math.max(s.durationSeconds, 0.5),
    0,
  );

  // B-roll fill: first pass guarantees every selected asset appears; when a
  // target slot is set, keep looping the pool until the budget (target minus
  // presenter time, or the whole target in asset_only mode) is filled.
  // natural >= 0.5 always, so the loop terminates; the 1000-beat guard is a
  // backstop against pathological inputs.
  const pushBrollBeats = (budget: number | undefined): void => {
    if (orderedAssets.length === 0) return;
    let filled = 0;
    for (const a of orderedAssets) {
      const natural = naturalFor(a);
      beats.push({ role: "broll", assetId: a.id, text: nextText(), natural });
      filled += natural;
    }
    if (budget === undefined) return;
    let i = 0;
    while (filled < budget && i < 1000) {
      const a = orderedAssets[i % orderedAssets.length] as Asset;
      const natural = naturalFor(a);
      beats.push({ role: "broll", assetId: a.id, text: nextText(), natural });
      filled += natural;
      i++;
    }
  };

  if (hasTalkingHead) {
    for (const s of openers) {
      beats.push({ role: "presenter", assetId: null, text: s.text, natural: Math.max(s.durationSeconds, 0.5) });
    }
    pushBrollBeats(target !== undefined ? Math.max(target - presenterTotal, 0) : undefined);
    if (closer) {
      beats.push({ role: "presenter", assetId: null, text: closer.text, natural: Math.max(closer.durationSeconds, 0.5) });
    }
  } else {
    pushBrollBeats(target);
    if (pool.length === 0) {
      // No assets selected: one beat per script scene so the video is never empty.
      for (const s of args.scenes) {
        beats.push({ role: "broll", assetId: null, text: s.text, natural: Math.max(s.durationSeconds, 0.5) });
      }
    }
  }

  // Total: content caps at the target slot when provided; the talking-head
  // track always wins when shorter (the voiceover cannot be stretched).
  const contentTotal = beats.reduce((acc, b) => acc + b.natural, 0);
  const total = hasTalkingHead
    ? Math.min(args.talkingHeadDurationSec as number, target ?? Infinity, contentTotal)
    : Math.min(target ?? Infinity, contentTotal);
  const scale = contentTotal > 0 ? total / contentTotal : 1;

  let cursor = 0;
  const segments: TimelineSegment[] = beats.map((b, i) => {
    const duration = b.natural * scale;
    const start = cursor;
    cursor = start + duration;
    return {
      role: b.role,
      startSec: start,
      endSec: cursor,
      durationSec: duration,
      sceneOrder: i + 1,
      text: b.text,
      assetId: b.assetId
    };
  });

  return { segments, totalDurationSec: cursor };
}
```

注意函数顶部 JSDoc 中「the total is min(talkingHeadDuration, contentTotal)」一句更新为「the total is min(talkingHeadDuration, targetDurationSec?, contentTotal)」。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/video-compose.test.ts`
Expected: PASS（全部新旧用例——旧用例验证 backward compatible）

- [ ] **Step 5: 提交**

```bash
git add lib/services/video-compose.ts tests/video-compose.test.ts
git commit -m "fix(render): normalize timeline to target duration slot by looping asset pool"
```

---

### Task 4: video-compose — 口播字幕 cues（B3 核心）

**Files:**
- Modify: `lib/services/video-compose.ts:166-239`
- Test: `tests/video-compose.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/video-compose.test.ts` 文件末尾追加新 describe：

```ts
import { buildCaptionCues, splitVoiceoverSentences } from "@/lib/services/video-compose";
// （顶部 import 行合并进既有 video-compose import）

describe("buildCaptionCues (voiceover-derived subtitles)", () => {
  it("splits Chinese voiceover on sentence punctuation, keeping it", () => {
    expect(splitVoiceoverSentences("第一句。第二句！第三句？")).toEqual([
      "第一句。",
      "第二句！",
      "第三句？",
    ]);
  });

  it("returns a single cue for voiceover without punctuation", () => {
    expect(splitVoiceoverSentences("没有标点的一整段")).toEqual(["没有标点的一整段"]);
  });

  it("cues are contiguous, cover the full duration, and are weighted by sentence length", () => {
    const cues = buildCaptionCues("短。这一句比较长一些。", 10);
    expect(cues).toHaveLength(2);
    expect(cues[0]?.startSec).toBe(0);
    expect(cues[0]?.endSec).toBeCloseTo(cues[1]?.startSec ?? -1, 5);
    expect(cues[1]?.endSec).toBeCloseTo(10, 1);
    // 长句分到更多时间
    const d0 = (cues[0]?.endSec ?? 0) - (cues[0]?.startSec ?? 0);
    const d1 = (cues[1]?.endSec ?? 0) - (cues[1]?.startSec ?? 0);
    expect(d1).toBeGreaterThan(d0);
  });

  it("empty voiceover or non-positive duration yields no cues", () => {
    expect(buildCaptionCues("", 10)).toEqual([]);
    expect(buildCaptionCues("句子。", 0)).toEqual([]);
  });

  it("buildAss renders cues with voiceover text (not scene descriptions)", () => {
    const ass = buildAss(buildCaptionCues("星巴克今天主推冰美式。", 8), "default");
    expect(ass).toContain("Dialogue: 0,0:00:00.00,0:00:08.00,Default,,0,0,0,,星巴克今天主推冰美式。");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/video-compose.test.ts`
Expected: FAIL（`buildCaptionCues`/`splitVoiceoverSentences` 未导出）

- [ ] **Step 3: 实现**

`lib/services/video-compose.ts` — 在 `buildAss` 之前插入：

```ts
// ── Voiceover-derived caption cues ─────────────────────────────────────────

export interface CaptionCue {
  startSec: number;
  endSec: number;
  text: string;
}

/** 按中英文句读切句，保留句尾标点。无标点时整段为一句。 */
export function splitVoiceoverSentences(voiceover: string): string[] {
  return voiceover
    .split(/(?<=[。！？!?；;\n])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * 字幕 cues 从口播全文派生（Bug 3 fix：字幕必须等于配音内容）。
 * 按句切分，按句字数加权分摊配音总时长，cues 连续覆盖 [0, totalDurationSec]。
 */
export function buildCaptionCues(voiceover: string, totalDurationSec: number): CaptionCue[] {
  const sentences = splitVoiceoverSentences(voiceover);
  if (sentences.length === 0 || totalDurationSec <= 0) return [];
  const weights = sentences.map((s) => Math.max(Array.from(s).length, 1));
  const weightTotal = weights.reduce((a, b) => a + b, 0);
  let cursor = 0;
  return sentences.map((text, i) => {
    const duration = ((weights[i] as number) / weightTotal) * totalDurationSec;
    const cue = { startSec: cursor, endSec: cursor + duration, text };
    cursor += duration;
    return cue;
  });
}
```

`buildAss` 签名泛化（`TimelineSegment[]` → 结构子集，segments 仍可直接传入），并过滤空文本：

```ts
export function buildAss(
  cues: Array<{ startSec: number; endSec: number; text: string }>,
  preset: SubtitleStylePreset,
): string {
  const s = SUBTITLE_PRESETS[preset] ?? SUBTITLE_PRESETS.default;
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 1080",
    "PlayResY: 1920",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,${s.fontname},${s.fontsize},${s.primaryColour},${s.outlineColour},${s.bold},0,1,${s.outline},0,${s.alignment},40,40,${s.marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"
  ];
  const dialogues = cues
    .filter((cue) => cue.text.length > 0)
    .map((cue) =>
      `Dialogue: 0,${assTimestamp(cue.startSec)},${assTimestamp(cue.endSec)},Default,,0,0,0,,${cue.text}`
    );
  return [...header, ...dialogues].join("\n");
}
```

`buildAss` 上方 JSDoc 中「one Dialogue line per timeline segment」改为「one Dialogue line per cue (timeline segment or voiceover caption cue)」。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/video-compose.test.ts`
Expected: PASS（含既有 buildAss 用例——segments 结构兼容）

- [ ] **Step 5: 提交**

```bash
git add lib/services/video-compose.ts tests/video-compose.test.ts
git commit -m "fix(render): derive subtitle cues from voiceover instead of scene descriptions"
```

---

### Task 5: render-pipeline — 创建项目时继承 targetDurationSec

**Files:**
- Modify: `lib/services/render-pipeline.ts:15-33`
- Modify: `lib/types.ts`（Task 1 已改，无需再动）
- Test: `tests/render-pipeline.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/render-pipeline.test.ts` 末尾追加（import 需含 `createRenderProject` 与类型 `ScriptDraft`；若既有 import 不含则补充）：

```ts
  it("createRenderProject inherits targetDurationSec from the script draft", () => {
    const draft: ScriptDraft = {
      id: "script_t",
      ownerId: "u",
      storeId: "s",
      purpose: "store_traffic",
      platform: "douyin",
      title: "t",
      hook: "h",
      scenes: [],
      voiceover: "v",
      captions: [],
      cta: "c",
      generationMode: "ai",
      complianceWarnings: [],
      targetDurationSec: 45,
      createdAt: "2026-08-16T00:00:00.000Z",
    };
    const project = createRenderProject({
      ownerId: "u",
      storeId: "s",
      scriptDraft: draft,
      selectedAssetIds: [],
      aspectRatio: "9:16",
      subtitleStyle: "default",
    });
    expect(project.targetDurationSec).toBe(45);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/render-pipeline.test.ts`
Expected: FAIL（project 无 `targetDurationSec`）

- [ ] **Step 3: 实现**

`lib/services/render-pipeline.ts` — `createRenderProject` 返回对象中 `bgmTrackId: input.bgmTrackId,` 之后加：

```ts
    targetDurationSec: input.scriptDraft.targetDurationSec,
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/render-pipeline.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add lib/services/render-pipeline.ts tests/render-pipeline.test.ts
git commit -m "feat(render): inherit targetDurationSec from script draft into render project"
```

---

### Task 6: video-render processor — 接线目标时长 + 口播字幕

**Files:**
- Modify: `worker/processors/video-render.ts:139-165`
- Test: `tests/video-render-processor-captions.test.ts`（新建）

- [ ] **Step 1: 写失败测试**

新建 `tests/video-render-processor-captions.test.ts`（自包含 stub deps，不依赖既有测试 helper）：

```ts
import { describe, expect, it } from "vitest";
import { processVideoRender, type VideoRenderDeps, type RenderCompositeInput } from "@/worker/processors/video-render";
import type { Asset, RenderProject, ScriptDraft, VideoOutput } from "@/lib/types";

const draft: ScriptDraft = {
  id: "script_1",
  ownerId: "u",
  storeId: "s",
  purpose: "store_traffic",
  platform: "douyin",
  title: "t",
  hook: "h",
  scenes: [
    { order: 1, text: "开场展示星巴克门店或招牌", durationSeconds: 7, assetHints: [], role: "presenter" },
    { order: 2, text: "展示冰美式制作过程", durationSeconds: 11, assetHints: [], role: "broll" },
    { order: 3, text: "展示优惠到店 CTA", durationSeconds: 7, assetHints: [], role: "presenter" },
  ],
  voiceover: "星巴克今天主推冰美式，门店现做现卖。到店领取本期优惠。",
  captions: [],
  cta: "c",
  generationMode: "template_fallback",
  complianceWarnings: [],
  targetDurationSec: 45,
  createdAt: "2026-08-16T00:00:00.000Z",
};

const project: RenderProject = {
  id: "render_1",
  ownerId: "u",
  storeId: "s",
  scriptDraftId: "script_1",
  selectedAssetIds: ["a1"],
  purpose: "store_traffic",
  aspectRatio: "9:16",
  subtitleStyle: "default",
  targetDurationSec: 45,
  status: "processing",
  createdAt: "2026-08-16T00:00:00.000Z",
  updatedAt: "2026-08-16T00:00:00.000Z",
};

const asset: Asset = {
  id: "a1", ownerId: "u", storeId: "s", type: "video",
  originalFilename: "f.mp4", storageKey: "k", mimeType: "video/mp4",
  sizeBytes: 1, tags: [], businessTags: [], status: "ready",
  createdAt: "2026-08-16T00:00:00.000Z",
};

const talkingHead: VideoOutput = {
  id: "out_th", ownerId: "u", renderProjectId: "render_1",
  storageKey: "avatars/th.mp4", aspectRatio: "9:16", durationSeconds: 50,
  kind: "talking_head", status: "ready", createdAt: "2026-08-16T00:00:00.000Z",
};

function makeDeps(captured: { input?: RenderCompositeInput }): VideoRenderDeps {
  return {
    renderRepository: {
      findProjectById: async () => project,
      findTalkingHeadOutputByProject: async () => talkingHead,
      createOutput: async (o: VideoOutput) => o,
    } as unknown as VideoRenderDeps["renderRepository"],
    scriptRepository: {
      findById: async () => draft,
    } as unknown as VideoRenderDeps["scriptRepository"],
    assetRepository: {
      findById: async (id: string) => (id === "a1" ? asset : null),
    } as unknown as VideoRenderDeps["assetRepository"],
    bgmTrackRepository: {
      findById: async () => null,
    } as unknown as VideoRenderDeps["bgmTrackRepository"],
    probeAssetDuration: async () => 5, // 素材只有 5s
    renderComposite: async (input: RenderCompositeInput) => {
      captured.input = input;
      return { storageKey: "renders/render_1/output.mp4", durationSeconds: input.totalDurationSec };
    },
  };
}

const fakeJob = { data: { projectId: "render_1", ownerId: "u" }, updateProgress: async () => {} } as never;

describe("video_render processor: target duration + voiceover captions", () => {
  it("normalizes the timeline to the project's target duration slot", async () => {
    const captured: { input?: RenderCompositeInput } = {};
    await processVideoRender(fakeJob, makeDeps(captured));
    // 素材仅 5s、目标 45s、TH 50s → 循环复用后总时长 ≈45s（修复前为 ≈20s）
    expect(captured.input?.totalDurationSec).toBeCloseTo(45, 0);
  });

  it("burns subtitles from the voiceover, never from scene descriptions", async () => {
    const captured: { input?: RenderCompositeInput } = {};
    await processVideoRender(fakeJob, makeDeps(captured));
    const ass = captured.input?.assContent ?? "";
    expect(ass).toContain("星巴克今天主推冰美式");
    expect(ass).not.toContain("开场展示星巴克门店或招牌");
    expect(ass).not.toContain("展示冰美式制作过程");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/video-render-processor-captions.test.ts`
Expected: FAIL（total ≈20s 而非 45s；ass 含「开场展示…」）

- [ ] **Step 3: 实现**

`worker/processors/video-render.ts`：

(1) import 块（第 16-24 行）的 video-compose import 加 `buildCaptionCues`：

```ts
import {
  buildAss,
  buildCaptionCues,
  buildFilterGraph,
  buildTimeline,
  resolveCompositionMode,
  resolveSubtitlePreset,
  type CompositionMode,
  type TimelineSegment
} from "@/lib/services/video-compose";
```

(2) `buildTimeline` 调用（139-145 行）加 `targetDurationSec`：

```ts
  const { segments, totalDurationSec } = buildTimeline({
    scenes: draft.scenes,
    assets,
    selectedAssetIds: project.selectedAssetIds,
    assetDurations,
    talkingHeadDurationSec: talkingHead?.durationSeconds,
    targetDurationSec: project.targetDurationSec
  });
```

(3) `renderComposite` 调用的 `assContent`（155 行）改为口播派生；asset_only 无口播不生成字幕：

```ts
  // Subtitles follow the voiceover (Bug 3 fix): presenter mode burns the spoken
  // script; asset_only has no voice track, hence no subtitles at all.
  const captionCues =
    mode === "presenter_broll" ? buildCaptionCues(draft.voiceover, totalDurationSec) : [];

  const { storageKey, durationSeconds } = await deps.renderComposite({
    projectId,
    mode,
    segments,
    assContent: buildAss(captionCues, resolveSubtitlePreset(project.subtitleStyle)),
```

（`assContent` 之后其余字段保持不变。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/video-render-processor-captions.test.ts tests/worker-processors.test.ts tests/video-render-composite.test.ts`
Expected: PASS（三个文件全绿——既有 worker 用例无回归）

- [ ] **Step 5: 提交**

```bash
git add worker/processors/video-render.ts tests/video-render-processor-captions.test.ts
git commit -m "fix(render): wire target duration and voiceover captions into video_render processor"
```

---

### Task 7: 素材全量（B2）— StoryboardConfirm 透传完整勾选集合 + dashboard 接线

**Files:**
- Modify: `components/storyboard-confirm.tsx:12-18,48-58`
- Modify: `components/dashboard.tsx:1340-1350`
- Test: `tests/storyboard-confirm.test.tsx`

- [ ] **Step 1: 改测试（先红）**

`tests/storyboard-confirm.test.tsx`：

(1) `renderConfirm` 的 render 调用加 prop：

```tsx
    <StoryboardConfirm
      draft={draft}
      assets={assets}
      bgmTracks={bgmTracks}
      librarySelectedAssetIds={["asset_a", "asset_b"]}
      onPatch={onPatch}
      onConfirm={onConfirm}
      pending={false}
      {...overrides}
    />,
```

(2) 替换用例「confirms render with selected asset ids derived from scenes」为：

```tsx
  it("confirms render with the FULL library selection, including unmatched assets", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderConfirm();
    await user.click(screen.getByRole("button", { name: /确认渲染/ }));
    await waitFor(() => {
      // asset_b 未被任何分镜匹配，修复前会被丢弃（Bug 2）
      expect(onConfirm).toHaveBeenCalledWith(
        expect.objectContaining({ selectedAssetIds: ["asset_a", "asset_b"] }),
      );
    });
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/storyboard-confirm.test.tsx`
Expected: FAIL（组件尚无 `librarySelectedAssetIds` prop，类型错误 + 断言失败）

- [ ] **Step 3: 实现**

`components/storyboard-confirm.tsx`：

(1) Props 接口加字段：

```ts
interface Props {
  draft: ScriptDraft;
  assets: Asset[];
  bgmTracks: { id: string; name: string; category: string }[];
  /** 素材库完整勾选集合（Bug 2 fix：未匹配分镜的素材也必须进入渲染）。 */
  librarySelectedAssetIds: string[];
  onPatch: (scenes: { order: number; text?: string; matchedAssetId?: string | null }[]) => Promise<void>;
  onConfirm: (selection: { selectedAssetIds: string[]; subtitleStyle: string; bgmTrackId: string }) => Promise<void>;
  pending: boolean;
}
```

(2) 解构加 `librarySelectedAssetIds`：

```ts
export function StoryboardConfirm({ draft, assets, bgmTracks, librarySelectedAssetIds, onPatch, onConfirm, pending }: Props) {
```

(3) `handleConfirm` 中 `selectedAssetIds` 一行替换为：

```ts
    await onPatch(scenes);
    // 渲染素材 = 素材库勾选全集；matchedAssetId 仅作分镜建议位置提示
    await onConfirm({ selectedAssetIds: librarySelectedAssetIds, subtitleStyle, bgmTrackId });
```

`components/dashboard.tsx:1340-1350` — `StoryboardConfirm` 使用处加 prop：

```tsx
          <StoryboardConfirm
            key={storyboardDraft.id}
            draft={storyboardDraft}
            assets={assets}
            bgmTracks={bgmTracks}
            librarySelectedAssetIds={assets.filter((a) => selectedAssetIds.has(a.id)).map((a) => a.id)}
            onPatch={patchStoryboard}
            onConfirm={confirmAndRender}
            pending={pendingAction === "render"}
          />
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/storyboard-confirm.test.tsx && npm run typecheck`
Expected: PASS + 0 errors

- [ ] **Step 5: 提交**

```bash
git add components/storyboard-confirm.tsx components/dashboard.tsx tests/storyboard-confirm.test.tsx
git commit -m "fix(render): render the full library selection instead of matched-only assets"
```

---

### Task 8: 时长档位 30/45/60 默认 45（UI）

**Files:**
- Modify: `components/dashboard.tsx:285,1301-1316`
- Test: `tests/dashboard.test.tsx`

- [ ] **Step 1: 写失败测试**

`tests/dashboard.test.tsx` 的 describe 块内追加：

```tsx
  it("offers 30/45/60s duration slots with 45s selected by default", async () => {
    renderDashboard();
    const slot45 = await screen.findByRole("button", { name: /约45秒/ });
    expect(slot45.className).toContain("selected");
    expect(screen.getByRole("button", { name: /约30秒/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /约60秒/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /约15秒/ })).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/dashboard.test.tsx`
Expected: FAIL（当前为 15/30/60 默认 30，找不到「约45秒」）

- [ ] **Step 3: 实现**

`components/dashboard.tsx:285`：

```ts
  const [targetDuration, setTargetDuration] = useState<number>(45);
```

`components/dashboard.tsx:1302-1306` 选项数组替换为：

```tsx
            {[
              { value: 30, label: "短 · 约30秒" },
              { value: 45, label: "中 · 约45秒" },
              { value: 60, label: "长 · 约60秒" }
            ].map((d) => (
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/dashboard.test.tsx`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add components/dashboard.tsx tests/dashboard.test.tsx
git commit -m "feat(ui): duration slots 30/45/60s with 45s default"
```

---

### Task 9: 全量验证 + 推送

- [ ] **Step 1: 全量测试**

Run: `npm test`
Expected: 全部 PASS（268 + 新增用例）

- [ ] **Step 2: typecheck / lint / prisma validate / build（对齐 CI）**

Run: `npm run typecheck && npm run lint && npx prisma validate && npm run build`
Expected: 全部 0 errors 通过

- [ ] **Step 3: 推送（Zeabur 自动部署）**

```bash
git push origin main
```

- [ ] **Step 4: 向用户报告线上验证清单**

部署完成后请用户在线上验证：
1. 选 30s 档 → 成片时长 ≈30s（素材不足时循环复用铺满）
2. 素材库勾选 5 个 → 成片 5 个全部出现
3. 口播声音与烧录字幕内容一致（都说口播稿）
4. 时长档位显示 30/45/60，默认选中 45

---

## Self-Review 记录

- **Spec 覆盖**：spec §4.1（时长归一化）→ Task 1/2/3/5/6；§4.2（素材全量）→ Task 7；§4.3（字幕=口播）→ Task 4/6；§4.4（档位 UI）→ Task 8；§4.5（测试）→ 各 Task Step 1。✅
- **口播超目标规则**（spec §4.1 末条）→ Task 3 total 公式 `min(TH, target, content)` + 用例「voice wins」。✅
- **asset_only 无字幕**（spec §4.3 末条）→ Task 6 `captionCues` 三元。✅
- **占位符**：无 TBD/TODO；所有代码块完整。✅
- **类型一致性**：`targetDurationSec?: number`（types）↔ `Int?`（prisma）↔ mapper `?? undefined` / `?? null`；`librarySelectedAssetIds: string[]` prop 命名在组件/测试/dashboard 三处一致。✅
