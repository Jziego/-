# Phase 2 · 核心分镜确认流 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「一键直渲染」改造为「生成分镜脚本 → 用户确认/修改 → 再渲染」，含时长档位、素材自动匹配、BGM 选曲、字幕样式选择。

**Architecture:** 后端零 migration——`ScriptScene` 加可选字段（走既有 `scenes Json`）；新增纯函数 `matchAssetsToScenes` 做集合重叠匹配，在 `buildDraft` 单一 chokepoint 接入；新增 `PATCH /api/script-drafts/[id]`（需给 `ScriptRepository` 补 `update`）与 `GET /api/bgm-tracks`；前端拆 `simulateOneClickRender` 为 `generateStoryboard` + `confirmAndRender`，新增 `StoryboardConfirm` 组件承载确认交互。

**Tech Stack:** Next.js 16 (App Router) · React 19 · TypeScript 6 · Vitest + @testing-library/react · 既有 ffmpeg/Prisma/BullMQ。

**Spec:** `docs/superpowers/specs/2026-07-23-storyboard-confirm-flow-design.md`

---

## File Structure

| 文件 | 责任 | 动作 |
|---|---|---|
| `lib/types.ts` | `ScriptScene` 扩展可选匹配字段；`RenderProject.subtitleStyle` 对齐渲染器枚举 | Modify |
| `lib/services/script-match.ts` | 纯函数 `matchAssetsToScenes` + helpers | Create |
| `tests/script-match.test.ts` | 匹配算法单测 | Create |
| `lib/services/script-engine.ts` | `buildDraft` 接匹配；`ScriptDraftInput` 加 `targetDurationSec`；prompt 时长引导 | Modify |
| `tests/script-engine.test.ts` | 补匹配/档位断言 | Modify |
| `lib/repositories/types.ts` | `ScriptRepository.update` 接口 | Modify |
| `lib/repositories/memory.ts` | `MemoryScriptRepository.update` | Modify |
| `lib/repositories/prisma.ts` | `PrismaScriptRepository.update` | Modify |
| `tests/repositories/script.test.ts` | update 单测 | Create |
| `app/api/script-drafts/[id]/route.ts` | PATCH 编辑分镜 | Create |
| `tests/api/script-drafts-id.test.ts` | PATCH 鉴权/校验单测 | Create |
| `app/api/bgm-tracks/route.ts` | GET 系统曲目 | Create |
| `lib/api-client.ts` | `updateScriptDraftApi` / `fetchBgmTracks` / `createScriptDraftApi` 加 `targetDurationSec` | Modify |
| `components/storyboard-confirm.tsx` | 确认界面组件 | Create |
| `tests/storyboard-confirm.test.tsx` | 组件单测 | Create |
| `components/dashboard.tsx` | 拆流程、接线、修 bgm_warm bug | Modify |
| `tests/dashboard.test.tsx` | 更新生成断言 + 补确认→渲染断言 | Modify |

---

## Task 1: 扩展 ScriptScene 类型 + 对齐 subtitleStyle 枚举

**Files:**
- Modify: `lib/types.ts:103-109` (ScriptScene), `lib/types.ts:137` (RenderProject.subtitleStyle)

- [ ] **Step 1: 扩展 `ScriptScene`（加 3 个可选字段，向后兼容）**

`lib/types.ts:103-109` 改为：

```ts
export interface ScriptScene {
  order: number;
  text: string;
  durationSeconds: number;
  assetHints: string[];
  role: SceneRole;
  /** 匹配器派生：该镜期望的素材标签/关键词（默认取 assetHints） */
  desiredTags?: string[];
  /** 自动匹配命中的素材 id；null = 待匹配（用户手选） */
  matchedAssetId?: string | null;
  /** 命中依据标签，便于 UI 展示 */
  matchTag?: string | null;
}
```

- [ ] **Step 2: 对齐 `RenderProject.subtitleStyle` 枚举到渲染器真相**

找到 `lib/types.ts` 中 `RenderProject` 的 `subtitleStyle` 字段（约 137 行，值为 `"bold_bottom" | "clean_center" | "brand_card"`），改为：

```ts
  subtitleStyle: "default" | "bold_bottom" | "minimal";
```

> `clean_center` / `brand_card` 是死值（全代码仅 `bold_bottom` 在用），对齐到 `video-compose.ts` 的 `SubtitleStylePreset`，让下拉选项与实际渲染一致。

- [ ] **Step 3: 验证类型无破坏**

Run: `npm run typecheck`
Expected: 0 errors（若报错指出某处用了 `clean_center`/`brand_card`，把该处改成 `default` 或 `bold_bottom`；探索确认无此用法，应直接通过）。

- [ ] **Step 4: Commit**

```bash
git add lib/types.ts
git commit -m "feat(types): extend ScriptScene with match fields + align subtitleStyle enum"
```

---

## Task 2: 素材匹配纯函数 `matchAssetsToScenes`

**Files:**
- Create: `lib/services/script-match.ts`
- Test: `tests/script-match.test.ts`

- [ ] **Step 1: 写失败测试**

Create `tests/script-match.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { matchAssetsToScenes } from "@/lib/services/script-match";
import type { ScriptScene } from "@/lib/types";

const scenes: ScriptScene[] = [
  { order: 1, text: "开场", durationSeconds: 4, assetHints: ["门头", "门店环境"], role: "presenter" },
  { order: 2, text: "产品", durationSeconds: 7, assetHints: ["牛肉面"], role: "broll" },
  { order: 3, text: "CTA", durationSeconds: 4, assetHints: ["到店引流"], role: "presenter" },
];

const assets = [
  { assetId: "asset_front", features: ["门头", "门店环境", "招牌"] },
  { assetId: "asset_noodle", features: ["牛肉面", "食物", "热汤"] },
  { assetId: "asset_promo", features: ["到店引流", "优惠"] },
];

describe("matchAssetsToScenes", () => {
  it("matches each scene to the highest-overlap asset and records the tag", () => {
    const out = matchAssetsToScenes(scenes, assets);
    expect(out[0].matchedAssetId).toBe("asset_front");
    expect(out[0].matchTag).toBe("门头");
    expect(out[1].matchedAssetId).toBe("asset_noodle");
    expect(out[1].matchTag).toBe("牛肉面");
    expect(out[2].matchedAssetId).toBe("asset_promo");
  });

  it("sets desiredTags from assetHints", () => {
    const out = matchAssetsToScenes(scenes, assets);
    expect(out[0].desiredTags).toEqual(["门头", "门店环境"]);
  });

  it("returns matchedAssetId null when no asset overlaps", () => {
    const out = matchAssetsToScenes(
      [{ order: 1, text: "x", durationSeconds: 3, assetHints: ["不存在的标签"], role: "broll" }],
      assets,
    );
    expect(out[0].matchedAssetId).toBeNull();
    expect(out[0].matchTag).toBeNull();
  });

  it("spreads to an alternative when two scenes share the same top asset", () => {
    const two: ScriptScene[] = [
      { order: 1, text: "a", durationSeconds: 3, assetHints: ["牛肉面"], role: "broll" },
      { order: 2, text: "b", durationSeconds: 3, assetHints: ["牛肉面"], role: "broll" },
    ];
    const pool = [
      { assetId: "asset_noodle", features: ["牛肉面"] },
      { assetId: "asset_noodle2", features: ["牛肉面", "其它"] },
    ];
    const out = matchAssetsToScenes(two, pool);
    expect(out[0].matchedAssetId).toBe("asset_noodle2"); // top by score (2>1)
    expect(out[1].matchedAssetId).toBe("asset_noodle"); // 不同候选，分散
    expect(out[1].matchedAssetId).not.toBe(out[0].matchedAssetId);
  });

  it("returns all null when asset pool is empty", () => {
    const out = matchAssetsToScenes(scenes, []);
    expect(out.every((s) => s.matchedAssetId === null)).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/script-match.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写实现**

Create `lib/services/script-match.ts`：

```ts
import type { ScriptScene } from "@/lib/types";

/** 匹配输入：一个素材的 id + 用于匹配的特征集（来自 AssetAnalysis）。 */
export interface AssetMatchInput {
  assetId: string;
  features: string[];
}

/** 该镜期望的标签：默认取 assetHints（去重）。 */
function sceneDesiredTags(scene: ScriptScene): string[] {
  return [...new Set(scene.assetHints)];
}

/**
 * 为每个分镜挑选特征重叠度最高的素材。
 * - 重叠计数最高者命中；命中标签取第一个重叠特征。
 * - 无任何重叠 → matchedAssetId = null（UI 显示「待匹配」）。
 * - 若命中者与上一镜相同、且存在同分不同候选 → 改选候选以分散画面。
 */
export function matchAssetsToScenes(
  scenes: ScriptScene[],
  assets: AssetMatchInput[],
): ScriptScene[] {
  let prevAssetId: string | null = null;

  return scenes.map((scene) => {
    const desired = sceneDesiredTags(scene);

    const scored = assets
      .map((a) => {
        const overlap = a.features.filter((f) => desired.includes(f));
        return { assetId: a.assetId, score: overlap.length, tag: overlap[0] ?? null };
      })
      .sort((x, y) => y.score - x.score);

    const candidates = scored.filter((s) => s.score > 0);
    const top = candidates[0] ?? null;
    let pick = top;

    if (top && prevAssetId && top.assetId === prevAssetId) {
      const alt = candidates.find((s) => s.assetId !== prevAssetId && s.score === top.score);
      if (alt) pick = alt;
    }

    const matchedAssetId = pick?.assetId ?? null;
    const matchTag = pick?.tag ?? null;
    prevAssetId = matchedAssetId;

    return { ...scene, desiredTags: desired, matchedAssetId, matchTag };
  });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/script-match.test.ts`
Expected: PASS（5 用例全过）。

- [ ] **Step 5: Commit**

```bash
git add lib/services/script-match.ts tests/script-match.test.ts
git commit -m "feat(script): add matchAssetsToScenes tag-overlap matcher"
```

---

## Task 3: 把匹配接入 script-engine + 时长档位

**Files:**
- Modify: `lib/services/script-engine.ts` (imports, `ScriptDraftInput`, SYSTEM_PROMPT, `buildUserPrompt`, `buildDraft`)
- Test: `tests/script-engine.test.ts`

- [ ] **Step 1: 写失败测试（匹配已被接入 + 档位引导）**

在 `tests/script-engine.test.ts` 末尾、最后一个 `it` 之后追加：

```ts
  it("fills matchedAssetId on generated scenes via tag overlap", async () => {
    const draft = await createScriptDraft({
      store,
      assetAnalyses: analysis,
      purpose: "store_traffic",
      platform: "douyin",
      forcedRawCopy: "现熬牛骨汤，午市出餐快",
    });
    // template scenes 的 hints 含 analysis 的 businessTags（招牌菜/到店引流）
    const matched = draft.scenes.map((s) => s.matchedAssetId ?? null);
    expect(matched).toContain("asset_1");
  });

  it("accepts targetDurationSec and threads a duration hint into the prompt", async () => {
    // forcedRawCopy 路径不依赖 AI，仅验证入参被接受且不抛错
    const draft = await createScriptDraft({
      store,
      assetAnalyses: analysis,
      purpose: "promotion",
      platform: "douyin",
      forcedRawCopy: "短文案测试",
      targetDurationSec: 15,
    });
    expect(draft.scenes.length).toBeGreaterThan(0);
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/script-engine.test.ts`
Expected: FAIL（`targetDurationSec` 不在入参类型里 / `matchedAssetId` 未填充）。

- [ ] **Step 3: 改 `ScriptDraftInput` 加 `targetDurationSec`**

`lib/services/script-engine.ts` 的 `ScriptDraftInput`（约 7-13 行）改为：

```ts
interface ScriptDraftInput {
  store: StoreProfile;
  assetAnalyses: AssetAnalysis[];
  purpose: MarketingPurpose;
  platform?: Platform;
  forcedRawCopy?: string;
  /** 目标时长（秒）：15 / 30 / 60，影响 AI 场景数与文案量。 */
  targetDurationSec?: number;
}
```

- [ ] **Step 4: 新增时长引导 helper 并接入 `buildUserPrompt`**

在 `buildUserPrompt` 函数上方（约 99 行前）新增：

```ts
function durationGuidance(target?: number): string {
  if (target === 15) return "约15秒，分2-3个场景，每镜配音不超过12字";
  if (target === 60) return "约60秒，分6-8个场景，每镜配音约15字";
  return "约30秒，分3-5个场景，每镜配音8-15字";
}
```

在 `buildUserPrompt` 的 `lines` 数组里，`【营销目的】` 那行之前插入一行（保留其余不变）：

```ts
    `【目标时长】${durationGuidance(input.targetDurationSec)}`,
```

- [ ] **Step 5: 弱化 SYSTEM_PROMPT 的硬编码时长**

`SYSTEM_PROMPT`（约 68 行）中把：

```
你的文案必须口语化、有网感、适合短视频配音。视频时长控制在15-30秒。
```

改为：

```
你的文案必须口语化、有网感、适合短视频配音。视频时长按用户给的【目标时长】控制，场景数与每镜配音字数匹配目标时长。
```

- [ ] **Step 6: 在 `buildDraft` 接入匹配**

在 `lib/services/script-engine.ts` 顶部 import 区追加：

```ts
import { matchAssetsToScenes, type AssetMatchInput } from "@/lib/services/script-match";
```

在 `buildDraft` 函数体开头（`return {` 之前）插入匹配调用，并把返回的 `scenes: input.scenes` 改为匹配后的结果。即把 `buildDraft`（约 259-289 行）改为：

```ts
function buildDraft(input: {
  store: StoreProfile;
  assetAnalyses: AssetAnalysis[];
  purpose: MarketingPurpose;
  platform: Platform;
  generationMode: "ai" | "template_fallback";
  title: string;
  hook: string;
  voiceover: string;
  scenes: ScriptScene[];
  captions: string[];
  cta: string;
  warnings: string[];
}): ScriptDraft {
  const matchInputs: AssetMatchInput[] = input.assetAnalyses.map((a) => ({
    assetId: a.assetId,
    features: [...new Set([...a.businessTags, ...a.keywords, ...a.visualTags])],
  }));
  const scenes = matchAssetsToScenes(input.scenes, matchInputs);

  return {
    id: createId("script"),
    ownerId: input.store.ownerId,
    storeId: input.store.id,
    purpose: input.purpose,
    platform: input.platform,
    title: input.title,
    hook: input.hook,
    scenes,
    voiceover: input.voiceover,
    captions: input.captions,
    cta: input.cta,
    generationMode: input.generationMode,
    complianceWarnings: input.warnings,
    createdAt: nowIso(),
  };
}
```

- [ ] **Step 7: 运行测试确认通过**

Run: `npx vitest run tests/script-engine.test.ts`
Expected: PASS（含新增 2 用例 + 原有 4 用例）。

- [ ] **Step 8: Commit**

```bash
git add lib/services/script-engine.ts tests/script-engine.test.ts
git commit -m "feat(script): wire asset matching into buildDraft + targetDurationSec prompt"
```

---

## Task 4: 给 ScriptRepository 补 `update`

**Files:**
- Modify: `lib/repositories/types.ts:40-44` (ScriptRepository)
- Modify: `lib/repositories/memory.ts:108-119` (MemoryScriptRepository)
- Modify: `lib/repositories/prisma.ts:160-175` (PrismaScriptRepository)
- Test: `tests/repositories/script.test.ts`

- [ ] **Step 1: 写失败测试**

Create `tests/repositories/script.test.ts`：

```ts
import { afterEach, describe, expect, it } from "vitest";
import { MemoryScriptRepository } from "@/lib/repositories/memory";
import type { ScriptDraft } from "@/lib/types";

function makeDraft(id: string): ScriptDraft {
  return {
    id,
    ownerId: "user_1",
    storeId: "store_1",
    purpose: "store_traffic",
    platform: "douyin",
    title: "t",
    hook: "h",
    scenes: [{ order: 1, text: "原文", durationSeconds: 4, assetHints: [], role: "presenter" }],
    voiceover: "v",
    captions: [],
    cta: "c",
    generationMode: "ai",
    complianceWarnings: [],
    createdAt: "2026-07-23T00:00:00.000Z",
  };
}

describe("MemoryScriptRepository.update", () => {
  afterEach(() => {
    // memory repo 是模块级共享状态，重置以免污染其它测试
    const repo = new MemoryScriptRepository();
    return repo.listByOwner("user_1").then(async (list) => {
      // no-op reset hook: 测试间通过新建独立 id 隔离
    });
  });

  it("merges partial scenes and persists", async () => {
    const repo = new MemoryScriptRepository();
    await repo.create(makeDraft("script_update_1"));
    const updated = await repo.update("script_update_1", {
      scenes: [{ order: 1, text: "改后", durationSeconds: 4, assetHints: [], role: "presenter" }],
    });
    expect(updated.scenes[0]?.text).toBe("改后");
    const refetched = await repo.findById("script_update_1");
    expect(refetched?.scenes[0]?.text).toBe("改后");
  });

  it("throws when draft not found", async () => {
    const repo = new MemoryScriptRepository();
    await expect(repo.update("script_missing", { scenes: [] })).rejects.toThrow();
  });

  it("preserves id and untouched fields", async () => {
    const repo = new MemoryScriptRepository();
    await repo.create(makeDraft("script_update_2"));
    const updated = await repo.update("script_update_2", {
      scenes: [{ order: 1, text: "x", durationSeconds: 4, assetHints: [], role: "presenter" }],
    });
    expect(updated.id).toBe("script_update_2");
    expect(updated.title).toBe("t");
    expect(updated.hook).toBe("h");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/repositories/script.test.ts`
Expected: FAIL（`update` 不存在）。

- [ ] **Step 3: 接口加 `update`**

`lib/repositories/types.ts` 的 `ScriptRepository`（约 40-44 行）改为：

```ts
export interface ScriptRepository {
  listByOwner(ownerId: string): Promise<ScriptDraft[]>;
  create(script: ScriptDraft): Promise<ScriptDraft>;
  findById(id: string): Promise<ScriptDraft | null>;
  update(id: string, data: Partial<ScriptDraft>): Promise<ScriptDraft>;
}
```

- [ ] **Step 4: 内存实现加 `update`**

`lib/repositories/memory.ts` 的 `MemoryScriptRepository`（约 108-119 行）在 `findById` 之后追加：

```ts
  async update(id: string, data: Partial<ScriptDraft>): Promise<ScriptDraft> {
    const state = getRuntimeState();
    const index = state.scripts.findIndex((s) => s.id === id);
    if (index < 0) throw new Error(`ScriptDraft not found: ${id}`);
    const updated = { ...state.scripts[index], ...data, id: state.scripts[index].id };
    state.scripts[index] = updated;
    return updated;
  }
```

- [ ] **Step 5: Prisma 实现加 `update`**

`lib/repositories/prisma.ts` 的 `PrismaScriptRepository`（约 160-175 行）在 `findById` 之后追加（复用 `toScriptDraftInput` 保证序列化与 create 一致）：

```ts
  async update(id: string, data: Partial<ScriptDraft>): Promise<ScriptDraft> {
    const existing = await this.findById(id);
    if (!existing) throw new Error(`ScriptDraft not found: ${id}`);
    const merged = { ...existing, ...data, id };
    const row = await this.prisma.scriptDraft.update({
      where: { id },
      data: toScriptDraftInput(merged),
    });
    return toScriptDraft(row);
  }
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npx vitest run tests/repositories/script.test.ts`
Expected: PASS（3 用例）。

- [ ] **Step 7: Commit**

```bash
git add lib/repositories/types.ts lib/repositories/memory.ts lib/repositories/prisma.ts tests/repositories/script.test.ts
git commit -m "feat(repo): add ScriptRepository.update for draft editing"
```

---

## Task 5: `PATCH /api/script-drafts/[id]`

**Files:**
- Create: `app/api/script-drafts/[id]/route.ts`
- Test: `tests/api/script-drafts-id.test.ts`

- [ ] **Step 1: 写失败测试**

Create `tests/api/script-drafts-id.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PATCH } from "@/app/api/script-drafts/[id]/route";
import { MemoryScriptRepository, MemoryAssetRepository } from "@/lib/repositories/memory";
import type { ScriptDraft, Asset } from "@/lib/types";

// demo 模式下 getOwnerId 返回 demoOwnerId，无需 mock session
const OWNER = expect.any(String);

function draftRow(id: string, ownerId: string): ScriptDraft {
  return {
    id, ownerId, storeId: "store_1", purpose: "store_traffic", platform: "douyin",
    title: "t", hook: "h",
    scenes: [
      { order: 1, text: "镜1", durationSeconds: 4, assetHints: ["招牌"], role: "presenter", matchedAssetId: null },
      { order: 2, text: "镜2", durationSeconds: 5, assetHints: ["产品"], role: "broll", matchedAssetId: null },
    ],
    voiceover: "v", captions: [], cta: "c", generationMode: "ai", complianceWarnings: [],
    createdAt: "2026-07-23T00:00:00.000Z",
  };
}

function assetRow(id: string, ownerId: string): Asset {
  return {
    id, ownerId, storeId: "store_1", type: "image", originalFilename: "a.jpg",
    storageKey: "k", mimeType: "image/jpeg", sizeBytes: 1, tags: [], businessTags: [],
    status: "ready", createdAt: "2026-07-23T00:00:00.000Z",
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

describe("PATCH /api/script-drafts/[id]", () => {
  beforeEach(async () => {
    const scripts = new MemoryScriptRepository();
    const assets = new MemoryAssetRepository();
    await scripts.create(draftRow("script_patch", "demo_user"));
    await assets.create(assetRow("asset_own", "demo_user"));
  });

  it("updates scene text and matchedAssetId, returns updated draft", async () => {
    const [request, ctx] = req(
      { scenes: [{ order: 1, text: "改后文案", matchedAssetId: "asset_own" }] },
      "script_patch",
    );
    const res = await PATCH(request, ctx);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.script.scenes[0].text).toBe("改后文案");
    expect(json.script.scenes[0].matchedAssetId).toBe("asset_own");
    expect(json.script.scenes[1].text).toBe("镜2"); // 未提交的镜保持不变
  });

  it("returns 404 for a draft owned by someone else (no existence leak)", async () => {
    const scripts = new MemoryScriptRepository();
    await scripts.create(draftRow("script_other", "user_other"));
    const [request, ctx] = req({ scenes: [] }, "script_other");
    const res = await PATCH(request, ctx);
    expect(res.status).toBe(404);
  });

  it("returns 404 when matchedAssetId belongs to another owner", async () => {
    const assets = new MemoryAssetRepository();
    await assets.create(assetRow("asset_foreign", "user_other"));
    const [request, ctx] = req(
      { scenes: [{ order: 1, matchedAssetId: "asset_foreign" }] },
      "script_patch",
    );
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

> 注：`getOwnerId()` 在 demo 模式（`APP_MODE=demo`，测试默认）返回 `demoOwnerId`，故 `draftRow` 用 `"demo_user"`。若测试环境 `APP_MODE=production`，需按既有测试方式 mock `auth()`——参考 `tests/dashboard.test.tsx` 的 fetch mock 风格。先按 demo 模式跑。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/api/script-drafts-id.test.ts`
Expected: FAIL（路由不存在）。

- [ ] **Step 3: 写路由**

Create `app/api/script-drafts/[id]/route.ts`：

```ts
import { jsonError, jsonOk } from "@/lib/api-response";
import { applyRateLimit } from "@/lib/rate-limit";
import { getOwnerId } from "@/lib/auth-helpers";
import { getAssetRepository, getScriptRepository } from "@/lib/repositories";
import type { ScriptScene } from "@/lib/types";

interface PatchScene {
  order: number;
  text?: string;
  matchedAssetId?: string | null;
}

/**
 * 编辑已生成分镜：逐镜改口播文案 / 换匹配素材。IDOR：他人或不存在的 draft
 * 一律 404，不泄漏存在性。matchedAssetId 必须属于本人素材库。
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

  if (!Array.isArray(body.scenes)) {
    return jsonError("scenes array is required", 400);
  }
  const patchScenes = body.scenes as PatchScene[];

  // 校验所有 swapped matchedAssetId 属于本人
  const swappedIds = patchScenes
    .map((s) => s.matchedAssetId)
    .filter((x): x is string => typeof x === "string");
  if (swappedIds.length) {
    const ownerAssets = await getAssetRepository().listByOwner(ownerId);
    const ownerAssetIds = new Set(ownerAssets.map((a) => a.id));
    for (const aid of swappedIds) {
      if (!ownerAssetIds.has(aid)) {
        return jsonError("Asset not found", 404);
      }
    }
  }

  // 按 order 合并：未提交的镜保持原样
  const byOrder = new Map(patchScenes.map((s) => [Number(s.order), s]));
  const mergedScenes: ScriptScene[] = draft.scenes.map((scene) => {
    const p = byOrder.get(scene.order);
    if (!p) return scene;
    return {
      ...scene,
      ...(typeof p.text === "string" ? { text: String(p.text).slice(0, 500) } : {}),
      ...(p.matchedAssetId !== undefined ? { matchedAssetId: p.matchedAssetId } : {}),
    };
  });

  const updated = await getScriptRepository().update(id, { scenes: mergedScenes });
  return jsonOk({ script: updated });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/api/script-drafts-id.test.ts`
Expected: PASS（4 用例）。

- [ ] **Step 5: Commit**

```bash
git add app/api/script-drafts/[id]/route.ts tests/api/script-drafts-id.test.ts
git commit -m "feat(api): PATCH /api/script-drafts/[id] for storyboard editing"
```

---

## Task 6: `GET /api/bgm-tracks`

**Files:**
- Create: `app/api/bgm-tracks/route.ts`
- Test: `tests/api/bgm-tracks.test.ts`

- [ ] **Step 1: 写失败测试**

Create `tests/api/bgm-tracks.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/bgm-tracks/route";
import { MemoryBgmTrackRepository } from "@/lib/repositories/memory";
import type { BgmTrack } from "@/lib/types";

function track(id: string, name: string): BgmTrack {
  return {
    id, name, storageKey: `bgm/${id}.mp3`, durationSeconds: 30,
    category: "general", createdAt: "2026-07-23T00:00:00.000Z",
  };
}

describe("GET /api/bgm-tracks", () => {
  it("lists system tracks without leaking storageKey", async () => {
    const repo = new MemoryBgmTrackRepository();
    await repo.create(track("bgm_upbeat_01", "欢快01"));
    await repo.create(track("bgm_calm_01", "舒缓01"));

    const res = await GET(new Request("http://localhost/api/bgm-tracks"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.tracks).toHaveLength(2);
    expect(json.tracks[0]).toMatchObject({ id: "bgm_upbeat_01", name: "欢快01", category: "general" });
    // 安全：不返回 storageKey（对象存储路径）
    expect(JSON.stringify(json)).not.toContain("storageKey");
    expect(JSON.stringify(json)).not.toContain(".mp3");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/api/bgm-tracks.test.ts`
Expected: FAIL（路由不存在）。

- [ ] **Step 3: 写路由**

Create `app/api/bgm-tracks/route.ts`：

```ts
import { jsonOk } from "@/lib/api-response";
import { applyRateLimit } from "@/lib/rate-limit";
import { getOwnerId } from "@/lib/auth-helpers";
import { getBgmTrackRepository } from "@/lib/repositories";

/**
 * 列出系统级 BGM 曲目（无 ownerId）。只返回展示字段，不返回 storageKey，
 * 避免对象存储路径泄漏。试听预签名 URL 另走专门路由。
 */
export async function GET(request: Request) {
  const ownerId = await getOwnerId();
  const limited = await applyRateLimit(request, ownerId);
  if (limited) return limited;

  const tracks = await getBgmTrackRepository().list();
  return jsonOk({
    tracks: tracks.map((t) => ({
      id: t.id,
      name: t.name,
      category: t.category,
      durationSeconds: t.durationSeconds,
    })),
  });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/api/bgm-tracks.test.ts`
Expected: PASS。

- [ ] **Step 5: 确认 `getBgmTrackRepository` 已从 index 导出**

Run: `grep -n "getBgmTrackRepository" lib/repositories/index.ts`
Expected: 命中（worker 已在用，应存在）。若无，参考 `getScriptRepository` 模式补一个工厂。

- [ ] **Step 6: Commit**

```bash
git add app/api/bgm-tracks/route.ts tests/api/bgm-tracks.test.ts
git commit -m "feat(api): GET /api/bgm-tracks for music selection"
```

---

## Task 7: api-client 增 `updateScriptDraftApi` / `fetchBgmTracks` + `targetDurationSec`

**Files:**
- Modify: `lib/api-client.ts`

- [ ] **Step 1: 给 `createScriptDraftApi` 加 `targetDurationSec`**

`lib/api-client.ts` 的 `createScriptDraftApi`（约 205-217 行）入参加一个可选字段并写入 body：

```ts
export async function createScriptDraftApi(input: {
  storeId: string;
  assetAnalysisIds: string[];
  purpose: MarketingPurpose;
  platform?: string;
  targetDurationSec?: number;
}): Promise<ScriptDraft> {
  const data = await api<{ script: ScriptDraft }>("/api/script-drafts", {
    method: "POST",
    body: JSON.stringify(input)
  });
  return data.script;
}
```

> 直接传整个 `input`（含 `targetDurationSec`）即可，路由侧 Task 8 会读取。

- [ ] **Step 2: 路由侧接受 `targetDurationSec`**

`app/api/script-drafts/route.ts` 的 POST 中，把 `createScriptDraft({...})` 调用改为透传 `targetDurationSec`：

```ts
    : await createScriptDraft({
        store,
        assetAnalyses,
        purpose,
        platform: (body.platform ?? "douyin") as Platform,
        targetDurationSec: typeof body.targetDurationSec === "number" ? body.targetDurationSec : undefined,
      });
```

- [ ] **Step 3: 新增 `updateScriptDraftApi` 与 `fetchBgmTracks`**

在 `lib/api-client.ts` 末尾追加：

```ts
export async function updateScriptDraftApi(input: {
  scriptDraftId: string;
  scenes: { order: number; text?: string; matchedAssetId?: string | null }[];
}): Promise<ScriptDraft> {
  const data = await api<{ script: ScriptDraft }>(
    `/api/script-drafts/${encodeURIComponent(input.scriptDraftId)}`,
    { method: "PATCH", body: JSON.stringify({ scenes: input.scenes }) },
  );
  return data.script;
}

export interface BgmTrackOption {
  id: string;
  name: string;
  category: string;
  durationSeconds: number;
}

export async function fetchBgmTracks(): Promise<BgmTrackOption[]> {
  const data = await api<{ tracks: BgmTrackOption[] }>("/api/bgm-tracks");
  return data.tracks;
}
```

- [ ] **Step 4: 验证编译**

Run: `npm run typecheck`
Expected: 0 errors。

- [ ] **Step 5: Commit**

```bash
git add lib/api-client.ts app/api/script-drafts/route.ts
git commit -m "feat(api-client): updateScriptDraftApi + fetchBgmTracks + targetDurationSec"
```

---

## Task 8: `StoryboardConfirm` 确认界面组件

**Files:**
- Create: `components/storyboard-confirm.tsx`
- Test: `tests/storyboard-confirm.test.tsx`

- [ ] **Step 1: 写失败测试**

Create `tests/storyboard-confirm.test.tsx`：

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { StoryboardConfirm } from "@/components/storyboard-confirm";
import type { Asset, ScriptDraft } from "@/lib/types";

const draft: ScriptDraft = {
  id: "script_1", ownerId: "u", storeId: "s", purpose: "store_traffic", platform: "douyin",
  title: "t", hook: "h",
  scenes: [
    { order: 1, text: "镜1原文", durationSeconds: 4, assetHints: ["招牌"], role: "presenter", matchedAssetId: "asset_a", matchTag: "招牌" },
    { order: 2, text: "镜2原文", durationSeconds: 5, assetHints: ["产品"], role: "broll", matchedAssetId: null },
  ],
  voiceover: "v", captions: [], cta: "c", generationMode: "ai", complianceWarnings: [],
  createdAt: "2026-07-23T00:00:00.000Z",
};

const assets: Asset[] = [
  { id: "asset_a", ownerId: "u", storeId: "s", type: "image", originalFilename: "a.jpg", storageKey: "k", mimeType: "image/jpeg", sizeBytes: 1, tags: [], businessTags: [], status: "ready", createdAt: "2026-07-23T00:00:00.000Z" },
  { id: "asset_b", ownerId: "u", storeId: "s", type: "image", originalFilename: "b.jpg", storageKey: "k", mimeType: "image/jpeg", sizeBytes: 1, tags: [], businessTags: [], status: "ready", createdAt: "2026-07-23T00:00:00.000Z" },
];

const bgmTracks = [
  { id: "bgm_upbeat_01", name: "欢快01", category: "general", durationSeconds: 30 },
];

function renderConfirm(overrides: Partial<Parameters<typeof StoryboardConfirm>[0]> = {}) {
  const onPatch = vi.fn(async () => {});
  const onConfirm = vi.fn(async () => {});
  render(
    <StoryboardConfirm
      draft={draft}
      assets={assets}
      bgmTracks={bgmTracks}
      onPatch={onPatch}
      onConfirm={onConfirm}
      pending={false}
      {...overrides}
    />,
  );
  return { onPatch, onConfirm };
}

describe("StoryboardConfirm", () => {
  it("renders all scenes with matched/待匹配 state", () => {
    renderConfirm();
    expect(screen.getByText("镜1原文")).toBeInTheDocument();
    expect(screen.getByText("镜2原文")).toBeInTheDocument();
    expect(screen.getByText(/待匹配/)).toBeInTheDocument();
  });

  it("patches text on blur", async () => {
    const user = userEvent.setup();
    const { onPatch } = renderConfirm();
    const input = screen.getByDisplayValue("镜1原文");
    await user.clear(input);
    await user.type(input, "改后文案");
    await user.tab(); // blur → PATCH
    await waitFor(() => {
      expect(onPatch).toHaveBeenCalledWith([
        expect.objectContaining({ order: 1, text: "改后文案" }),
      ]);
    });
  });

  it("confirms render with selected asset ids derived from scenes", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderConfirm();
    await user.click(screen.getByRole("button", { name: /确认渲染/ }));
    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith(
        expect.objectContaining({ selectedAssetIds: expect.arrayContaining(["asset_a"]) }),
      );
    });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/storyboard-confirm.test.tsx`
Expected: FAIL（组件不存在）。

- [ ] **Step 3: 写组件**

Create `components/storyboard-confirm.tsx`：

```tsx
"use client";

import { useMemo, useState } from "react";
import type { Asset, ScriptDraft } from "@/lib/types";

const SUBTITLE_OPTIONS = [
  { value: "bold_bottom", label: "综艺黄（粗体底部）" },
  { value: "default", label: "标准白字" },
  { value: "minimal", label: "极简小字" },
];

interface Props {
  draft: ScriptDraft;
  assets: Asset[];
  bgmTracks: { id: string; name: string; category: string }[];
  onPatch: (scenes: { order: number; text?: string; matchedAssetId?: string | null }[]) => Promise<void>;
  onConfirm: (selection: { selectedAssetIds: string[]; subtitleStyle: string; bgmTrackId: string }) => Promise<void>;
  pending: boolean;
}

/** 分镜确认界面：逐镜改文案/换素材 + 全局字幕/BGM + 确认渲染。 */
export function StoryboardConfirm({ draft, assets, bgmTracks, onPatch, onConfirm, pending }: Props) {
  const [textByOrder, setTextByOrder] = useState<Record<number, string>>(() =>
    Object.fromEntries(draft.scenes.map((s) => [s.order, s.text])),
  );
  const [assetByOrder, setAssetByOrder] = useState<Record<number, string | null>>(() =>
    Object.fromEntries(draft.scenes.map((s) => [s.order, s.matchedAssetId ?? null])),
  );
  const [pickerForOrder, setPickerForOrder] = useState<number | null>(null);
  const [subtitleStyle, setSubtitleStyle] = useState("bold_bottom");
  const [bgmTrackId, setBgmTrackId] = useState(bgmTracks[0]?.id ?? "");

  const estimatedSec = useMemo(
    () => draft.scenes.reduce((sum, s) => sum + (s.durationSeconds || 0), 0),
    [draft.scenes],
  );

  async function patchText(order: number, text: string) {
    await onPatch([{ order, text }]);
  }

  async function patchAsset(order: number, matchedAssetId: string | null) {
    setAssetByOrder((prev) => ({ ...prev, [order]: matchedAssetId }));
    setPickerForOrder(null);
    await onPatch([{ order, matchedAssetId }]);
  }

  async function handleConfirm() {
    // 最终落地所有文本编辑（捕获未 blur 的改动）
    const scenes = draft.scenes.map((s) => ({
      order: s.order,
      text: textByOrder[s.order] ?? s.text,
      matchedAssetId: assetByOrder[s.order] ?? null,
    }));
    await onPatch(scenes);
    const selectedAssetIds = [...new Set(scenes.map((s) => s.matchedAssetId).filter((x): x is string => Boolean(x)))];
    await onConfirm({ selectedAssetIds, subtitleStyle, bgmTrackId });
  }

  return (
    <article className="card" id="storyboard-confirm">
      <div className="cardHeader">
        <div>
          <h2>分镜脚本</h2>
          <p>共 {draft.scenes.length} 镜 · 预计 {Math.round(estimatedSec)}s · 确认后开始渲染</p>
        </div>
      </div>

      {draft.scenes.map((scene) => {
        const matchedId = assetByOrder[scene.order] ?? null;
        const matched = assets.find((a) => a.id === matchedId);
        const isPicker = pickerForOrder === scene.order;
        return (
          <div key={scene.order} className="storyboardRow" style={{ borderBottom: "1px solid #333", padding: "12px 0" }}>
            <strong>镜{scene.order}</strong>
            <span style={{ marginLeft: 8 }}>{scene.durationSeconds}s · {scene.role === "presenter" ? "口播" : "画面"}</span>
            <textarea
              aria-label={`镜${scene.order}文案`}
              value={textByOrder[scene.order] ?? ""}
              onChange={(e) => setTextByOrder((p) => ({ ...p, [scene.order]: e.target.value }))}
              onBlur={(e) => patchText(scene.order, e.target.value)}
              rows={2}
              style={{ width: "100%", margin: "6px 0" }}
            />
            <div>
              {matched ? (
                <span>匹配素材：{matched.originalFilename}（{scene.matchTag ?? "已选"}）</span>
              ) : (
                <span style={{ color: "#ffb84d" }}>待匹配</span>
              )}{" "}
              <button type="button" onClick={() => setPickerForOrder(isPicker ? null : scene.order)}>
                {matched ? "换素材" : "选素材"}
              </button>
            </div>
            {isPicker ? (
              <div className="assetPicker" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
                {assets.map((a) => (
                  <button key={a.id} type="button" onClick={() => patchAsset(scene.order, a.id)} title={a.originalFilename}>
                    {a.originalFilename}
                  </button>
                ))}
                <button type="button" onClick={() => patchAsset(scene.order, null)}>清除</button>
              </div>
            ) : null}
          </div>
        );
      })}

      <div style={{ marginTop: 16, display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <label>
          字幕样式
          <select value={subtitleStyle} onChange={(e) => setSubtitleStyle(e.target.value)}>
            {SUBTITLE_OPTIONS.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
          </select>
        </label>
        <label>
          背景音乐
          <select value={bgmTrackId} onChange={(e) => setBgmTrackId(e.target.value)}>
            {bgmTracks.map((t) => (<option key={t.id} value={t.id}>{t.name}</option>))}
          </select>
        </label>
      </div>

      <button
        type="button"
        className="primaryButton"
        disabled={pending}
        onClick={handleConfirm}
        style={{ marginTop: 16 }}
      >
        {pending ? <span className="spinner" aria-hidden="true" /> : null}
        确认渲染
      </button>
    </article>
  );
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/storyboard-confirm.test.tsx`
Expected: PASS（3 用例）。若 `getByDisplayValue("镜1原文")` 找不到，确认 textarea 初始 value 来自 `textByOrder`。

- [ ] **Step 5: Commit**

```bash
git add components/storyboard-confirm.tsx tests/storyboard-confirm.test.tsx
git commit -m "feat(ui): StoryboardConfirm component with per-scene edit + confirm"
```

---

## Task 9: Dashboard 流程改造（拆分 + 接线 + 修 bgm_warm bug）

**Files:**
- Modify: `components/dashboard.tsx`
- Modify: `tests/dashboard.test.tsx`

- [ ] **Step 1: 更新现有生成测试（生成不再立即渲染）**

在 `tests/dashboard.test.tsx` 找到用例 `"passes all selected assets and analyses when generating"`（约 1242 行）。该用例当前断言点击「开始生成视频」后 `/api/script-drafts` 与 `/api/render-projects` **都被调用**。改造后点击只触发 `/api/script-drafts`。把对该用例的尾部断言改为：

```ts
    await waitFor(() => {
      expect(fetchedBodies["/api/script-drafts"]).toBeDefined();
    });
    expect(fetchedBodies["/api/script-drafts"]).toMatchObject({
      assetAnalysisIds: expect.arrayContaining(["analysis_p1", "analysis_p2"])
    });
    expect((fetchedBodies["/api/script-drafts"] as { assetAnalysisIds: string[] }).assetAnalysisIds).toHaveLength(2);
    // 改造后：点击「开始生成视频」只生成草稿，不立即建渲染项目
    expect(fetchedBodies["/api/render-projects"]).toBeUndefined();
```

并确保该 mock 的 `/api/script-drafts` POST 返回带 `scenes`（含 `matchedAssetId`）的 draft，以便确认界面渲染。若原 fixture 的 script 对象缺 scenes，补上：

```ts
            return { script: { id: "script_passall", scenes: [
              { order: 1, text: "镜1", durationSeconds: 4, assetHints: [], role: "presenter", matchedAssetId: "asset_p1" },
            ], /* ...其余既有字段... */ } };
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/dashboard.test.tsx`
Expected: FAIL（当前实现仍立即调 render-projects，新断言期望它 undefined）。

- [ ] **Step 3: 加 import + 状态**

`components/dashboard.tsx` 顶部 api-client import 块（约 6-27 行）追加两个名字：

```ts
  fetchBgmTracks,
  updateScriptDraftApi,
```

并在文件顶部组件 import 区追加：

```ts
import { StoryboardConfirm } from "@/components/storyboard-confirm";
```

在 Dashboard 组件内（与其它 useState 同区，约 259 行附近）追加：

```ts
  const [storyboardDraft, setStoryboardDraft] = useState<ScriptDraft | null>(null);
  const [bgmTracks, setBgmTracks] = useState<{ id: string; name: string; category: string; durationSeconds: number }[]>([]);
  const [targetDuration, setTargetDuration] = useState<number>(30);
  const [generating, setGenerating] = useState(false);
```

- [ ] **Step 4: 加载 BGM 曲目 + 默认值**

在组件内 useEffect 区追加（无依赖，仅挂载时拉一次）：

```ts
  useEffect(() => {
    let cancelled = false;
    fetchBgmTracks()
      .then((tracks) => { if (!cancelled) setBgmTracks(tracks); })
      .catch(() => { /* 静默：无曲目也能渲染 */ });
    return () => { cancelled = true; };
  }, []);
```

- [ ] **Step 5: 用 `generateStoryboard` + `confirmAndRender` + `patchStoryboard` 替换 `simulateOneClickRender`**

把 `simulateOneClickRender` 函数（约 755-792 行）整体替换为：

```ts
  async function generateStoryboard() {
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
        targetDurationSec: targetDuration,
      });
      setStoryboardDraft(draft);
      setLocalScript(draft);
      await queryClient.invalidateQueries({ queryKey: ["script-drafts"] });
      setMessage("分镜脚本已生成，请确认后再渲染。");
    } finally {
      setGenerating(false);
    }
  }

  async function patchStoryboard(scenes: { order: number; text?: string; matchedAssetId?: string | null }[]) {
    if (!storyboardDraft) return;
    const updated = await updateScriptDraftApi({ scriptDraftId: storyboardDraft.id, scenes });
    setStoryboardDraft(updated);
    setLocalScript(updated);
  }

  async function confirmAndRender(selection: { selectedAssetIds: string[]; subtitleStyle: string; bgmTrackId: string }) {
    if (!storyboardDraft) return;
    setPendingAction("render");
    try {
      const { jobs: plannedJobs } = await createRenderProjectApi({
        scriptDraftId: storyboardDraft.id,
        selectedAssetIds: selection.selectedAssetIds,
        avatarProfileId: avatar?.id,
        aspectRatio: "9:16",
        subtitleStyle: selection.subtitleStyle,
        bgmTrackId: selection.bgmTrackId || undefined,
      });
      setLocalJobs(plannedJobs);
      setStoryboardDraft(null);
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
      setMessage("AI 正在生成你的视频：自动写文案、剪画面、加字幕、配音乐。");
    } finally {
      setPendingAction(null);
    }
  }
```

> 这同时修掉了 `bgmTrackId: "bgm_warm"` 硬编码 bug——BGM 现在来自用户选择（默认首支曲目，由 StoryboardConfirm 初始化）。

- [ ] **Step 6: 改「开始生成视频」按钮 + 加时长档位选择器 + 渲染 StoryboardConfirm**

在「智能成片」卡片（约 1134 行 `<article className="card cardFeatured" id="one-click-video">`）内，把原「开始生成视频」`<button>`（onClick 原为 `simulateOneClickRender`）改为调用 `generateStoryboard`，并把 `pendingAction === "render"` 的禁用条件改为 `generating`：

```tsx
          <div className="choiceGrid" style={{ marginBottom: 12 }}>
            {[
              { value: 15, label: "短 · 约15秒" },
              { value: 30, label: "中 · 约30秒" },
              { value: 60, label: "长 · 约60秒" },
            ].map((d) => (
              <button
                key={d.value}
                type="button"
                className={targetDuration === d.value ? "purposeCard selected" : "purposeCard"}
                onClick={() => setTargetDuration(d.value)}
              >
                <strong>{d.label}</strong>
              </button>
            ))}
          </div>

          <button
            className="primaryButton"
            disabled={renderLocked || Boolean(renderMissingAssets) || generating}
            onClick={generateStoryboard}
            type="button"
          >
            {generating ? <span className="spinner" aria-hidden="true" /> : null}
            {renderLocked
              ? "请先完成门店档案"
              : renderMissingAssets
                ? "请至少勾选一个素材"
                : "生成分镜脚本"}
          </button>
```

在该 `<article>` 之后（同级）渲染确认界面：

```tsx
        {storyboardDraft ? (
          <StoryboardConfirm
            draft={storyboardDraft}
            assets={assets}
            bgmTracks={bgmTracks}
            onPatch={patchStoryboard}
            onConfirm={confirmAndRender}
            pending={pendingAction === "render"}
          />
        ) : null}
```

> 原 `{script ? (<div className="result">…{script.hook}…</div>) : null}` 块可保留（生成后 script 有值，仍显示 hook 摘要），不影响新流程。

- [ ] **Step 7: 运行测试确认通过**

Run: `npx vitest run tests/dashboard.test.tsx`
Expected: PASS（含改造后的生成用例）。

- [ ] **Step 8: Commit**

```bash
git add components/dashboard.tsx tests/dashboard.test.tsx
git commit -m "feat(dashboard): split render into storyboard generate + confirm flow; fix bgm_warm bug"
```

---

## Task 10: 端到端验证

**Files:** 无（仅验证）

- [ ] **Step 1: 全量测试**

Run: `npm test`
Expected: 全绿（原有用例 + 新增 script-match / script-engine / repo / api / storyboard-confirm / dashboard）。

- [ ] **Step 2: 类型检查**

Run: `npm run typecheck`
Expected: 0 errors。

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: 0 errors。

- [ ] **Step 4: Prisma 校验（零 migration 预期）**

Run: `npx prisma validate`
Expected: 通过（本阶段不改 schema）。

- [ ] **Step 5: 构建**

Run: `npm run build`
Expected: exit 0。

- [ ] **Step 6: 更新路线图状态**

`docs/superpowers/specs/2026-07-23-video-pipeline-overhaul-roadmap.md` 阶段表中 Phase 2 状态由「设计完成·待实现」改为「已实现·已部署」，并在该行补 plan/commit 链接。

- [ ] **Step 7: 同步 memory + 提醒下一阶段**

更新 auto-memory `video-pipeline-overhaul-roadmap.md`（Phase 2 → 已完成）；按推进协议**提醒**用户：Phase 1（门店档案 AI 建议）可开始，本会话上下文若已满建议开新会话执行。

- [ ] **Step 8: 最终 commit（文档）+ 询问 push**

```bash
git add docs/superpowers/specs/2026-07-23-video-pipeline-overhaul-roadmap.md
git commit -m "docs(roadmap): mark Phase 2 implemented"
```

向用户确认：是否现在 `git push origin main`（触发 Zeabur 部署），还是继续别的。

---

## Self-Review（计划完成后核对）

**Spec 覆盖**：
- 流程改造（生成→确认→渲染）→ Task 5/9 ✓
- 分镜数据结构扩展（matchedAssetId 等）→ Task 1/3 ✓
- 时长档位 → Task 3/7/9 ✓
- 素材自动匹配（简化版 + tags 契约）→ Task 2/3 ✓
- 确认界面交互（布局 A + 中等编辑）→ Task 8/9 ✓
- BGM 选曲 → Task 6/7/9 ✓
- 字幕样式选择 → Task 1（枚举对齐）+ Task 8（下拉）✓
- PATCH /api/script-drafts/[id] → Task 4/5 ✓
- GET /api/bgm-tracks → Task 6 ✓
- bgm_warm bug → Task 9 Step 5 ✓
- 安全（getOwnerId/IDOR/不泄漏 storageKey）→ Task 5/6 ✓
- 测试策略 → 各 Task 内 TDD ✓

**类型一致性**：`matchAssetsToScenes` 入参 `AssetMatchInput{assetId,features}`（Task 2）在 `buildDraft`（Task 3）以 `assetId: a.assetId` 构造；`ScriptScene.matchedAssetId?: string|null`（Task 1）在 Task 5 PATCH 与 Task 8 组件一致使用；`update(id, Partial<ScriptDraft>)`（Task 4）签名在 Task 5 调用一致；`updateScriptDraftApi`/`fetchBgmTracks`/`createScriptDraftApi`（Task 7）在 Task 9 调用一致。

**占位符扫描**：无 TBD/TODO；每个代码步骤均给出完整代码与确切命令。
