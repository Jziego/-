# Phase 4 — 素材分类 AI 化 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 DeepSeek 文本模型增强 `classifyAsset()` 的业务标签推断、关键词提取和推荐用途推理，现有规则引擎保留为 fallback。

**Architecture:** 复用 `lib/services/ai-client.ts` 的 `chatCompletionJSON()`。新增 `classifyAssetWithAI()` 函数，修改 `classifyAsset()` 增加 AI 优先路径（有 Key 时尝试 AI，失败或无 Key 时走现有规则引擎）。视觉标签（`inferTagsFromFilename`）保持不变，`analysisUnavailable` 模式不受影响。

**Tech Stack:** DeepSeek V4 Flash（OpenAI 兼容 SDK）、Vitest

---

## 文件结构预览

```
lib/services/
  assets.ts              # 修改：classifyAsset() 增加 AI 路径 + classifyAssetWithAI()
  ai-client.ts           # 已存在，无需改动
tests/
  asset-analysis.test.ts # 修改：增加 AI 成功 / AI 失败降级 测试
```

---

### Task 1: 新增 AI 分类函数 + 改造 classifyAsset

**Files:**
- Modify: `lib/services/assets.ts`

- [ ] **Step 1: 添加 `import { hasAI, chatCompletionJSON } from "@/lib/services/ai-client"`**

在文件顶部现有 import 之后插入：

```typescript
import { hasAI, chatCompletionJSON } from "@/lib/services/ai-client";
```

- [ ] **Step 2: 在 `ClassifyAssetInput` 后添加 AI 响应类型**

```typescript
interface AIClassifyResponse {
  businessTags: string[];
  keywords: string[];
  recommendedUses: MarketingPurpose[];
  reasoning: string;
}
```

- [ ] **Step 3: 在 `calculateConfidence` 之前添加 prompt 构建函数**

```typescript
const CLASSIFY_SYSTEM_PROMPT = `你是为本地商家短视频素材打标签的内容分析助手。
根据门店信息、素材文件名、视觉标签和语音转写文本，推断素材的业务标签、关键词和推荐营销用途。

规则：
- businessTags: 2-4个中文业务标签，如"新品推荐"、"门店环境"、"促销活动"、"口碑推荐"、"招聘"等
- keywords: 3-6个与素材内容相关的中文关键词
- recommendedUses: 从以下用途中选择1-3个最合适的：
  store_traffic（引流到店）、new_product（新品推荐）、promotion（促销活动）、
  holiday（节日营销）、testimonial（口碑推荐）、recruiting（招聘）
- reasoning: 一句话解释你的判断依据`;

const CLASSIFY_SCHEMA = `{
  "businessTags": ["标签1", "标签2"],
  "keywords": ["关键词1", "关键词2"],
  "recommendedUses": ["new_product", "store_traffic"],
  "reasoning": "判断依据"
}`;

function buildClassifyUserPrompt(input: ClassifyAssetInput, visualTags: string[]): string {
  const store = input.store;
  const lines = [
    `【门店信息】`,
    `店名：${store.name}`,
    `行业：${store.industry}`,
    `主推产品：${store.mainProducts.join("、")}`,
    `卖点：${store.sellingPoints.join("、")}`,
    `品牌调性：${store.brandTone}`,
    `当前活动：${store.promotions?.join("、") || "无"}`,
    ``,
    `【素材信息】`,
    `文件名：${input.asset.originalFilename}`,
    `媒体类型：${input.asset.type}`,
    `视觉标签：${visualTags.join("、") || "无"}`,
    input.transcript ? `语音转写：${input.transcript}` : null,
    input.manualTags?.length ? `手动标注：${input.manualTags.join("、")}` : null,
  ].filter(Boolean);
  return lines.join("\n");
}
```

- [ ] **Step 4: 在 `classifyAsset` 之前添加 `classifyAssetWithAI` 函数**

```typescript
export async function classifyAssetWithAI(
  input: ClassifyAssetInput,
  visualTags: string[],
): Promise<Pick<AssetAnalysis, "businessTags" | "keywords" | "recommendedUses">> {
  const userPrompt = buildClassifyUserPrompt(input, visualTags);
  const result = await chatCompletionJSON<AIClassifyResponse>(
    CLASSIFY_SYSTEM_PROMPT,
    userPrompt,
    { schemaDescription: CLASSIFY_SCHEMA, temperature: 0.3, maxTokens: 800 },
  );

  if (!result) {
    throw new Error("AI returned empty classification result");
  }

  // Merge with manual tags, deduplicate
  const businessTags = unique([
    ...(input.manualTags ?? []),
    ...(Array.isArray(result.businessTags) ? result.businessTags.map(String) : []),
  ]);

  // Merge AI keywords with product-name matches from transcript
  const transcriptKeywords = input.store.mainProducts.filter((product) =>
    `${input.transcript ?? ""} ${input.asset.originalFilename}`.includes(product),
  );
  const keywords = unique([
    ...transcriptKeywords,
    ...(Array.isArray(result.keywords) ? result.keywords.map(String) : []),
  ]);

  // Validate recommendedUses against valid MarketingPurpose values
  const validUses = Object.keys(purposeByBusinessTag) as MarketingPurpose[];
  const recommendedUses = unique(
    (Array.isArray(result.recommendedUses) ? result.recommendedUses : [])
      .map(String)
      .filter((u): u is MarketingPurpose => validUses.includes(u as MarketingPurpose)),
  );

  return {
    businessTags: businessTags.slice(0, 6),
    keywords: keywords.slice(0, 8),
    recommendedUses: recommendedUses.length > 0 ? recommendedUses : ["store_traffic"],
  };
}
```

- [ ] **Step 5: 改造 `classifyAsset` 函数 — 插入 AI 优先路径**

找到 `classifyAsset` 函数体中 `const keywords = unique([...` 这一行（约第 79 行），替换从 keywords/businessTags/recommendedUses 三段构建逻辑：

替换前（当前代码从第 79 行 `const keywords` 到第 98 行 `]`）：

```typescript
  const keywords = unique([
    ...extractBusinessKeywords(input.transcript ?? ""),
    ...input.store.mainProducts.filter((product) =>
      `${input.transcript ?? ""} ${input.asset.originalFilename}`.includes(product)
    )
  ]);

  const businessTags = unique([
    ...(input.manualTags ?? []),
    ...inferBusinessTags({
      industry: input.store.industry,
      visualTags,
      transcript: input.transcript,
      filename: input.asset.originalFilename
    })
  ]);

  const recommendedUses = unique(
    businessTags.map((tag) => purposeByBusinessTag[tag]).filter(Boolean)
  ) as MarketingPurpose[];
```

替换为：

```typescript
  // ── Business tags, keywords, recommended uses ──
  let businessTags: string[];
  let keywords: string[];
  let recommendedUses: MarketingPurpose[];

  // Try AI classification when available and not in forced-unavailable mode
  if (!input.analysisUnavailable && hasAI()) {
    try {
      const aiResult = await classifyAssetWithAI(input, visualTags);
      businessTags = aiResult.businessTags;
      keywords = aiResult.keywords;
      recommendedUses = aiResult.recommendedUses;
    } catch (error) {
      console.warn(
        `[assets] AI classification failed, falling back to rules: ${error instanceof Error ? error.message : String(error)}`,
      );
      const fallback = ruleBasedClassify(input, visualTags);
      businessTags = fallback.businessTags;
      keywords = fallback.keywords;
      recommendedUses = fallback.recommendedUses;
    }
  } else {
    const fallback = ruleBasedClassify(input, visualTags);
    businessTags = fallback.businessTags;
    keywords = fallback.keywords;
    recommendedUses = fallback.recommendedUses;
  }
```

- [ ] **Step 6: 将现有规则引擎抽成独立函数 `ruleBasedClassify`**

在 `classifyAsset` 函数之后添加：

```typescript
function ruleBasedClassify(
  input: ClassifyAssetInput,
  visualTags: string[],
): Pick<AssetAnalysis, "businessTags" | "keywords" | "recommendedUses"> {
  const keywords = unique([
    ...extractBusinessKeywords(input.transcript ?? ""),
    ...input.store.mainProducts.filter((product) =>
      `${input.transcript ?? ""} ${input.asset.originalFilename}`.includes(product),
    ),
  ]);

  const businessTags = unique([
    ...(input.manualTags ?? []),
    ...inferBusinessTags({
      industry: input.store.industry,
      visualTags,
      transcript: input.transcript,
      filename: input.asset.originalFilename,
    }),
  ]);

  const recommendedUses = unique(
    businessTags.map((tag) => purposeByBusinessTag[tag]).filter(Boolean),
  ) as MarketingPurpose[];

  return { businessTags, keywords, recommendedUses };
}
```

- [ ] **Step 7: 确认现有纯函数 `inferTagsFromFilename`, `inferBusinessTags`, `extractBusinessKeywords`, `calculateConfidence`, `unique` 保持不变**

不需要修改它们。

- [ ] **Step 8: 运行类型检查**

```bash
npx tsc --noEmit
```
Expected: PASS

---

### Task 2: 更新测试

**Files:**
- Modify: `tests/asset-analysis.test.ts`

- [ ] **Step 1: 在现有 import 后增加 AI client mock**

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";
import { classifyAsset, createUploadIntent } from "@/lib/services/assets";
import * as storage from "@/lib/storage";
import * as aiClient from "@/lib/services/ai-client";
import type { Asset, StoreProfile } from "@/lib/types";
```

- [ ] **Step 2: 在 describe 块开头的 `beforeEach` 中，紧接现有 `vi.restoreAllMocks()` 之后添加 AI mock 默认行为**

在现有 `beforeEach` 中追加：

```typescript
vi.spyOn(aiClient, "hasAI").mockReturnValue(true);
vi.spyOn(aiClient, "chatCompletionJSON").mockResolvedValue({
  businessTags: ["新品推荐", "门店环境"],
  keywords: ["可颂", "烘焙", "下午茶"],
  recommendedUses: ["new_product", "store_traffic"],
  reasoning: "烘焙店新品可颂，门店环境适合下午茶消费场景",
});
```

- [ ] **Step 3: 在现有两个测试用例之后，新增 "uses AI classification when available" 测试**

```typescript
it("uses AI classification when available", async () => {
  const analysis = await classifyAsset({
    asset,
    store,
    visualLabels: ["croissant", "bakery"],
    transcript: "今天的可颂刚出炉，下午茶很适合",
  });

  expect(aiClient.chatCompletionJSON).toHaveBeenCalled();
  expect(analysis.businessTags).toContain("新品推荐");
  expect(analysis.keywords).toContain("可颂");
  expect(analysis.recommendedUses).toContain("new_product");
  // AI mode should have higher confidence
  expect(analysis.confidence).toBeGreaterThan(0.5);
});
```

- [ ] **Step 4: 新增 "falls back to rule engine when AI fails" 测试**

```typescript
it("falls back to rule engine when AI fails", async () => {
  vi.spyOn(aiClient, "chatCompletionJSON").mockRejectedValue(new Error("API timeout"));

  const analysis = await classifyAsset({
    asset,
    store,
    visualLabels: ["croissant"],
    transcript: "可颂刚出炉",
  });

  // Rule engine still works — detects "可颂" keyword from hardcoded candidates
  expect(analysis.keywords).toContain("可颂");
  // Rule engine still infers business tags from industry + filename
  expect(analysis.businessTags).toContain("新品推荐");
});
```

- [ ] **Step 5: 运行测试确认通过**

```bash
npm test -- tests/asset-analysis.test.ts
```
Expected: 4 tests PASS

- [ ] **Step 6: 运行全量测试**

```bash
npm test
```
Expected: 80 tests PASS (78 existing + 2 new)

- [ ] **Step 7: 运行构建验证**

```bash
npm run build
```
Expected: PASS

---

### Task 3: 提交

- [ ] **Step 1: 提交变更**

```bash
git add lib/services/assets.ts tests/asset-analysis.test.ts
git commit -m "feat: add AI-powered asset classification with rule-engine fallback"
```

---

## 验收清单

- [ ] 有 `OPENAI_API_KEY` 时 `classifyAsset()` 走 AI 路径，返回更丰富的 tags/keywords
- [ ] AI 失败或无 Key 时自动降级到规则引擎
- [ ] `analysisUnavailable: true` 时强制规则引擎（不调 AI）
- [ ] Worker `asset-analysis` processor 无需修改即可受益
- [ ] 现有 AI client (`ai-client.ts`) 无改动
- [ ] `npm test` 全绿（80 个测试）
- [ ] `npm run build` 通过

---

## 关键设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| AI 只处理文本分析 | 是 | 视觉标签 (`inferTagsFromFilename`) 由文件名推断 + `visualLabels` 传入，AI 不做视觉 |
| rule engine 抽出独立函数 | 是 | `ruleBasedClassify()` 可独立测试，AI 路径和降级路径共用一个纯函数 |
| `analysisUnavailable` 跳过 AI | 是 | 该标记表示整个分析不可用（如 Worker 处理），此时不应浪费 API 调用 |
| AI response 新增 `reasoning` | 是 | 便于调试和 audit，调用方可以选择忽略 |
| `confidence` 计算保持不变 | 是 | AI 模式下 tags/keywords/businessTags 更丰富，`calculateConfidence()` 自动给出更高分值 |
