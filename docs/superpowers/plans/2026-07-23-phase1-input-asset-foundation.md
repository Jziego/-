# Phase 1：录入与素材基础 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase 1 of the video-pipeline overhaul — (A) AI 建议门店档案难填字段，(B) 素材标签可靠性兜底（失败可见 + 非餐饮兜底 + analysisStatus），(C) 停止向上传分类喂硬编码假输入。

**Architecture:** 同步路径加固（不动 BullMQ 队列）。`classifyAsset` 返回新增的 `analysisStatus`（succeeded/failed）——AI 失败时标 failed **但仍写规则兜底标签**，保证分镜不断。新增 `POST /api/store-profiles/suggest`（AI 建议门店字段）与 `POST /api/assets/[id]/reanalyze`（强制重试 AI 升级标签，复用新加的 `AssetAnalysisRepository.update`）。dashboard 去掉假 visualLabels/transcript，加"AI 建议"按钮与状态徽章。

**Tech Stack:** TypeScript 6, Next.js 16 App Router, Prisma 7 (postgresql), Vitest, @testing-library/react, react-hook-form, 现有 `chatCompletionJSON`/`sanitizePromptField` AI 原语。

**Spec:** [docs/superpowers/specs/2026-07-23-phase1-input-asset-foundation-design.md](../specs/2026-07-23-phase1-input-asset-foundation-design.md)

---

## 关键既有约定（实现时遵守）

- **鉴权**：每个新路由开头 `const ownerId = await getOwnerId();`（`@/lib/auth-helpers`），绝不直接读 `demoOwnerId`。
- **限流**：`const limited = await applyRateLimit(request, ownerId); if (limited) return limited;` —— POST 自动走写桶（20/min）。
- **响应**：`jsonOk(data, status=200)` / `jsonError(message, status=400)`（`@/lib/api-response`）。
- **IDOR**：`if (!asset || asset.ownerId !== ownerId) return jsonError("Asset not found", 404);` —— 用 404 隐藏存在性，不用 403。
- **动态参数**：`context: { params: Promise<{ id: string }> }`，`const { id } = await context.params;`
- **测试 mock 风格**：用 `vi.spyOn`，**不要** `vi.mock(...)` 工厂。mock AI 用 `vi.spyOn(aiClient, "chatCompletionJSON").mockResolvedValue({...})`。API 路由测试直接 `import { POST } from "@/app/api/.../route"` + `new Request(...)`。每个 `beforeEach` 调 `resetRuntimeStateForTests()`（`@/lib/runtime-store`）。
- **AssetAnalysis 无 ownerId**（经 asset 关联得到），自然键是 `assetId`（`@unique`）。

---

## File Structure

| 文件 | 责任 | 变更 |
|------|------|------|
| `prisma/schema.prisma` | AssetAnalysis 模型 | 加 `analysisStatus` |
| `prisma/migrations/20260723000001_add_asset_analysis_status/migration.sql` | 迁移 | **新建**：ADD COLUMN + 回填 |
| `lib/types.ts` | TS 类型 | `AssetAnalysis` 加 `analysisStatus` |
| `lib/schemas.ts` | Zod | `assetAnalysisSchema` 加字段；新增 `storeSuggestionInputSchema` |
| `lib/repositories/types.ts` | 仓储接口 | `AssetAnalysisRepository` 加 `update` |
| `lib/repositories/prisma.ts` | Prisma 实现 | 实现 `update` |
| `lib/repositories/memory.ts` | 内存实现 | 实现 `update` |
| `lib/repositories/mappers.ts` | 映射 | `toAssetAnalysis`/`toAssetAnalysisInput` 带 `analysisStatus` |
| `lib/services/assets.ts` | 分类服务 | `classifyAsset` 返 `analysisStatus` + confidence 逻辑；扩 `inferBusinessTags`/`extractBusinessKeywords` |
| `lib/services/store-suggest.ts` | 门店建议服务 | **新建** |
| `lib/api-client.ts` | 前端 API 封装 | 加 `suggestStoreProfileApi` + `reanalyzeAssetApi` |
| `app/api/store-profiles/suggest/route.ts` | 门店建议路由 | **新建** |
| `app/api/assets/[id]/reanalyze/route.ts` | 重新分析路由 | **新建** |
| `components/dashboard.tsx` | 主面板 | 删假输入；AI 建议按钮；状态徽章 + 重新分析按钮 |
| `tests/asset-analysis.test.ts` | 分类测试 | 加 analysisStatus 用例 |
| `tests/repositories/asset.test.ts` | 仓储测试 | 加 analysisStatus 往返 + update 用例；更新 sampleAnalysis |
| `tests/store-suggest.test.ts` | 建议服务测试 | **新建** |
| `tests/api-store-profiles-suggest.test.ts` | 建议路由测试 | **新建** |
| `tests/api-assets-reanalyze.test.ts` | 重新分析路由测试 | **新建** |
| `tests/dashboard.test.tsx` | 面板测试 | 加诚实输入 / 建议按钮 / 徽章用例 |

无新依赖。

---

## Task 1: `analysisStatus` 字段 + `classifyAsset` 状态逻辑 + 迁移

数据层 + 分类服务的基础。`classifyAsset` 开始返回 `analysisStatus`；AI 失败标 failed 但仍写规则兜底标签；confidence 失败时降到 0.3。

**Files:**
- Modify: `prisma/schema.prisma`（`AssetAnalysis` 模型，约 101-112 行）
- Create: `prisma/migrations/20260723000001_add_asset_analysis_status/migration.sql`
- Modify: `lib/types.ts:75-85`（`AssetAnalysis` 接口）
- Modify: `lib/schemas.ts:67-77`（`assetAnalysisSchema`）
- Modify: `lib/repositories/mappers.ts:114-140`（两个映射函数）
- Modify: `lib/services/assets.ts:194-237`（`classifyAsset`）
- Test: `tests/asset-analysis.test.ts`（加用例）、`tests/repositories/asset.test.ts`（加往返用例 + 更新 sampleAnalysis）

- [ ] **Step 1: 写失败测试 — classifyAsset 状态**

在 `tests/asset-analysis.test.ts` 末尾（最后一个 `it` 之后、`describe` 闭合之前）追加：

```ts
  it("marks analysisStatus succeeded when AI classifies successfully", async () => {
    vi.spyOn(aiClient, "hasAI").mockReturnValue(true);
    vi.spyOn(aiClient, "chatCompletionJSON").mockResolvedValue({
      businessTags: ["新品推荐"],
      keywords: ["可颂"],
      recommendedUses: ["new_product"],
      reasoning: "x"
    });
    const analysis = await classifyAsset({ asset, store, visualLabels: ["food"] });
    expect(analysis.analysisStatus).toBe("succeeded");
  });

  it("marks analysisStatus failed (with rule fallback tags) when AI returns empty", async () => {
    vi.spyOn(aiClient, "hasAI").mockReturnValue(true);
    vi.spyOn(aiClient, "chatCompletionJSON").mockResolvedValue(null);
    const analysis = await classifyAsset({ asset, store, visualLabels: ["food"] });
    expect(analysis.analysisStatus).toBe("failed");
    expect(analysis.confidence).toBeLessThanOrEqual(0.3);
    // rule fallback still populated businessTags/keywords arrays (not undefined)
    expect(Array.isArray(analysis.businessTags)).toBe(true);
    expect(Array.isArray(analysis.keywords)).toBe(true);
  });

  it("marks analysisStatus succeeded on the rule-only path (analysisUnavailable)", async () => {
    const analysis = await classifyAsset({ asset, store, analysisUnavailable: true });
    expect(analysis.analysisStatus).toBe("succeeded");
  });
```

> 注：`asset`/`store`/`aiClient` 是该文件已有的 fixture/import（见文件顶部 `import * as aiClient from "@/lib/services/ai-client";` 与 `asset`/`store` 常量）。若变量名不同，沿用文件内既有命名。

- [ ] **Step 2: 写失败测试 — analysisStatus 仓储往返**

在 `tests/repositories/asset.test.ts` 的 `sampleAnalysis` 工厂（约 6-34 行）里给返回对象加 `analysisStatus: "succeeded"` 字段（与其他字段并列）。然后在 describe 内追加：

```ts
  it("persists and returns analysisStatus via the memory repo", async () => {
    resetRuntimeStateForTests();
    const repo = new MemoryAssetAnalysisRepository();
    const analysis = sampleAnalysis({ assetId: "asset_a", analysisStatus: "failed" });
    await repo.create(analysis);
    const found = await repo.findByAssetId("asset_a");
    expect(found?.analysisStatus).toBe("failed");
  });
```

> `sampleAnalysis` 当前签名若是 `sampleAnalysis(overrides)`，调用 `sampleAnalysis({ assetId: "asset_a", analysisStatus: "failed" })`；若它是位置参数，按既有方式合并。`resetRuntimeStateForTests` 与 `MemoryAssetAnalysisRepository` 已在该文件 import。

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run tests/asset-analysis.test.ts tests/repositories/asset.test.ts`
Expected: FAIL —— `analysisStatus` 在 `AssetAnalysis` 类型上不存在（TS 报错），测试编译失败。

- [ ] **Step 4: 加 `analysisStatus` 到类型/映射/schema**

(a) `lib/types.ts`，在 `AssetAnalysis` 接口（75-85 行）`createdAt` 之后加：

```ts
  analysisStatus: string;
```

(b) `lib/repositories/mappers.ts`，`toAssetAnalysis`（114-126 行）在 `createdAt: row.createdAt.toISOString()` 之后加：

```ts
    analysisStatus: row.analysisStatus
```

并在 `toAssetAnalysisInput`（128-140 行）`createdAt: new Date(analysis.createdAt)` 之后加：

```ts
    analysisStatus: analysis.analysisStatus
```

(c) `lib/schemas.ts`，`assetAnalysisSchema`（67-77 行）在 `createdAt: isoDateString` 之前加：

```ts
  analysisStatus: z.string().default("pending"),
```

- [ ] **Step 5: 改 `classifyAsset` 返回状态 + confidence 逻辑**

`lib/services/assets.ts`，把 `classifyAsset`（194-237 行）整体替换为：

```ts
export async function classifyAsset(input: ClassifyAssetInput): Promise<AssetAnalysis> {
  const visualTags = input.analysisUnavailable
    ? inferTagsFromFilename(input.asset.originalFilename)
    : unique([...(input.visualLabels ?? []), ...inferTagsFromFilename(input.asset.originalFilename)]);

  // ── Business tags, keywords, recommended uses ──
  let businessTags: string[];
  let keywords: string[];
  let recommendedUses: MarketingPurpose[];
  let analysisStatus: string;
  let aiFailed = false;

  if (!input.analysisUnavailable && hasAI()) {
    try {
      const aiResult = await classifyAssetWithAI(input, visualTags);
      businessTags = aiResult.businessTags;
      keywords = aiResult.keywords;
      recommendedUses = aiResult.recommendedUses;
      analysisStatus = "succeeded";
    } catch (error) {
      console.warn(
        `[assets] AI classification failed, falling back to rules: ${error instanceof Error ? error.message : String(error)}`,
      );
      aiFailed = true;
      const fallback = ruleBasedClassify(input, visualTags);
      businessTags = fallback.businessTags;
      keywords = fallback.keywords;
      recommendedUses = fallback.recommendedUses;
      analysisStatus = "failed";
    }
  } else {
    const fallback = ruleBasedClassify(input, visualTags);
    businessTags = fallback.businessTags;
    keywords = fallback.keywords;
    recommendedUses = fallback.recommendedUses;
    analysisStatus = "succeeded";
  }

  const confidence = aiFailed
    ? 0.3
    : input.analysisUnavailable
      ? 0.35
      : calculateConfidence(visualTags, keywords, businessTags);

  return {
    id: createId("analysis"),
    assetId: input.asset.id,
    visualTags,
    businessTags,
    transcript: input.transcript,
    keywords,
    confidence,
    recommendedUses: recommendedUses.length > 0 ? recommendedUses : ["store_traffic"],
    createdAt: nowIso(),
    analysisStatus
  };
}
```

- [ ] **Step 6: 加 schema 列 + 迁移**

(a) `prisma/schema.prisma`，`AssetAnalysis` 模型（101-112 行）在 `recommendedUses String[]` 之后、`createdAt` 之前加：

```prisma
  analysisStatus   String   @default("pending")
```

(b) 新建 `prisma/migrations/20260723000001_add_asset_analysis_status/migration.sql`，内容：

```sql
-- AlterTable: track whether AI classification succeeded, failed, or is pending.
ALTER TABLE "AssetAnalysis" ADD COLUMN "analysisStatus" TEXT NOT NULL DEFAULT 'pending';

-- Backfill: existing rows already carry tags, so treat them as succeeded.
UPDATE "AssetAnalysis" SET "analysisStatus" = 'succeeded';
```

- [ ] **Step 7: 运行测试确认通过**

Run: `npx vitest run tests/asset-analysis.test.ts tests/repositories/asset.test.ts`
Expected: PASS（含新增的 4 个用例）。

- [ ] **Step 8: 校验 schema 并重新生成 Prisma Client**

Run: `npx prisma validate && npx prisma generate`
Expected: `The schema at prisma/schema.prisma is valid ✅`；generate 无报错。

> 若本地有 `DATABASE_URL` 且想用 `prisma migrate dev` 生成迁移替代手写：`npx prisma migrate dev --name add_asset_analysis_status`，然后把回填 `UPDATE` 行追加进生成的 migration.sql。手写文件已可直接在 Zeabur `migrate deploy` 时应用，二选一即可。

- [ ] **Step 9: typecheck**

Run: `npm run typecheck`
Expected: 0 errors。若有 AssetAnalysis 字面量 fixture 漏了 `analysisStatus`，补上（grep `recommendedUses:` 找字面量）。

- [ ] **Step 10: 提交**

```bash
git add prisma/schema.prisma prisma/migrations/20260723000001_add_asset_analysis_status/migration.sql lib/types.ts lib/schemas.ts lib/repositories/mappers.ts lib/services/assets.ts tests/asset-analysis.test.ts tests/repositories/asset.test.ts
git commit -m "feat(assets): add analysisStatus + fail-visible rule fallback in classifyAsset"
```

---

## Task 2: 扩展规则兜底覆盖非餐饮行业

`inferBusinessTags`/`extractBusinessKeywords` 当前只认餐饮/烘焙。扩到零售/美业/教育培训/生活服务。这两个是内部函数，经 `classifyAsset({analysisUnavailable:true})` 测试。

**Files:**
- Modify: `lib/services/assets.ts:279-306`（`inferBusinessTags` + `extractBusinessKeywords`）
- Test: `tests/asset-analysis.test.ts`

- [ ] **Step 1: 写失败测试 — 非餐饮行业兜底**

在 `tests/asset-analysis.test.ts` 追加（用一个美业 store fixture；若文件内 `store` 是餐饮，新建局部变量）：

```ts
  it("rule fallback produces business tags for a 美业 store", async () => {
    const beautyStore = { ...store, industry: "美业", mainProducts: ["美甲", "美容"] };
    const analysis = await classifyAsset({
      asset: { ...asset, originalFilename: "nail-art-design.mp4" },
      store: beautyStore,
      analysisUnavailable: true
    });
    expect(analysis.businessTags.length).toBeGreaterThan(0);
    expect(analysis.analysisStatus).toBe("succeeded");
  });

  it("rule fallback produces business tags for a 教育培训 store", async () => {
    const eduStore = { ...store, industry: "教育培训", mainProducts: ["英语体验课"] };
    const analysis = await classifyAsset({
      asset: { ...asset, originalFilename: "demo-class.mp4" },
      store: eduStore,
      analysisUnavailable: true
    });
    expect(analysis.businessTags.length).toBeGreaterThan(0);
  });
```

> 若 `asset`/`store` 字段不全（缺少某些必填），用文件内既有的构造方式补全；关键是 `industry` 与 `originalFilename`。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/asset-analysis.test.ts`
Expected: FAIL —— 美业/教育的 `businessTags` 为空（规则未覆盖）。

- [ ] **Step 3: 扩展 `inferBusinessTags` + `extractBusinessKeywords`**

`lib/services/assets.ts`，把 `inferBusinessTags`（279-301 行）整体替换为：

```ts
function inferBusinessTags(input: {
  industry: string;
  visualTags: string[];
  transcript?: string;
  filename: string;
}): string[] {
  const text = `${input.visualTags.join(" ")} ${input.transcript ?? ""} ${input.filename}`.toLowerCase();
  const tags: string[] = [];
  const industry = input.industry;

  const isFnb = industry.includes("餐饮") || industry.includes("烘焙");
  const isRetail = industry.includes("零售");
  const isBeauty = industry.includes("美业") || industry.includes("美容") || industry.includes("美甲");
  const isEdu = industry.includes("教育") || industry.includes("培训");
  const isService = industry.includes("生活服务") || industry.includes("服务");

  const has = (...keys: string[]) => keys.some((k) => text.includes(k));

  if (isFnb) {
    if (has("croissant", "可颂", "蛋糕", "牛肉面", "新品", "new")) tags.push("新品推荐");
    if (has("门店", "环境", "store", "front")) tags.push("门店环境");
    if (has("套餐", "促销", "sale", "半价")) tags.push("促销");
  }
  if (isRetail) {
    if (has("新品", "new", "上架", "商品")) tags.push("新品推荐");
    if (has("促销", "sale", "折扣", "特价")) tags.push("促销");
    if (has("门店", "柜台", "陈列", "store")) tags.push("门店环境");
  }
  if (isBeauty) {
    if (has("造型", "美甲", "美容", "护肤", "设计", "nail", "beauty")) tags.push("造型展示");
    if (has("门店", "环境", "store", "工作室")) tags.push("门店环境");
    if (has("预约", "体验", "口碑", "好评")) tags.push("口碑");
  }
  if (isEdu) {
    if (has("课程", "体验课", "名师", "试听", "class", "course")) tags.push("课程展示");
    if (has("报名", "促销", "优惠", "sale")) tags.push("促销");
    if (has("门店", "教室", "环境", "store")) tags.push("门店环境");
  }
  if (isService) {
    if (has("门店", "环境", "store", "门面")) tags.push("门店环境");
    if (has("口碑", "好评", "师傅", "专业")) tags.push("口碑");
    if (has("预约", "上门", "促销", "优惠")) tags.push("促销");
  }

  return tags;
}
```

把 `extractBusinessKeywords`（303-306 行）替换为：

```ts
function extractBusinessKeywords(text: string): string[] {
  const candidates = [
    // 餐饮/烘焙
    "牛肉面", "可颂", "蛋糕", "午餐", "下午茶", "出炉", "套餐",
    // 零售
    "新品", "上架", "特价", "折扣",
    // 美业
    "美甲", "美容", "护肤", "造型", "预约",
    // 教育
    "体验课", "课程", "报名", "试听",
    // 生活服务 / 通用
    "促销", "到店", "上门", "口碑"
  ];
  return candidates.filter((keyword) => text.includes(keyword));
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/asset-analysis.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add lib/services/assets.ts tests/asset-analysis.test.ts
git commit -m "feat(assets): expand rule-based fallback to retail/beauty/edu/service industries"
```

---

## Task 3: `AssetAnalysisRepository.update`

reanalyze 需要按 assetId 更新现有分析行（`create` 会撞 `assetId` 唯一约束）。用 fetch-merge 风格（同 `PrismaScriptRepository.update`）。

**Files:**
- Modify: `lib/repositories/types.ts:27-32`（接口）
- Modify: `lib/repositories/prisma.ts:115-139`（Prisma 实现）
- Modify: `lib/repositories/memory.ts:68-91`（内存实现）
- Test: `tests/repositories/asset.test.ts`

- [ ] **Step 1: 写失败测试 — update 合并**

在 `tests/repositories/asset.test.ts` 追加：

```ts
  it("update merges fields by assetId (memory)", async () => {
    resetRuntimeStateForTests();
    const repo = new MemoryAssetAnalysisRepository();
    await repo.create(sampleAnalysis({ assetId: "asset_a", businessTags: ["旧标签"], analysisStatus: "succeeded" }));
    const updated = await repo.update("asset_a", { businessTags: ["新标签"], analysisStatus: "failed" });
    expect(updated.businessTags).toEqual(["新标签"]);
    expect(updated.analysisStatus).toBe("failed");
    expect(updated.assetId).toBe("asset_a"); // id/assetId 不变
    const found = await repo.findByAssetId("asset_a");
    expect(found?.businessTags).toEqual(["新标签"]);
  });

  it("update throws when assetId not found (memory)", async () => {
    resetRuntimeStateForTests();
    const repo = new MemoryAssetAnalysisRepository();
    await expect(repo.update("missing", { businessTags: ["x"] })).rejects.toThrow();
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/repositories/asset.test.ts`
Expected: FAIL —— `update` 不是 `AssetAnalysisRepository` 的方法（TS 报错）。

- [ ] **Step 3: 接口加 `update`**

`lib/repositories/types.ts`，`AssetAnalysisRepository`（27-32 行）在 `listByOwner` 之后加：

```ts
  update(assetId: string, data: Partial<AssetAnalysis>): Promise<AssetAnalysis>;
```

- [ ] **Step 4: Prisma 实现**

`lib/repositories/prisma.ts`，`PrismaAssetAnalysisRepository`（115-139 行）在 `listByOwner` 方法之后、类闭合 `}` 之前加：

```ts
  async update(assetId: string, data: Partial<AssetAnalysis>): Promise<AssetAnalysis> {
    const existing = await this.findByAssetId(assetId);
    if (!existing) throw new Error(`AssetAnalysis not found for assetId: ${assetId}`);
    const merged = { ...existing, ...data, id: existing.id, assetId: existing.assetId };
    const row = await this.prisma.assetAnalysis.update({
      where: { assetId },
      data: toAssetAnalysisInput(merged)
    });
    return toAssetAnalysis(row);
  }
```

- [ ] **Step 5: 内存实现**

`lib/repositories/memory.ts`，`MemoryAssetAnalysisRepository`（68-91 行）在 `listByOwner` 之后、类闭合 `}` 之前加：

```ts
  async update(assetId: string, data: Partial<AssetAnalysis>): Promise<AssetAnalysis> {
    const state = getRuntimeState();
    const index = state.analyses.findIndex((a) => a.assetId === assetId);
    if (index < 0) throw new Error(`AssetAnalysis not found for assetId: ${assetId}`);
    const updated = { ...state.analyses[index], ...data, id: state.analyses[index].id, assetId };
    state.analyses[index] = updated;
    return updated;
  }
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npx vitest run tests/repositories/asset.test.ts`
Expected: PASS（含新 update 用例）。

- [ ] **Step 7: 提交**

```bash
git add lib/repositories/types.ts lib/repositories/prisma.ts lib/repositories/memory.ts tests/repositories/asset.test.ts
git commit -m "feat(repos): add AssetAnalysisRepository.update (by assetId)"
```

---

## Task 4: `POST /api/assets/[id]/reanalyze` 路由

强制走 AI（`analysisUnavailable:false`）重试分类；无 AI key 返 503；用 update（或 create 兜底）落库。

**Files:**
- Create: `app/api/assets/[id]/reanalyze/route.ts`
- Test: `tests/api-assets-reanalyze.test.ts`

- [ ] **Step 1: 写失败测试**

新建 `tests/api-assets-reanalyze.test.ts`：

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as authHelpers from "@/lib/auth-helpers";
import * as rateLimit from "@/lib/rate-limit";
import * as aiClient from "@/lib/services/ai-client";
import { resetRuntimeStateForTests } from "@/lib/runtime-store";
import {
  MemoryAssetRepository,
  MemoryAssetAnalysisRepository,
  MemoryStoreRepository
} from "@/lib/repositories/memory";
import * as repositories from "@/lib/repositories";
import { POST } from "@/app/api/assets/[id]/reanalyze/route";
import type { Asset, StoreProfile } from "@/lib/types";

const baseAsset: Asset = {
  id: "asset_a",
  ownerId: "demo_user",
  storeId: "store_1",
  type: "image",
  originalFilename: "p.png",
  storageKey: "uploads/p.png",
  mimeType: "image/png",
  sizeBytes: 10,
  tags: [],
  businessTags: [],
  status: "uploaded",
  createdAt: "2026-01-01T00:00:00.000Z"
} as unknown as Asset;

const baseStore: StoreProfile = {
  id: "store_1",
  ownerId: "demo_user",
  name: "阿姨面馆",
  industry: "餐饮",
  mainProducts: ["牛肉面"],
  targetCustomers: ["上班族"],
  sellingPoints: ["现熬"],
  brandTone: "亲切接地气",
  forbiddenWords: [],
  promotions: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
} as unknown as StoreProfile;

function newRequest(id: string) {
  return new Request(`http://localhost/api/assets/${id}/reanalyze`, { method: "POST" });
}

describe("POST /api/assets/[id]/reanalyze", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetRuntimeStateForTests();
    vi.spyOn(authHelpers, "getOwnerId").mockResolvedValue("demo_user");
    vi.spyOn(rateLimit, "applyRateLimit").mockResolvedValue(undefined);
    const assetRepo = new MemoryAssetRepository();
    const analysisRepo = new MemoryAssetAnalysisRepository();
    const storeRepo = new MemoryStoreRepository();
    vi.spyOn(repositories, "getAssetRepository").mockReturnValue(assetRepo);
    vi.spyOn(repositories, "getAssetAnalysisRepository").mockReturnValue(analysisRepo);
    vi.spyOn(repositories, "getStoreRepository").mockReturnValue(storeRepo);
  });

  it("returns 404 for a missing or foreign asset", async () => {
    const res = await POST(newRequest("asset_missing"), { params: Promise.resolve({ id: "asset_missing" }) });
    expect(res.status).toBe(404);
  });

  it("returns 503 when AI is not configured", async () => {
    const assetRepo = new MemoryAssetRepository();
    await assetRepo.create(baseAsset);
    vi.spyOn(repositories, "getAssetRepository").mockReturnValue(assetRepo);
    vi.spyOn(aiClient, "hasAI").mockReturnValue(false);
    const res = await POST(newRequest("asset_a"), { params: Promise.resolve({ id: "asset_a" }) });
    expect(res.status).toBe(503);
  });

  it("updates an existing analysis and returns 200 with succeeded status", async () => {
    const assetRepo = new MemoryAssetRepository();
    const analysisRepo = new MemoryAssetAnalysisRepository();
    await assetRepo.create(baseAsset);
    vi.spyOn(repositories, "getAssetRepository").mockReturnValue(assetRepo);
    vi.spyOn(repositories, "getAssetAnalysisRepository").mockReturnValue(analysisRepo);
    vi.spyOn(aiClient, "hasAI").mockReturnValue(true);
    vi.spyOn(aiClient, "chatCompletionJSON").mockResolvedValue({
      businessTags: ["新品推荐"],
      keywords: ["牛肉面"],
      recommendedUses: ["new_product"],
      reasoning: "x"
    });
    const res = await POST(newRequest("asset_a"), { params: Promise.resolve({ id: "asset_a" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.analysis.analysisStatus).toBe("succeeded");
    expect(body.analysis.businessTags).toContain("新品推荐");
  });

  it("records failed status (with fallback tags) when AI returns empty", async () => {
    const assetRepo = new MemoryAssetRepository();
    const analysisRepo = new MemoryAssetAnalysisRepository();
    await assetRepo.create(baseAsset);
    vi.spyOn(repositories, "getAssetRepository").mockReturnValue(assetRepo);
    vi.spyOn(repositories, "getAssetAnalysisRepository").mockReturnValue(analysisRepo);
    vi.spyOn(aiClient, "hasAI").mockReturnValue(true);
    vi.spyOn(aiClient, "chatCompletionJSON").mockResolvedValue(null);
    const res = await POST(newRequest("asset_a"), { params: Promise.resolve({ id: "asset_a" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.analysis.analysisStatus).toBe("failed");
  });
});
```

> `MemoryAssetRepository`/`MemoryStoreRepository` 的 `create` 签名若与上面不符（如需更多字段），沿用其既有签名补全。`Asset`/`StoreProfile` 字面量用 `as unknown as` 绕过宽松字段。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/api-assets-reanalyze.test.ts`
Expected: FAIL —— 路由文件不存在，import 解析失败。

- [ ] **Step 3: 实现路由**

新建 `app/api/assets/[id]/reanalyze/route.ts`：

```ts
import { jsonError, jsonOk } from "@/lib/api-response";
import { applyRateLimit } from "@/lib/rate-limit";
import { getOwnerId } from "@/lib/auth-helpers";
import { getAssetAnalysisRepository, getAssetRepository, getStoreRepository } from "@/lib/repositories";
import { classifyAsset } from "@/lib/services/assets";
import { hasAI } from "@/lib/services/ai-client";

/**
 * Force a fresh AI classification of an asset (reanalyze). Used to recover from
 * a `failed` analysis or upgrade rule-fallback tags to AI tags. AI failures are
 * NOT fatal: the analysis is persisted with status `failed` + rule fallback tags.
 * IDOR: a missing or foreign asset resolves to 404.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await context.params;
  const ownerId = await getOwnerId();
  const limited = await applyRateLimit(request, ownerId);
  if (limited) return limited;

  const asset = await getAssetRepository().findById(id);
  if (!asset || asset.ownerId !== ownerId) {
    return jsonError("Asset not found", 404);
  }

  if (!hasAI()) {
    return jsonError("未配置 AI，无法重新分析", 503);
  }

  const store = await getStoreRepository().findById(asset.storeId);
  if (!store) {
    return jsonError("Store not found", 404);
  }

  const result = await classifyAsset({ asset, store, analysisUnavailable: false });
  const patch = {
    visualTags: result.visualTags,
    businessTags: result.businessTags,
    keywords: result.keywords,
    confidence: result.confidence,
    recommendedUses: result.recommendedUses,
    transcript: result.transcript,
    analysisStatus: result.analysisStatus
  };
  const repo = getAssetAnalysisRepository();
  const existing = await repo.findByAssetId(asset.id);
  const saved = existing ? await repo.update(asset.id, patch) : await repo.create(result);
  return jsonOk({ analysis: saved });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/api-assets-reanalyze.test.ts`
Expected: PASS（4 个用例）。

- [ ] **Step 5: 提交**

```bash
git add app/api/assets/[id]/reanalyze/route.ts tests/api-assets-reanalyze.test.ts
git commit -m "feat(api): POST /api/assets/[id]/reanalyze to retry AI classification"
```

---

## Task 5: `store-suggest` 服务

门店档案 AI 建议的核心服务。system prompt 服务端写死；用户输入经 `sanitizePromptField`；AI 返 null 抛 `StoreSuggestionError`；返回值做防御性规整。

**Files:**
- Create: `lib/services/store-suggest.ts`
- Test: `tests/store-suggest.test.ts`

- [ ] **Step 1: 写失败测试**

新建 `tests/store-suggest.test.ts`：

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as aiClient from "@/lib/services/ai-client";
import { suggestStoreProfile, StoreSuggestionError } from "@/lib/services/store-suggest";

describe("suggestStoreProfile", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("parses and normalizes the AI suggestion into 5 fields", async () => {
    const spy = vi.spyOn(aiClient, "chatCompletionJSON").mockResolvedValue({
      mainProducts: ["牛肉面", "葱油拌面", "牛肉面"],
      sellingPoints: ["现熬牛骨汤"],
      targetCustomers: ["上班族", "社区居民"],
      promotions: ["工作日午餐第二份半价"],
      brandTone: "亲切接地气"
    });
    const result = await suggestStoreProfile({ name: "阿姨面馆", industry: "餐饮", location: "上海徐汇" });
    expect(result.mainProducts).toEqual(["牛肉面", "葱油拌面"]); // 去重
    expect(result.sellingPoints).toEqual(["现熬牛骨汤"]);
    expect(result.targetCustomers).toEqual(["上班族", "社区居民"]);
    expect(result.promotions).toEqual(["工作日午餐第二份半价"]);
    expect(result.brandTone).toBe("亲切接地气");
    // 用户输入经 sanitize 后进入 prompt
    const [, userPrompt] = spy.mock.calls[0]!;
    expect(userPrompt).toContain("阿姨面馆");
  });

  it("coerces malformed AI output to safe defaults", async () => {
    vi.spyOn(aiClient, "chatCompletionJSON").mockResolvedValue({
      mainProducts: "不是数组",
      sellingPoints: null,
      targetCustomers: ["", "  "],
      promotions: [],
      brandTone: 123
    });
    const result = await suggestStoreProfile({ name: "x", industry: "零售" });
    expect(result.mainProducts).toEqual([]);
    expect(result.sellingPoints).toEqual([]);
    expect(result.targetCustomers).toEqual([]);
    expect(result.brandTone).toBe("亲切接地气"); // 默认
  });

  it("throws StoreSuggestionError when AI returns null", async () => {
    vi.spyOn(aiClient, "chatCompletionJSON").mockResolvedValue(null);
    await expect(suggestStoreProfile({ name: "x", industry: "零售" })).rejects.toBeInstanceOf(StoreSuggestionError);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/store-suggest.test.ts`
Expected: FAIL —— 模块不存在，import 解析失败。

- [ ] **Step 3: 实现服务**

新建 `lib/services/store-suggest.ts`：

```ts
import { chatCompletionJSON, sanitizePromptField } from "@/lib/services/ai-client";

export interface StoreSuggestionInput {
  name: string;
  industry: string;
  location?: string;
}

export interface StoreSuggestion {
  mainProducts: string[];
  sellingPoints: string[];
  targetCustomers: string[];
  promotions: string[];
  brandTone: string;
}

/**
 * Thrown when AI suggestion cannot be produced (no key, empty response). The
 * route maps this to a 502 so the user can retry or fall back to manual entry.
 */
export class StoreSuggestionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreSuggestionError";
  }
}

const SUGGEST_SYSTEM_PROMPT = `你是本地商家短视频的门店档案顾问。根据店名、行业、位置，为商家生成营销短视频所需的门店档案内容建议。

规则：
- mainProducts: 2-5个主营产品/服务（中文，贴合这个行业与店名）
- sellingPoints: 2-4个卖点（如现做、性价比、出餐快、环境好、手作等）
- targetCustomers: 2-4个目标客群（如附近上班族、社区居民、学生、家庭等）
- promotions: 0-3个适合的促销活动（如工作日套餐、第二份半价、到店赠品），可为空数组
- brandTone: 一个简短的说话风格（如"亲切接地气"、"专业有质感"、"活泼俏皮"）

仅依据店名/行业/位置做合理推断，不要编造具体到不真实的细节。`;

const SUGGEST_SCHEMA = `{
  "mainProducts": ["产品1", "产品2"],
  "sellingPoints": ["卖点1", "卖点2"],
  "targetCustomers": ["客群1", "客群2"],
  "promotions": ["活动1"],
  "brandTone": "说话风格"
}`;

interface RawSuggestion {
  mainProducts?: unknown;
  sellingPoints?: unknown;
  targetCustomers?: unknown;
  promotions?: unknown;
  brandTone?: unknown;
}

function toStringArray(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((v) => String(v).trim()).filter(Boolean))).slice(0, max);
}

function normalizeSuggestion(raw: RawSuggestion): StoreSuggestion {
  const brandTone =
    typeof raw.brandTone === "string" && raw.brandTone.trim()
      ? raw.brandTone.trim().slice(0, 40)
      : "亲切接地气";
  return {
    mainProducts: toStringArray(raw.mainProducts, 6),
    sellingPoints: toStringArray(raw.sellingPoints, 6),
    targetCustomers: toStringArray(raw.targetCustomers, 6),
    promotions: toStringArray(raw.promotions, 5),
    brandTone
  };
}

export async function suggestStoreProfile(input: StoreSuggestionInput): Promise<StoreSuggestion> {
  const userPrompt = [
    `店名：${sanitizePromptField(input.name, 100)}`,
    `行业：${sanitizePromptField(input.industry, 50)}`,
    input.location ? `位置：${sanitizePromptField(input.location, 100)}` : null
  ].filter(Boolean).join("\n");

  const result = await chatCompletionJSON<RawSuggestion>(SUGGEST_SYSTEM_PROMPT, userPrompt, {
    schemaDescription: SUGGEST_SCHEMA,
    temperature: 0.6,
    maxTokens: 800
  });

  if (!result) {
    throw new StoreSuggestionError("AI returned empty suggestion");
  }
  return normalizeSuggestion(result);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/store-suggest.test.ts`
Expected: PASS（3 个用例）。

- [ ] **Step 5: 提交**

```bash
git add lib/services/store-suggest.ts tests/store-suggest.test.ts
git commit -m "feat(store): add suggestStoreProfile AI suggestion service"
```

---

## Task 6: `storeSuggestionInputSchema` + `POST /api/store-profiles/suggest` 路由

薄路由：鉴权 + 限流 + Zod 校验 + hasAI 守卫 + 调服务；AI 失败 502。

**Files:**
- Modify: `lib/schemas.ts`（加 schema + 类型）
- Create: `app/api/store-profiles/suggest/route.ts`
- Test: `tests/api-store-profiles-suggest.test.ts`

- [ ] **Step 1: 写失败测试**

新建 `tests/api-store-profiles-suggest.test.ts`：

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as authHelpers from "@/lib/auth-helpers";
import * as rateLimit from "@/lib/rate-limit";
import * as aiClient from "@/lib/services/ai-client";
import * as storeSuggest from "@/lib/services/store-suggest";
import { POST } from "@/app/api/store-profiles/suggest/route";

function newRequest(body: unknown) {
  return new Request("http://localhost/api/store-profiles/suggest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("POST /api/store-profiles/suggest", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(authHelpers, "getOwnerId").mockResolvedValue("demo_user");
    vi.spyOn(rateLimit, "applyRateLimit").mockResolvedValue(undefined);
  });

  it("returns 400 when name/industry missing", async () => {
    const res = await POST(newRequest({ name: "" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 on invalid JSON body", async () => {
    const req = new Request("http://localhost/api/store-profiles/suggest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json"
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 503 when AI is not configured", async () => {
    vi.spyOn(aiClient, "hasAI").mockReturnValue(false);
    const res = await POST(newRequest({ name: "阿姨面馆", industry: "餐饮" }));
    expect(res.status).toBe(503);
  });

  it("returns 200 with a suggestion on success", async () => {
    vi.spyOn(aiClient, "hasAI").mockReturnValue(true);
    vi.spyOn(storeSuggest, "suggestStoreProfile").mockResolvedValue({
      mainProducts: ["牛肉面"],
      sellingPoints: ["现熬"],
      targetCustomers: ["上班族"],
      promotions: ["午餐半价"],
      brandTone: "亲切接地气"
    });
    const res = await POST(newRequest({ name: "阿姨面馆", industry: "餐饮", location: "上海" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.suggestion.mainProducts).toEqual(["牛肉面"]);
    expect(body.suggestion.brandTone).toBe("亲切接地气");
  });

  it("returns 502 when the AI service throws", async () => {
    vi.spyOn(aiClient, "hasAI").mockReturnValue(true);
    vi.spyOn(storeSuggest, "suggestStoreProfile").mockRejectedValue(new storeSuggest.StoreSuggestionError("empty"));
    const res = await POST(newRequest({ name: "x", industry: "零售" }));
    expect(res.status).toBe(502);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/api-store-profiles-suggest.test.ts`
Expected: FAIL —— 路由不存在。

- [ ] **Step 3: 加 schema**

`lib/schemas.ts`，在 `storeProfileSchema`（16-34 行）之后追加：

```ts
export const storeSuggestionInputSchema = z.object({
  name: z.string().min(1, "请填写门店名称"),
  industry: z.string().min(1, "请选择行业"),
  location: z.string().optional()
});

export type StoreSuggestionInput = z.infer<typeof storeSuggestionInputSchema>;
```

- [ ] **Step 4: 实现路由**

新建 `app/api/store-profiles/suggest/route.ts`：

```ts
import { jsonError, jsonOk } from "@/lib/api-response";
import { applyRateLimit } from "@/lib/rate-limit";
import { getOwnerId } from "@/lib/auth-helpers";
import { hasAI } from "@/lib/services/ai-client";
import { suggestStoreProfile, StoreSuggestionError } from "@/lib/services/store-suggest";
import { storeSuggestionInputSchema } from "@/lib/schemas";

/**
 * AI-suggest hard-to-fill store-profile fields (mainProducts/sellingPoints/
 * targetCustomers/promotions/brandTone) from name+industry+location. Output is
 * shown for review — it is NOT persisted here (the client fills the form, the
 * user saves via the existing upsert). AI failure → 502 so the user can retry.
 */
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return jsonError("Request body must be valid JSON", 400);
  }

  const ownerId = await getOwnerId();
  const limited = await applyRateLimit(request, ownerId);
  if (limited) return limited;

  const parsed = storeSuggestionInputSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(parsed.error.issues[0]?.message ?? "Invalid input");
  }

  if (!hasAI()) {
    return jsonError("未配置 AI，无法生成建议", 503);
  }

  try {
    const suggestion = await suggestStoreProfile(parsed.data);
    return jsonOk({ suggestion });
  } catch (error) {
    if (error instanceof StoreSuggestionError) {
      return jsonError("AI 建议生成失败，请重试或手动填写", 502);
    }
    return jsonError("AI 建议生成失败，请重试或手动填写", 502);
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run tests/api-store-profiles-suggest.test.ts`
Expected: PASS（5 个用例）。

- [ ] **Step 6: 提交**

```bash
git add lib/schemas.ts app/api/store-profiles/suggest/route.ts tests/api-store-profiles-suggest.test.ts
git commit -m "feat(api): POST /api/store-profiles/suggest for AI store-profile suggestions"
```

---

## Task 7: dashboard 诚实输入（删硬编码假标签/转写）

上传循环不再向 `/api/assets/analyze` 喂 `["food","person","storefront"]` 和假餐饮转写。

**Files:**
- Modify: `components/dashboard.tsx:694-699`
- Test: `tests/dashboard.test.tsx`

- [ ] **Step 1: 写失败测试 — analyze 请求体不含假字段**

在 `tests/dashboard.test.tsx` 内新增一个 `describe`（沿用文件顶部既有的 `Providers`/`mockApiFetch`/`userEvent` setup；若 `mockApiFetch` 不便于捕获 body，改用 `vi.stubGlobal("fetch", ...)` 记录调用）。示例（按文件既有风格调整 import）：

```ts
  it("does not send hardcoded visualLabels/transcript when uploading", async () => {
    const analyzeCalls: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/assets/analyze") && init?.method === "POST") {
          analyzeCalls.push(new Request(url, init));
        }
        return new Response(JSON.stringify({ analysis: { id: "an_1", assetId: "asset_1", visualTags: [], businessTags: [], keywords: [], confidence: 0.5, recommendedUses: [], createdAt: "2026-01-01T00:00:00.000Z", analysisStatus: "succeeded" } }), {
          status: 201,
          headers: { "Content-Type": "application/json" }
        });
      })
    );
    // …复用文件内既有的“造一个 store + 选一个文件 + 点上传”流程，触发一次上传…
    // （沿用本文件已有上传用例的 render + fill + click 步骤）

    const body = analyzeCalls.length > 0 ? await analyzeCalls[analyzeCalls.length - 1]!.json() : null;
    expect(body).toBeTruthy();
    expect(body).not.toHaveProperty("visualLabels");
    expect(body).not.toHaveProperty("transcript");
  });
```

> 该文件已有的上传用例（约 614 行起，spy `uploadFileToStorage`）是模板：复用其 render/store 填写/文件选择/点击“上传素材”的步骤，仅替换 fetch 桩以捕获 `/api/assets/analyze` 的 body。若文件内已有公共 render helper（如 `renderDashboard()`），直接调用。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/dashboard.test.tsx`
Expected: FAIL —— 当前上传发送 `visualLabels`/`transcript`，断言不过。

- [ ] **Step 3: 删假输入**

`components/dashboard.tsx`，把上传循环里的 `analyzeAssetApi` 调用（694-699 行）：

```tsx
        const analyzed = await analyzeAssetApi({
          assetId: uploadedAsset.id,
          storeId: store.id,
          visualLabels: ["food", "person", "storefront"],
          transcript: `${store.mainProducts[0]}刚出锅，午餐出餐很快`
        });
```

替换为：

```tsx
        const analyzed = await analyzeAssetApi({
          assetId: uploadedAsset.id,
          storeId: store.id
        });
```

> 若既有上传测试断言过 `visualLabels`/假转写（grep `food, person, storefront` 与 `刚出锅`），一并更新。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/dashboard.test.tsx`
Expected: PASS（新用例 + 既有用例不回归）。

- [ ] **Step 5: 提交**

```bash
git add components/dashboard.tsx tests/dashboard.test.tsx
git commit -m "fix(upload): stop sending hardcoded fake visualLabels/transcript to AI classify"
```

---

## Task 8: dashboard "AI 建议" 按钮 + api-client 封装

门店档案 step2/step3 加"AI 建议"按钮，一次调用预填 5 字段（不自动保存）。

**Files:**
- Modify: `lib/api-client.ts`（加 `suggestStoreProfileApi`）
- Modify: `components/dashboard.tsx`（按钮 + handler，注入点 `.formActions` 998-1011 行）
- Test: `tests/dashboard.test.tsx`

- [ ] **Step 1: 写失败测试 — 按钮预填**

在 `tests/dashboard.test.tsx` 内新增用例（复用既有 render/fetch stub）：

```ts
  it("AI 建议 button prefills store fields from the suggestion", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/store-profiles/suggest")) {
          return new Response(
            JSON.stringify({ suggestion: { mainProducts: ["牛肉面", "葱油拌面"], sellingPoints: ["现熬牛骨汤"], targetCustomers: ["上班族"], promotions: ["午餐半价"], brandTone: "亲切接地气" } }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
      })
    );
    // render + 填 step1（name/industry）+ 进到 step2（点“保存并继续”）
    // const { ... } = renderDashboard(); … fill name/industry … await user.click(保存并继续);

    const suggestBtn = await screen.findByRole("button", { name: /AI 建议/ });
    await user.click(suggestBtn);

    // 预填后主营产品输入框含建议值
    const mainProductsInput = await screen.findByLabelText("主营产品");
    expect((mainProductsInput as HTMLInputElement).value).toContain("牛肉面");
  });
```

> 沿用文件内既有 render/store-step 填写流程。若 `findByLabelText("主营产品")` 选择器与实际不符，用文件内既有的字段定位方式。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/dashboard.test.tsx`
Expected: FAIL —— 无"AI 建议"按钮。

- [ ] **Step 3: 加 api-client 封装**

`lib/api-client.ts`，在 `saveStore`（64-70 行）之后追加（顶部 import 处补 `StoreSuggestionInput, StoreSuggestion` from `@/lib/services/store-suggest`，若未 import 类型）：

```ts
export async function suggestStoreProfileApi(input: StoreSuggestionInput): Promise<StoreSuggestion> {
  const data = await api<{ suggestion: StoreSuggestion }>("/api/store-profiles/suggest", {
    method: "POST",
    body: JSON.stringify(input)
  });
  return data.suggestion;
}
```

> 若 `api-client.ts` 不便从 service 导入类型，可在 `lib/types.ts` 重复定义 `StoreSuggestion`/`StoreSuggestionInput` 或从 `@/lib/schemas` 取 `StoreSuggestionInput`。优先 `import type { StoreSuggestion, StoreSuggestionInput } from "@/lib/services/store-suggest";`。

- [ ] **Step 4: 加 handler + 按钮**

`components/dashboard.tsx`：

(a) 顶部 import 区加（与其它 api-client import 并列）：

```tsx
import { suggestStoreProfileApi } from "@/lib/api-client";
```

(b) 在 `submitCurrentStoreStep`（约 519 行）附近新增 handler（与之间级）：

```tsx
  async function handleSuggestStore() {
    if (pendingAction) return;
    const name = getValues("name");
    const industry = getValues("industry");
    if (!name || !industry) {
      setMessage("请先填写门店名称和行业，再使用 AI 建议。");
      return;
    }
    setPendingAction("store");
    try {
      const suggestion = await suggestStoreProfileApi({
        name,
        industry,
        location: getValues("location") || undefined
      });
      setValue("mainProducts", joinCsv(suggestion.mainProducts), { shouldDirty: true });
      setValue("targetCustomers", joinCsv(suggestion.targetCustomers), { shouldDirty: true });
      setValue("sellingPoints", joinCsv(suggestion.sellingPoints), { shouldDirty: true });
      setValue("promotions", joinCsv(suggestion.promotions), { shouldDirty: true });
      setValue("brandTone", suggestion.brandTone, { shouldDirty: true });
      setMessage("AI 建议已填入，请审阅后保存。");
    } catch (error) {
      const detail = error instanceof Error ? error.message : "请稍后重试";
      setMessage(`AI 建议生成失败：${detail}（可重试或手动填写）`);
    } finally {
      setPendingAction(null);
    }
  }
```

> `getValues`/`setValue`/`joinCsv`/`setPendingAction`/`setMessage` 均为该组件既有（`joinCsv` 见 1402 行；RHF 的 getValues/setValue 见 `submitCurrentStoreStep` 用法）。

(c) 在 `.formActions`（998-1011 行）里、`上一步` 按钮（999 行）之前插入：

```tsx
              {storeFormStep >= 1 ? (
                <button
                  className="secondaryButton"
                  disabled={Boolean(pendingAction)}
                  onClick={() => void handleSuggestStore()}
                  type="button"
                >
                  {pendingAction === "store" ? <span className="spinner" aria-hidden="true" /> : null}
                  AI 建议
                </button>
              ) : null}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run tests/dashboard.test.tsx`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add lib/api-client.ts components/dashboard.tsx tests/dashboard.test.tsx
git commit -m "feat(dashboard): AI-suggest button to prefill store-profile fields"
```

---

## Task 9: dashboard 分析状态徽章 + 重新分析按钮 + api-client 封装

在"AI 自动分类"区按素材显示状态徽章；failed 时露"重新分析"按钮，调用 reanalyze 路由后刷新。

**Files:**
- Modify: `lib/api-client.ts`（加 `reanalyzeAssetApi`）
- Modify: `components/dashboard.tsx`（徽章 + handler，注入点 1121-1134 行）
- Test: `tests/dashboard.test.tsx`

- [ ] **Step 1: 写失败测试 — failed 状态露重新分析按钮**

在 `tests/dashboard.test.tsx` 新增用例（seed `/api/asset-analyses` 返回一条 `analysisStatus:"failed"` 的分析 + 对应 asset）：

```ts
  it("shows a 重新分析 button for an asset whose analysis failed", async () => {
    const user = userEvent.setup();
    let reanalyzed = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/assets/asset_a/reanalyze") && init?.method === "POST") {
          reanalyzed = true;
          return new Response(
            JSON.stringify({ analysis: { id: "an_1", assetId: "asset_a", visualTags: [], businessTags: ["新品推荐"], keywords: [], confidence: 0.6, recommendedUses: [], createdAt: "2026-01-01T00:00:00.000Z", analysisStatus: "succeeded" } }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (url.includes("/api/asset-analyses")) {
          return new Response(
            JSON.stringify({ analyses: [{ id: "an_1", assetId: "asset_a", visualTags: [], businessTags: [], keywords: [], confidence: 0.3, recommendedUses: [], createdAt: "2026-01-01T00:00:00.000Z", analysisStatus: "failed" }] }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        // 其余端点（stores/assets 等）返回文件内既有 mockApiFetch 的默认
        return new Response(JSON.stringify({ stores: [], assets: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      })
    );
    // render + 进入有素材/分析可见的状态（沿用文件内 seed savedAssets 的既有用例模式）

    const reanalyzeBtn = await screen.findByRole("button", { name: "重新分析" });
    await user.click(reanalyzeBtn);
    expect(reanalyzed).toBe(true);
  });
```

> 沿用文件内既有 seed savedAssets / 进入素材库可见的 render 流程；关键是 `/api/asset-analyses` 返回 failed 分析且 assetId 对得上某个可见 asset。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/dashboard.test.tsx`
Expected: FAIL —— 无"重新分析"按钮。

- [ ] **Step 3: 加 api-client 封装**

`lib/api-client.ts`，在 `analyzeAssetApi`（169-180 行）之后追加（`AssetAnalysis` 类型已 import）：

```ts
export async function reanalyzeAssetApi(assetId: string): Promise<AssetAnalysis> {
  const data = await api<{ analysis: AssetAnalysis }>(`/api/assets/${assetId}/reanalyze`, {
    method: "POST"
  });
  return data.analysis;
}
```

- [ ] **Step 4: 加状态 + handler + 徽章 UI**

`components/dashboard.tsx`：

(a) 顶部 import 区加：

```tsx
import { reanalyzeAssetApi } from "@/lib/api-client";
```

(b) 在组件 state 区（`localAnalyses` 约 261 行附近）加：

```tsx
  const [reanalyzingId, setReanalyzingId] = useState<string | null>(null);
```

(c) 加 handler（与其它 handler 同级，如 `handleSuggestStore` 附近）：

```tsx
  async function handleReanalyze(assetId: string) {
    setReanalyzingId(assetId);
    try {
      await reanalyzeAssetApi(assetId);
      await queryClient.invalidateQueries({ queryKey: ["asset-analyses"] });
      setMessage("已重新分析该素材。");
    } catch (error) {
      const detail = error instanceof Error ? error.message : "请稍后重试";
      setMessage(`重新分析失败：${detail}`);
    } finally {
      setReanalyzingId(null);
    }
  }
```

(d) 在"AI 自动分类"区（1121-1134 行）的 `<div className="tagList">…</div>` 之后、外层 `</div>`（1133 行）之前插入：

```tsx
                <ul className="analysisStatusList">
                  {selectedAnalyses.map((a) => {
                    const status = a.analysisStatus ?? "succeeded";
                    const owningAsset = selectedAssets.find((x) => x.id === a.assetId);
                    const label =
                      status === "failed"
                        ? "分析失败·已用兜底"
                        : status === "pending"
                          ? "分析中"
                          : "已分析";
                    return (
                      <li key={a.assetId}>
                        <span className={status === "failed" ? "statusBadge warning" : status === "pending" ? "statusBadge" : "statusBadge success"}>
                          {owningAsset?.originalFilename ?? a.assetId}·{label}
                        </span>
                        {status === "failed" ? (
                          <button
                            className="secondaryButton"
                            disabled={reanalyzingId === a.assetId}
                            onClick={() => void handleReanalyze(a.assetId)}
                            type="button"
                          >
                            {reanalyzingId === a.assetId ? <span className="spinner" aria-hidden="true" /> : null}
                            重新分析
                          </button>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
```

> `queryClient`/`setMessage`/`selectedAnalyses`/`selectedAssets` 均为组件既有。`statusBadge`/`spinner` 类名沿用文件内既有（见 avatar 卡 1143 行 `statusBadge success/warning`）。

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run tests/dashboard.test.tsx`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add lib/api-client.ts components/dashboard.tsx tests/dashboard.test.tsx
git commit -m "feat(dashboard): show analysis status badges + reanalyze button"
```

---

## Task 10: 全量校验 + 记忆更新 + push

**Files:** 无代码改动；校验 + 记忆 + 推送。

- [ ] **Step 1: typecheck**

Run: `npm run typecheck`
Expected: 0 errors。

- [ ] **Step 2: lint**

Run: `npm run lint`
Expected: 0 errors。

- [ ] **Step 3: 全量测试**

Run: `npm test`
Expected: 全绿（基线 192+，本计划净增约 15+ 用例）。

- [ ] **Step 4: prisma 校验 + build**

Run: `npx prisma validate && npm run build`
Expected: validate OK；build exit 0。

- [ ] **Step 5: 安全复核**

Run: `/security-review`（对 pending changes）
Expected: 无 HIGH/MEDIUM。重点确认两个新路由都走了 `getOwnerId()` + 限流 + IDOR（reanalyze 的 asset 所有权）。

- [ ] **Step 6: 更新 auto-memory**

更新 `C:\Users\Administrator\.claude\projects\C--Users-Administrator-Projects-ai-video-assistant\memory\video-pipeline-overhaul-roadmap.md`：把 Phase 1 状态标记为已实现 + commit；记录"门店档案 AI 建议 + 标签 analysisStatus 可靠性兜底 + 诚实输入"已上线。

- [ ] **Step 7: 更新路线图**

`docs/superpowers/specs/2026-07-23-video-pipeline-overhaul-roadmap.md`：Phase 1 行状态改 `已实现·已部署(<commit>)`，补 spec/plan 链接。

- [ ] **Step 8: 提交并 push**

```bash
git add -A
git commit -m "chore(phase1): verify CI green after input & asset foundation"
git push origin main
```

> Zeabur 自动部署；部署后 `migrate deploy` 会应用 `20260723000001_add_asset_analysis_status`（含回填）。

---

## Self-Review

**Spec coverage：**
- (A) 门店档案 AI 建议 → Task 5（服务）+ Task 6（路由+schema）+ Task 8（UI 按钮）。✓
- (B) 标签可靠性兜底：
  - analysisStatus 字段 → Task 1。✓
  - 失败可见 + 兜底标签 → Task 1（classifyAsset failed 分支）+ Task 9（UI 徽章）。✓
  - 非餐饮兜底 → Task 2。✓
  - 重新分析 → Task 3（update）+ Task 4（路由）+ Task 9（按钮）。✓
- (C) 诚实输入 → Task 7。✓
- 安全（auth/限流/IDOR/注入）→ Task 4/6 路由 + Task 10 security-review。✓

**Placeholder scan：** 各步均为具体代码/命令；Task 7/8/9 的 dashboard 测试因文件巨大，指明"沿用既有 render/seed 流程"并给出可运行骨架——这是对 1400 行测试文件的合理委托（非占位），实现时按既有模板补 render 步骤。

**Type consistency：**
- `analysisStatus: string` —— Task 1（type/schema/mappers/classifyAsset）、Task 3（update patch）、Task 4（reanalyze patch）、Task 9（UI `a.analysisStatus`）一致。✓
- `AssetAnalysisRepository.update(assetId, Partial<AssetAnalysis>)` —— Task 3 定义、Task 4 调用一致。✓
- `suggestStoreProfile(input): Promise<StoreSuggestion>` + `StoreSuggestionError` —— Task 5 定义、Task 6 路由调用、Task 8 api-client 调用一致。✓
- `storeSuggestionInputSchema` + `StoreSuggestionInput` —— Task 6 定义、Task 5/Task 8 使用一致。✓
- `reanalyzeAssetApi(assetId)` / `suggestStoreProfileApi(input)` —— Task 8/9 定义、UI 调用一致。✓
- 502（suggest AI 失败，无兜底）vs 200（reanalyze AI 失败，有兜底标签）语义差异已在路由实现与测试中固化。✓
