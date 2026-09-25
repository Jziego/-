# 批次二实施计划：门店档案 AI 候选池 + 文案规则引擎

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 门店档案升级为「候选池逐条填入」交互并补 3 个人设字段；文案引擎接入预写规则（三大原则/四大结构/反幻觉/负面约束）+ 切入角度轮换 + 折叠文案解析。

**Architecture:** 数据模型一次迁移（StoreProfile +3、ScriptDraft +2 可空列）；suggest 端点加 field/exclude 候选池模式（旧行为兼容）；文案规则走 ts 常量模块注入 system prompt；解析与文案同一次 LLM 调用、缺失容忍降级。

**Tech Stack:** Next.js 16 / React 19 / Prisma 7 / Zod / react-hook-form / Vitest。

**Spec:** `docs/superpowers/specs/2026-09-25-store-profile-copywriting-design.md`（已拍板：主营≤10/特色≤12、每批 8 条候选、单版+换方向、解析折叠展示）

---

### Task 1: 数据模型字段 + Prisma 迁移

**Files:**
- Modify: `prisma/schema.prisma`（StoreProfile L53-76、ScriptDraft L138-160）
- Modify: `lib/types.ts`（StoreProfile L39-57、ScriptDraft L145-168）
- Modify: `lib/repositories/mappers.ts`（toStoreProfile L27-47、toStoreProfileInput L49-69、toScriptDraft L189-210、toScriptDraftInput L212-233）
- Modify: `lib/repositories/prisma.ts`（StoreRepository.upsert update 白名单 L53-77）
- Modify: `lib/schemas.ts`（storeProfileSchema L16-34）
- Test: `tests/store-persona-fields.test.ts`（新建）

> ⚠️ **迁移前检查**：本机用户级 `DATABASE_URL` 环境变量指向生产库、会覆盖 `.env`（历史事故）。跑 `migrate dev` 前先 `echo $DATABASE_URL`——若指向生产库，在 shell 里 `unset DATABASE_URL` 后再执行，确认 `.env` 里是开发库。

- [ ] **Step 1: 写失败测试**

新建 `tests/store-persona-fields.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { getStoreRepository, getScriptRepository } from "@/lib/repositories";
import { createId, nowIso } from "@/lib/ids";
import type { ScriptDraft, StoreProfile } from "@/lib/types";

function makeStore(): StoreProfile {
  return {
    id: createId("store"),
    ownerId: "demo",
    name: "华荧慧",
    industry: "商业服务",
    location: "广东省深圳市龙岗区",
    nickname: "君姐",
    ownerAge: 48,
    yearsInBusiness: 15,
    mainProducts: ["线上运营赋能"],
    targetCustomers: ["门店老板"],
    sellingPoints: ["课程内容实用易懂"],
    promotions: [],
    brandTone: "亲切接地气",
    forbiddenWords: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

describe("门店人设字段与文案 angle/analysis 持久化", () => {
  it("store upsert + findById 回读 nickname/ownerAge/yearsInBusiness", async () => {
    const repo = getStoreRepository();
    const saved = await repo.upsert(makeStore());
    const loaded = await repo.findById(saved.id);
    expect(loaded?.nickname).toBe("君姐");
    expect(loaded?.ownerAge).toBe(48);
    expect(loaded?.yearsInBusiness).toBe(15);
  });

  it("store upsert 更新路径也写入新字段（prisma 白名单回归）", async () => {
    const repo = getStoreRepository();
    const store = makeStore();
    await repo.upsert(store);
    await repo.upsert({ ...store, nickname: "华姐", updatedAt: nowIso() });
    const loaded = await repo.findById(store.id);
    expect(loaded?.nickname).toBe("华姐");
  });

  it("script create 落库 angle 与 analysis", async () => {
    const store = await getStoreRepository().upsert(makeStore());
    const draft: ScriptDraft = {
      id: createId("script"),
      ownerId: "demo",
      storeId: store.id,
      purpose: "store_traffic",
      platform: "douyin",
      title: "测试",
      hook: "钩子",
      scenes: [],
      voiceover: "口播稿。",
      captions: ["口播稿。"],
      cta: "到店",
      generationMode: "ai",
      complianceWarnings: [],
      angle: "痛点暴击",
      analysis: { overview: "概述", principles: "原则解析", structure: "结构解析" },
      createdAt: nowIso(),
    };
    const saved = await getScriptRepository().create(draft);
    const loaded = await getScriptRepository().findById(saved.id);
    expect(loaded?.angle).toBe("痛点暴击");
    expect(loaded?.analysis?.overview).toBe("概述");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/store-persona-fields.test.ts`
Expected: FAIL（类型错误：StoreProfile/ScriptDraft 无这些字段）

- [ ] **Step 3: schema.prisma 加列**

StoreProfile model 加（`storefrontAssetId` 行后）：

```prisma
  nickname           String?
  ownerAge           Int?
  yearsInBusiness    Int?
```

ScriptDraft model 加（`speakerAvatarIds` 行后）：

```prisma
  angle              String?
  analysis           Json?
```

- [ ] **Step 4: lib/types.ts 加字段**

StoreProfile interface 加：

```ts
  /** 朋友们对你的称呼（人设句原料，如「君姐」）。 */
  nickname?: string;
  /** 店主年龄。 */
  ownerAge?: number;
  /** 店龄（年）。 */
  yearsInBusiness?: number;
```

ScriptDraft interface 前加类型 + interface 内加字段：

```ts
/** 文案解析报告（AI 产出，三段式；缺失容忍——截断/模板兜底/旧数据为 undefined）。 */
export interface CopyAnalysis {
  overview: string;
  principles: string;
  structure: string;
}
```

```ts
  /** 切入角度（COPY_ANGLES 之一；模板兜底/旧数据为 undefined）。 */
  angle?: string;
  /** 创作解析（折叠展示用）。 */
  analysis?: CopyAnalysis;
```

- [ ] **Step 5: mappers.ts 映射**

`toStoreProfile` 加三行（`storefrontAssetId: row.storefrontAssetId ?? undefined` 后）：

```ts
    nickname: row.nickname ?? undefined,
    ownerAge: row.ownerAge ?? undefined,
    yearsInBusiness: row.yearsInBusiness ?? undefined,
```

`toStoreProfileInput` 加三行（`storefrontAssetId: profile.storefrontAssetId ?? null` 后）：

```ts
    nickname: profile.nickname ?? null,
    ownerAge: profile.ownerAge ?? null,
    yearsInBusiness: profile.yearsInBusiness ?? null,
```

`toScriptDraft` 加（`speakerAvatarIds` 映射行后）：

```ts
    angle: row.angle ?? undefined,
    analysis: (row.analysis as CopyAnalysis | null) ?? undefined,
```

（文件顶部 import 加 `CopyAnalysis` 类型：`import type { ..., CopyAnalysis } from "@/lib/types"`。）

`toScriptDraftInput` 加：

```ts
    angle: script.angle ?? null,
    analysis: script.analysis ?? Prisma.JsonNull,
```

（Prisma Json 可空列写 null 用 `Prisma.JsonNull`；文件若未 import Prisma 则加 `import { Prisma } from "@prisma/client"`——若已有则复用。）

- [ ] **Step 6: prisma.ts upsert update 白名单补 3 字段**

`PrismaStoreRepository.upsert` 的 `update: { ... }` 块内加：

```ts
        nickname: data.nickname,
        ownerAge: data.ownerAge,
        yearsInBusiness: data.yearsInBusiness,
```

（memory.ts upsert 是整对象替换，无需改动。）

- [ ] **Step 7: schemas.ts storeProfileSchema 加可选字段**

```ts
    nickname: z.string().max(20).optional(),
    ownerAge: z.number().int().min(10).max(120).optional(),
    yearsInBusiness: z.number().int().min(0).max(100).optional(),
```

- [ ] **Step 8: 生成迁移**

Run: `npx prisma migrate dev --name add_persona_and_analysis_fields`
Expected: 生成 `prisma/migrations/<ts>_add_persona_and_analysis_fields/`，客户端重新生成成功

- [ ] **Step 9: 跑测试确认通过 + typecheck**

Run: `npx vitest run tests/store-persona-fields.test.ts && npm run typecheck`
Expected: 3 测试 PASS；typecheck 无错

- [ ] **Step 10: Commit**

```bash
git add prisma/ lib/ tests/store-persona-fields.test.ts
git commit -m "feat(db): StoreProfile 加人设3字段 + ScriptDraft 加 angle/analysis——批次二 Task1"
```

---

### Task 2: 候选池后端（suggest 端点 field/exclude 模式）

**Files:**
- Modify: `lib/schemas.ts`（storeSuggestionInputSchema L36-42 后）
- Modify: `lib/services/store-suggest.ts`
- Modify: `app/api/store-profiles/suggest/route.ts`
- Modify: `lib/api-client.ts`（suggestStoreProfileApi L73-79 后）
- Test: `tests/store-suggest.test.ts`（新建）

- [ ] **Step 1: 写失败测试**

新建 `tests/store-suggest.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { suggestFieldCandidates, StoreSuggestionError } from "@/lib/services/store-suggest";
import { storeSuggestionV2InputSchema } from "@/lib/schemas";

const fakeChat = (payload: unknown) => async () => payload;

describe("suggestFieldCandidates 候选池模式", () => {
  it("mainProducts 候选池：返回至多 8 条、去重去空", async () => {
    const chatJson = fakeChat({
      candidates: ["短视频代运营", "短视频代运营", "  ", "团购套餐设计", "同城引流", "直播带货辅助", "同城霸屏", "矩阵搭建", "数字化转型", "第九超出条"],
    });
    const out = await suggestFieldCandidates(
      { name: "华荧慧", industry: "商业服务", field: "mainProducts" },
      { chatJsonFn: chatJson as never },
    );
    expect(out).toHaveLength(8);
    expect(new Set(out).size).toBe(out.length);
    expect(out).not.toContain("");
  });

  it("exclude 条目进入 prompt", async () => {
    let seenUser = "";
    const chatJson = async (_sys: string, user: string) => {
      seenUser = user;
      return { candidates: ["a"] };
    };
    await suggestFieldCandidates(
      { name: "华荧慧", industry: "商业服务", field: "sellingPoints", exclude: ["15年经验", "AI 批量出片"] },
      { chatJsonFn: chatJson as never },
    );
    expect(seenUser).toContain("15年经验");
    expect(seenUser).toContain("AI 批量出片");
    expect(seenUser).toContain("不要重复");
  });

  it("人设字段进入 prompt", async () => {
    let seenUser = "";
    const chatJson = async (_sys: string, user: string) => {
      seenUser = user;
      return { candidates: ["a"] };
    };
    await suggestFieldCandidates(
      { name: "华荧慧", industry: "商业服务", location: "深圳龙岗", field: "mainProducts", nickname: "君姐", ownerAge: 48, yearsInBusiness: 15 },
      { chatJsonFn: chatJson as never },
    );
    expect(seenUser).toContain("君姐");
    expect(seenUser).toContain("48");
    expect(seenUser).toContain("15");
  });

  it("AI 返回 null → StoreSuggestionError", async () => {
    await expect(
      suggestFieldCandidates(
        { name: "x", industry: "y", field: "mainProducts" },
        { chatJsonFn: (async () => null) as never },
      ),
    ).rejects.toThrow(StoreSuggestionError);
  });
});

describe("storeSuggestionV2InputSchema", () => {
  it("兼容旧调用（无 field）", () => {
    const r = storeSuggestionV2InputSchema.safeParse({ name: "华荧慧", industry: "商业服务" });
    expect(r.success).toBe(true);
  });

  it("候选池调用通过；非法 field 拒绝", () => {
    expect(
      storeSuggestionV2InputSchema.safeParse({ name: "a", industry: "b", field: "mainProducts", exclude: ["x"] }).success,
    ).toBe(true);
    expect(
      storeSuggestionV2InputSchema.safeParse({ name: "a", industry: "b", field: "brandTone" }).success,
    ).toBe(false);
  });

  it("exclude 超 40 条拒绝", () => {
    const r = storeSuggestionV2InputSchema.safeParse({
      name: "a", industry: "b", field: "mainProducts",
      exclude: Array.from({ length: 41 }, (_, i) => `条目${i}`),
    });
    expect(r.success).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/store-suggest.test.ts`
Expected: FAIL（`suggestFieldCandidates` / `storeSuggestionV2InputSchema` 不存在）

- [ ] **Step 3: schemas.ts 加 v2 schema**

`storeSuggestionInputSchema` 定义后加：

```ts
/** 候选池模式（批次二）：field 缺省 = 旧整组建议行为；传 field = 按字段出候选池。 */
export const storeSuggestionV2InputSchema = storeSuggestionInputSchema.extend({
  field: z.enum(["mainProducts", "sellingPoints"]).optional(),
  exclude: z.array(z.string().trim().min(1).max(30)).max(40, "exclude 最多 40 条").optional(),
  nickname: z.string().max(20).optional(),
  ownerAge: z.number().int().min(10).max(120).optional(),
  yearsInBusiness: z.number().int().min(0).max(100).optional(),
});

export type StoreSuggestionV2Input = z.infer<typeof storeSuggestionV2InputSchema>;
```

- [ ] **Step 4: store-suggest.ts 加候选池函数**

文件尾部追加：

```ts
// ── 候选池模式（批次二）：按字段出 8 条候选，exclude 去重 ─────────────────────

export interface FieldCandidateInput extends StoreSuggestionInput {
  field: "mainProducts" | "sellingPoints";
  exclude?: string[];
  nickname?: string;
  ownerAge?: number;
  yearsInBusiness?: number;
}

export interface FieldCandidateDeps {
  /** 测试注入；缺省走真 AI。 */
  chatJsonFn?: (
    systemPrompt: string,
    userPrompt: string,
    options: { schemaDescription: string; temperature: number; maxTokens: number },
  ) => Promise<{ candidates?: unknown } | null>;
}

const FIELD_CANDIDATE_PROMPTS: Record<FieldCandidateInput["field"], string> = {
  mainProducts: `你是本地商家短视频的门店档案顾问。根据门店基础信息，给出 8 条该店可能的【主营业务】候选条目。
规则：
- 每条 4-12 字口语短语（如「短视频代运营」「工作日午市套餐」），贴合行业与店名
- 按最可能到次可能排序，彼此角度不同，不重复用户已有条目
- 仅依据门店信息合理推断，不编造具体到不真实的细节`,
  sellingPoints: `你是本地商家短视频的门店档案顾问。根据门店基础信息，给出 8 条该店可能的【门店特色/优势】候选条目。
规则：
- 每条 4-14 字口语短语（如「15年行业深耕经验」「一对一诊断门店现状」），贴合行业与人设
- 覆盖不同维度（经验/服务/效果/价格/效率），不重复用户已有条目
- 仅依据门店信息合理推断，不编造具体到不真实的细节`,
};

const FIELD_CANDIDATE_SCHEMA = `{ "candidates": ["候选1", "候选2", "候选3", "候选4", "候选5", "候选6", "候选7", "候选8"] }`;

export async function suggestFieldCandidates(
  input: FieldCandidateInput,
  deps?: FieldCandidateDeps,
): Promise<string[]> {
  const chatJson = deps?.chatJsonFn ?? chatCompletionJSON;
  const excludeList = (input.exclude ?? [])
    .map((e) => sanitizePromptField(e, 30))
    .filter(Boolean);

  const userPrompt = [
    `店名：${sanitizePromptField(input.name, 100)}`,
    `行业：${sanitizePromptField(input.industry, 50)}`,
    input.location ? `位置：${sanitizePromptField(input.location, 100)}` : null,
    input.nickname ? `店主称呼：${sanitizePromptField(input.nickname, 20)}` : null,
    input.ownerAge ? `店主年龄：${input.ownerAge}` : null,
    input.yearsInBusiness ? `店龄：${input.yearsInBusiness}年` : null,
    excludeList.length ? `已存在条目（不要重复）：${excludeList.join("、")}` : null,
  ].filter(Boolean).join("\n");

  const result = await chatJson(FIELD_CANDIDATE_PROMPTS[input.field], userPrompt, {
    schemaDescription: FIELD_CANDIDATE_SCHEMA,
    temperature: 0.7,
    maxTokens: 800,
  });
  if (!result) {
    throw new StoreSuggestionError("AI returned empty candidates");
  }
  return toStringArray(result.candidates, 8);
}
```

（`toStringArray` 复用文件内现有函数，无需改动；import 区无需新增——chatCompletionJSON/sanitizePromptField 已 import。）

- [ ] **Step 5: suggest 路由接 field 分支**

`app/api/store-profiles/suggest/route.ts`：

- import 改为：

```ts
import { suggestStoreProfile, suggestFieldCandidates, StoreSuggestionError } from "@/lib/services/store-suggest";
import { storeSuggestionV2InputSchema } from "@/lib/schemas";
```

- `storeSuggestionInputSchema.safeParse` 改为 `storeSuggestionV2InputSchema.safeParse`
- `hasAI()` 检查之后、`suggestStoreProfile` 调用之前插入分支：

```ts
  try {
    if (parsed.data.field) {
      const candidates = await suggestFieldCandidates({
        name: parsed.data.name,
        industry: parsed.data.industry,
        location: parsed.data.location,
        field: parsed.data.field,
        exclude: parsed.data.exclude,
        nickname: parsed.data.nickname,
        ownerAge: parsed.data.ownerAge,
        yearsInBusiness: parsed.data.yearsInBusiness,
      });
      return jsonOk({ candidates });
    }
    const suggestion = await suggestStoreProfile(parsed.data);
    return jsonOk({ suggestion });
  } catch (error) {
    // 既有错误映射保持不变
```

（catch 块现有 StoreSuggestionError → 502 逻辑不动。）

- [ ] **Step 6: api-client.ts 加前端调用**

`suggestStoreProfileApi` 后加：

```ts
/** 候选池模式（批次二）：按字段拉 8 条 AI 候选。 */
export async function suggestFieldCandidatesApi(input: {
  name: string;
  industry: string;
  location?: string;
  field: "mainProducts" | "sellingPoints";
  exclude?: string[];
  nickname?: string;
  ownerAge?: number;
  yearsInBusiness?: number;
}): Promise<string[]> {
  const data = await api<{ candidates: string[] }>("/api/store-profiles/suggest", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return data.candidates;
}
```

- [ ] **Step 7: 跑测试确认通过**

Run: `npx vitest run tests/store-suggest.test.ts`
Expected: 7 测试 PASS

- [ ] **Step 8: Commit**

```bash
git add lib/schemas.ts lib/services/store-suggest.ts app/api/store-profiles/suggest/route.ts lib/api-client.ts tests/store-suggest.test.ts
git commit -m "feat(store): suggest 端点加候选池模式（field/exclude/人设字段，每批8条）——批次二 Task2"
```

---

### Task 3: 文案规则文件 lib/copywriting-rules.ts

**Files:**
- Create: `lib/copywriting-rules.ts`
- Test: `tests/copywriting-rules.test.ts`（新建）

- [ ] **Step 1: 写失败测试**

新建 `tests/copywriting-rules.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { COPYWRITING_RULES, COPY_ANGLES, angleGuidance, nextAngle } from "@/lib/copywriting-rules";

describe("文案规则文件", () => {
  it("规则全文包含三大原则与四大结构", () => {
    for (const kw of ["锁同城", "锁行业目标客户", "兴趣点种草", "黄金开头", "高密度信息", "场景化种草", "行动号召"]) {
      expect(COPYWRITING_RULES).toContain(kw);
    }
  });

  it("包含反幻觉与负面约束章节", () => {
    expect(COPYWRITING_RULES).toContain("反幻觉");
    expect(COPYWRITING_RULES).toContain("不擅自编造");
    expect(COPYWRITING_RULES).toContain("不客套开场");
  });

  it("五个切入角度且每个有引导语", () => {
    expect(COPY_ANGLES).toHaveLength(5);
    for (const angle of COPY_ANGLES) {
      expect(angleGuidance(angle).length).toBeGreaterThan(10);
    }
  });

  it("nextAngle 按序列轮换、到尾回首项、未知角度从首项开始", () => {
    expect(nextAngle("痛点暴击")).toBe("场景代入");
    expect(nextAngle("反差悬念")).toBe("痛点暴击");
    expect(nextAngle(undefined)).toBe("痛点暴击");
    expect(nextAngle("不存在的角度")).toBe("痛点暴击");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/copywriting-rules.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现规则文件**

新建 `lib/copywriting-rules.ts`：

```ts
/**
 * 本地实体店短视频口播文案规则（批次二，spec §4.1）。
 *
 * 每次生成前由 script-engine 注入 system prompt——规则独立于逻辑代码，
 * 运营迭代文案方法论只改本文件。措辞风格参照参考产品「文案解析」板块。
 * 血肉条款借鉴：short-video-factory 反幻觉规则、MoneyPrinterTurbo 负面约束清单
 * （均为 prompt 文案层面的借鉴，无代码拷贝；svf 为 AGPL 只取思想）。
 */

export const COPY_ANGLES = ["痛点暴击", "场景代入", "利益直击", "口碑背书", "反差悬念"] as const;

export type CopyAngle = (typeof COPY_ANGLES)[number];

const ANGLE_GUIDANCE: Record<CopyAngle, string> = {
  痛点暴击: "开篇直戳目标客群当前最核心的痛点或焦虑，制造「不改变就晚了」的紧迫感",
  场景代入: "开篇描绘目标客群熟悉的日常场景，让人立刻产生「这说的就是我」的代入感",
  利益直击: "开篇直接抛出最诱人的收益点或结果，先给甜头再展开讲怎么做到",
  口碑背书: "开篇借老客户、街坊或学员的评价与案例建立信任，用事实说话",
  反差悬念: "开篇制造认知反差或悬念（新旧对比/反常识观点），勾住好奇心往下看",
};

export function angleGuidance(angle: CopyAngle): string {
  return ANGLE_GUIDANCE[angle];
}

/** 换方向轮换：未知/缺失角度从序列首项开始，到尾循环回首项。 */
export function nextAngle(current?: string): CopyAngle {
  const index = COPY_ANGLES.indexOf(current as CopyAngle);
  return COPY_ANGLES[(index + 1) % COPY_ANGLES.length] ?? COPY_ANGLES[0];
}

export const COPYWRITING_RULES = `【创作规则：本地实体店短视频口播文案方法论】

一、概述
本规则适用于本地实体店短视频口播文案创作。文案目标是同城获客：用一条口播稿把「这家店值得来/这项服务值得试」讲给门店周边的目标客群听，驱动到店、私信或咨询。

二、三大原则
1. 锁同城原则：开篇直呼地域人群（如「龙岗的餐饮老板」），并用具体地名、店龄、街坊身份做地域背书，让同城刷到的人产生「这是身边店」的亲近感与信任感，降低防御心理。
2. 锁行业目标客户原则：用行业痛点关键词精准筛选目标客群，做出「说的就是你」的直指感，让非目标人群自然滑走、目标人群停下来听完。
3. 兴趣点种草原则：把卖点转译为目标客群听得懂的收益，能量化的量化，用具体场景代替空泛形容词，让用户在脑中自动代入「我用了会怎样」。

三、四大结构
1. 黄金开头结构：身份呼唤 + 痛点暴击的组合。第一句锁定目标人群身份，第二句戳中现状痛点或制造反差，在前 3 秒锁住注意力。
2. 高密度信息结构：中段快速输出多个价值点，从软性背书（年限/口碑/人设）到硬核卖点层层递进，让用户在短时间内感受到专业度与信息量。
3. 场景化种草结构：用具体的应用场景描述产品或服务，消解用户的畏难情绪与决策门槛，让用户自动代入使用画面。
4. 行动号召结构：结尾用心理暗示式 CTA 升华（趋势/时机/身份认同），自然地引导私信、到店或咨询，不生硬喊话。

四、反幻觉铁律
- 不擅自编造产品参数、价格、优惠、数据、使用经历或效果承诺
- 文案中的事实必须能溯源到门店档案（名称/行业/位置/主营/特色/人设信息）与素材分析结果；档案里没写的不要编
- 数字类表述只能使用档案与素材中出现过的（如店龄、称呼）

五、负面约束
- 不客套开场（不说「大家好」「欢迎来到本视频」）
- 不输出 markdown、标题、列表符号、Emoji
- 只输出要求的 JSON 字段，不解释创作过程、不复述本规则
- 不输出镜头说明或舞台指令
- 不使用「文案」「脚本」「口播稿」这类元词汇谈论作品本身`;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/copywriting-rules.test.ts`
Expected: 4 测试 PASS

- [ ] **Step 5: Commit**

```bash
git add lib/copywriting-rules.ts tests/copywriting-rules.test.ts
git commit -m "feat(copy): 文案规则文件——三大原则/四大结构/反幻觉/负面约束 + 5角度轮换——批次二 Task3"
```

---

### Task 4: 文案引擎改造（规则注入 + 角度 + 解析）

**Files:**
- Modify: `lib/services/script-engine.ts`（SYSTEM_PROMPT L79-92、SCHEMA_DESCRIPTION L94-102、buildUserPrompt L112-145、createScriptDraftWithAI L202-287、buildDraft L340-375、sanitizeCopy L411-428、ScriptDraftInput L13-23、AIScriptResponse L37-48）
- Test: `tests/script-engine-rules.test.ts`（新建）

- [ ] **Step 1: 写失败测试**

新建 `tests/script-engine-rules.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import type { StoreProfile } from "@/lib/types";
import { createId, nowIso } from "@/lib/ids";

// 通过模块级 mock 拦 AI 调用，验证 prompt 组装与解析处理
import { vi } from "vitest";
vi.mock("@/lib/services/ai-client", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/services/ai-client")>();
  return { ...mod, chatCompletionJSON: vi.fn() };
});

import { chatCompletionJSON } from "@/lib/services/ai-client";
import { createScriptDraft } from "@/lib/services/script-engine";

const chatMock = vi.mocked(chatCompletionJSON);

function makeStore(): StoreProfile {
  return {
    id: createId("store"), ownerId: "demo", name: "华荧慧", industry: "商业服务",
    location: "广东省深圳市龙岗区", nickname: "君姐", ownerAge: 48, yearsInBusiness: 15,
    mainProducts: ["短视频代运营"], targetCustomers: ["门店老板"],
    sellingPoints: ["15年行业深耕经验"], promotions: [], brandTone: "亲切接地气",
    forbiddenWords: [], createdAt: nowIso(), updatedAt: nowIso(),
  };
}

const aiPayload = {
  title: "龙岗君姐15年", hook: "深圳创业老板注意啦",
  voiceover: "深圳创业老板注意啦。以前靠等客的日子现在该换个打法了。",
  highlights: ["深圳创业老板"], onCameraSentences: ["深圳创业老板注意啦。"], cta: "私信君姐",
  analysis: { overview: "概述文本", principles: "原则解析文本", structure: "结构解析文本" },
};

describe("规则注入与角度", () => {
  it("system prompt 含三大原则；user prompt 含人设句与切入角度", async () => {
    chatMock.mockResolvedValueOnce(aiPayload);
    await createScriptDraft({ store: makeStore(), assetAnalyses: [], purpose: "store_traffic", angle: "痛点暴击" });
    const [system, user] = chatMock.mock.calls[0] as unknown as [string, string];
    expect(system).toContain("锁同城原则");
    expect(system).toContain("反幻觉");
    expect(user).toContain("君姐");
    expect(user).toContain("48");
    expect(user).toContain("15");
    expect(user).toContain("痛点暴击");
  });

  it("draft 落 angle 与 analysis", async () => {
    chatMock.mockResolvedValueOnce(aiPayload);
    const draft = await createScriptDraft({ store: makeStore(), assetAnalyses: [], purpose: "store_traffic", angle: "场景代入" });
    expect(draft.angle).toBe("场景代入");
    expect(draft.analysis?.overview).toBe("概述文本");
  });

  it("analysis 缺失容忍：AI 不返回该字段时文案照常出", async () => {
    const { analysis: _omit, ...noAnalysis } = aiPayload;
    chatMock.mockResolvedValueOnce(noAnalysis);
    const draft = await createScriptDraft({ store: makeStore(), assetAnalyses: [], purpose: "store_traffic" });
    expect(draft.voiceover).toContain("深圳创业老板");
    expect(draft.analysis).toBeUndefined();
  });

  it("模板兜底路径无 angle/analysis", async () => {
    const draft = await createScriptDraft({ store: makeStore(), assetAnalyses: [], purpose: "store_traffic", forcedRawCopy: "手动文案。" });
    expect(draft.angle).toBeUndefined();
    expect(draft.analysis).toBeUndefined();
  });
});

describe("sanitizeCopy 补强", () => {
  it("剥离 markdown 符号与 emoji", async () => {
    chatMock.mockResolvedValueOnce({
      ...aiPayload,
      voiceover: "**龙岗老板**注意啦🔥。## 先说结论。",
    });
    const draft = await createScriptDraft({ store: makeStore(), assetAnalyses: [], purpose: "store_traffic" });
    expect(draft.voiceover).not.toContain("*");
    expect(draft.voiceover).not.toContain("#");
    expect(draft.voiceover).not.toContain("🔥");
    expect(draft.voiceover).toContain("龙岗老板注意啦");
  });
});
```

（注意：mock 后 `createScriptDraft` 内部阶梯两次调用都走同一个 mock——high 档返回非 null 即不再调 low 档，每个用例 `mockResolvedValueOnce` 一次即可。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/script-engine-rules.test.ts`
Expected: FAIL（angle 参数不存在、规则未注入）

- [ ] **Step 3: script-engine.ts 改造**

3a. import 区加：

```ts
import { COPYWRITING_RULES, angleGuidance, type CopyAngle } from "@/lib/copywriting-rules";
```

3b. `ScriptDraftInput`（L13-23）加字段：

```ts
  /** 切入角度（批次二）：缺省默认序列首项「痛点暴击」。 */
  angle?: CopyAngle;
```

3c. `AIScriptResponse`（L37-48）加可选字段：

```ts
  analysis?: {
    overview?: unknown;
    principles?: unknown;
    structure?: unknown;
  };
```

3d. SYSTEM_PROMPT 改造（L79-92 整段替换）：

```ts
const SYSTEM_PROMPT = `你是为本地实体店创作短视频口播稿的营销文案专家。

${COPYWRITING_RULES}

输出硬性要求：
- 口播稿长度严格按用户给的【目标时长】要求的句数执行：逐句写满规定句数，不得少写（中文配音约每秒4.5字）
- 每句控制在8-15个字，方便朗读，句与句之间用中文句号分隔
- 严格按用户给的【本版切入角度】要求组织开头与叙事主线
- highlights：从口播稿中挑出需要字幕标黄的关键词（产品名/价格/活动/CTA），必须逐字摘自你写好的口播稿
- onCameraSentences：从口播稿中挑出适合真人出镜的句子（开场与结尾 CTA 优先），必须逐字摘自你写好的口播稿
- speakerAssignments：仅在给了【出镜形象】名单时必填；每句逐字摘自口播稿，speakerIndex 不得超过形象数量-1
- analysis：创作解析报告，放输出最后——overview 一句话概述本稿创作逻辑与目标人群；principles 逐条说明本稿如何体现三大原则；structure 逐段说明四大结构如何落地。各段 2-4 句，措辞面向商家读者

你会收到门店信息、素材分析结果、营销目的和发布平台，请根据这些信息创作口播稿。`;
```

3e. SCHEMA_DESCRIPTION（L94-102）尾部加 analysis：

```ts
const SCHEMA_DESCRIPTION = `{
  "title": "视频标题（10字以内）",
  "hook": "开头吸引句（15字以内）",
  "voiceover": "完整口播文案（按目标时长控制总字数）",
  "highlights": ["口播稿中需标黄的关键词原文"],
  "onCameraSentences": ["适合真人出镜的口播句原文"],
  "speakerAssignments": [{"speakerIndex": 0, "sentences": ["逐字口播句"]}],
  "cta": "行动号召文案",
  "analysis": {"overview": "创作逻辑概述", "principles": "三大原则对照解析", "structure": "四大结构对照解析"}
}`;
```

3f. buildUserPrompt：门店信息块的 `位置：` 行后插入人设行，函数尾部（return 前）加角度行：

```ts
    store.nickname || store.ownerAge || store.yearsInBusiness
      ? `店主人设：${[
          store.nickname ? sanitizePromptField(store.nickname, 20) : null,
          store.ownerAge ? `${store.ownerAge}岁` : null,
          store.yearsInBusiness ? `开店${store.yearsInBusiness}年` : null,
        ].filter(Boolean).join("，")}（可用于开头身份呼唤与地域背书，如「龙岗君姐15年」）`
      : null,
```

return 前加：

```ts
  lines.push(``, `【本版切入角度】${input.angle ?? "痛点暴击"}：${angleGuidance(input.angle ?? "痛点暴击")}`);
```

3g. createScriptDraftWithAI：解析 analysis 并传入 buildDraft。现有 `buildDraft({...})` 调用（L272-286）前加解析逻辑，调用参数加两个字段：

```ts
  // 解析缺失容忍（批次二 spec §4.2）：三字段均为非空字符串才采纳，否则整体落 undefined。
  const rawAnalysis = aiResponse.analysis;
  const analysis =
    rawAnalysis &&
    typeof rawAnalysis.overview === "string" && rawAnalysis.overview.trim() &&
    typeof rawAnalysis.principles === "string" && rawAnalysis.principles.trim() &&
    typeof rawAnalysis.structure === "string" && rawAnalysis.structure.trim()
      ? {
          overview: rawAnalysis.overview.trim(),
          principles: rawAnalysis.principles.trim(),
          structure: rawAnalysis.structure.trim(),
        }
      : undefined;
```

buildDraft 参数加：

```ts
      angle: input.angle ?? "痛点暴击",
      analysis,
```

3h. 阶梯 low 档 maxTokens 提高容纳解析（L227 附近）：`maxTokens: 3000` 改为 `maxTokens: 4096`（注释注明：+约 1k 容纳 analysis 三段文本）。

3i. buildDraft（L340-375）：input 类型加两字段，返回对象条件展开：

```ts
    /** 切入角度（仅 AI 路径有）。 */
    angle?: string;
    /** 创作解析（仅 AI 路径且未截断时有）。 */
    analysis?: CopyAnalysis;
```

返回对象加：

```ts
    ...(input.angle ? { angle: input.angle } : {}),
    ...(input.analysis ? { analysis: input.analysis } : {}),
```

（import 类型：`import type { ..., CopyAnalysis } from "@/lib/types"`。）

3j. sanitizeCopy 补强（L411-428）：违禁词循环之前插入剥离：

```ts
  // 第二道防线（批次二，借鉴 MPT format_response / svf cleanGeneratedText）：
  // 剥 code fence、markdown 符号、emoji——LLM 违反输出约束时兜底。
  let cleaned = copy
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*#`]/g, "")
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "");
```

（后续 `forbiddenWords` 处理与 `\s+` 折叠保持不变——注意把原 `let cleaned = copy;` 行删除，变量改用上面的初始化。）

- [ ] **Step 4: 跑测试确认通过 + 全量测试回归**

Run: `npx vitest run tests/script-engine-rules.test.ts && npm test`
Expected: 新测试 PASS；既有测试全绿（SYSTEM_PROMPT 变更可能影响断言旧 prompt 文本的测试——若有，按新规则文本更新断言，属于预期内更新）

- [ ] **Step 5: Commit**

```bash
git add lib/services/script-engine.ts tests/script-engine-rules.test.ts
git commit -m "feat(copy): 文案引擎接入规则文件+切入角度+解析字段+清洗补强——批次二 Task4"
```

---

### Task 5: 换方向按钮 + 折叠解析 UI + 路由 angle 透传

**Files:**
- Modify: `app/api/script-drafts/route.ts`（POST L21-74）
- Modify: `lib/api-client.ts`（createScriptDraftApi L245-257）
- Modify: `components/script-confirm.tsx`（按钮区 L181-190、voiceoverPreview L111-115 附近）
- Modify: `components/dashboard.tsx`（generateScript L1020-1052、ScriptConfirm 渲染 L1625-1635）
- Test: `tests/script-confirm-analysis.test.tsx`（新建）

- [ ] **Step 1: 写失败测试**

新建 `tests/script-confirm-analysis.test.tsx`：

```tsx
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ScriptConfirm } from "@/components/script-confirm";
import type { ScriptDraft } from "@/lib/types";
import { nowIso } from "@/lib/ids";

function makeDraft(overrides: Partial<ScriptDraft> = {}): ScriptDraft {
  return {
    id: "script_1", ownerId: "demo", storeId: "store_1",
    purpose: "store_traffic", platform: "douyin",
    title: "标题", hook: "钩子", scenes: [],
    voiceover: "口播稿第一句。口播稿第二句。",
    captions: [], cta: "到店", generationMode: "ai", complianceWarnings: [],
    createdAt: nowIso(),
    ...overrides,
  };
}

const baseProps = {
  avatars: [], bgmTracks: [], librarySelectedAssetIds: [],
  onConfirm: async () => {}, pending: false,
};

describe("文案解析折叠区", () => {
  it("draft.analysis 存在时渲染折叠区，含三段文本", () => {
    render(
      <ScriptConfirm
        {...baseProps}
        draft={makeDraft({
          angle: "痛点暴击",
          analysis: { overview: "这是概述", principles: "这是原则解析", structure: "这是结构解析" },
        })}
      />,
    );
    expect(screen.getByText("查看创作解析")).toBeTruthy();
    expect(screen.getByText("这是概述")).toBeTruthy();
    expect(screen.getByText("这是原则解析")).toBeTruthy();
    expect(screen.getByText("这是结构解析")).toBeTruthy();
  });

  it("analysis 缺失时不渲染折叠区", () => {
    render(<ScriptConfirm {...baseProps} draft={makeDraft()} />);
    expect(screen.queryByText("查看创作解析")).toBeNull();
  });
});

describe("换个表达方向", () => {
  it("点击触发 onChangeAngle，按钮显示当前角度", () => {
    const onChangeAngle = vi.fn();
    render(
      <ScriptConfirm {...baseProps} draft={makeDraft({ angle: "痛点暴击" })} onChangeAngle={onChangeAngle} />,
    );
    const btn = screen.getByRole("button", { name: /换个表达方向/ });
    expect(btn.textContent).toContain("痛点暴击");
    fireEvent.click(btn);
    expect(onChangeAngle).toHaveBeenCalledTimes(1);
  });

  it("未提供 onChangeAngle 时不渲染按钮（模板兜底稿等场景）", () => {
    render(<ScriptConfirm {...baseProps} draft={makeDraft()} />);
    expect(screen.queryByRole("button", { name: /换个表达方向/ })).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/script-confirm-analysis.test.tsx`
Expected: FAIL（onChangeAngle prop / 折叠区不存在）

- [ ] **Step 3: script-confirm.tsx 改造**

3a. Props interface（L31-39）加：

```ts
  /** 换个表达方向（批次二）：仅 AI 生成稿传入；点击按角度序列重生成。 */
  onChangeAngle?: () => void;
  /** 换方向进行中（禁用按钮+spinner）。 */
  changingAngle?: boolean;
```

函数参数解构加 `onChangeAngle, changingAngle`。

3b. 折叠解析区：在 `div.voiceoverPreview`（L111-115）之后插入：

```tsx
      {draft.analysis ? (
        <details className="copyAnalysis" style={{ marginTop: 8 }}>
          <summary style={{ cursor: "pointer", color: "var(--muted, #888)" }}>查看创作解析</summary>
          <div style={{ marginTop: 8, fontSize: 13, lineHeight: 1.7 }}>
            <p><strong>概述</strong>：{draft.analysis.overview}</p>
            <p><strong>三大原则解析</strong>：{draft.analysis.principles}</p>
            <p><strong>四大结构解析</strong>：{draft.analysis.structure}</p>
          </div>
        </details>
      ) : null}
```

3c. 换方向按钮：确认生成按钮（L181-190）包成 flex 行，左侧加按钮：

```tsx
    <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
      {onChangeAngle ? (
        <button
          type="button"
          className="secondaryButton"
          disabled={pending || changingAngle}
          onClick={onChangeAngle}
        >
          {changingAngle ? <span className="spinner" aria-hidden="true" /> : null}
          换个表达方向{draft.angle ? `（当前：${draft.angle}）` : ""}
        </button>
      ) : null}
      <button
        type="button"
        className="primaryButton"
        disabled={!canConfirm || changingAngle}
        onClick={handleConfirm}
      >
        {pending ? <span className="spinner" aria-hidden="true" /> : null}
        确认生成
      </button>
    </div>
```

（删掉原确认按钮的 `style={{ marginTop: 16 }}`，由 flex 容器接管间距。）

- [ ] **Step 4: script-drafts 路由 angle 透传**

`app/api/script-drafts/route.ts` POST：

- import 加：`import { COPY_ANGLES, type CopyAngle } from "@/lib/copywriting-rules";`
- `durationSlot`  helper 后加：

```ts
const angleParam = (v: unknown): CopyAngle | undefined =>
  typeof v === "string" && (COPY_ANGLES as readonly string[]).includes(v) ? (v as CopyAngle) : undefined;
```

- `createScriptDraft({...})` 调用参数加：`angle: angleParam(body.angle),`

- [ ] **Step 5: api-client.ts createScriptDraftApi 加 angle**

入参类型加 `angle?: string;`，body 组装处加 `angle: input.angle`（undefined 时 JSON 序列化自动省略）。

- [ ] **Step 6: dashboard.tsx 接线**

6a. import 加：`import { nextAngle } from "@/lib/copywriting-rules";`

6b. state 加（`generating` 附近）：

```ts
  const [changingAngle, setChangingAngle] = useState(false);
```

6c. 新 handler（generateScript 后）：

```ts
  /** 换个表达方向（批次二）：按角度序列取下一角度重新生成，替换确认卡片。 */
  async function handleChangeAngle() {
    if (!store || !confirmDraft || changingAngle || generating) return;
    setChangingAngle(true);
    try {
      const draft = await createScriptDraftApi({
        storeId: store.id,
        assetAnalysisIds: selectedAnalyses.map((a) => a.id),
        purpose: selectedPurpose,
        platform: "douyin",
        targetDurationSec: targetDuration,
        angle: nextAngle(confirmDraft.angle),
      });
      setConfirmDraft(draft);
      setLocalScript(draft);
      await queryClient.invalidateQueries({ queryKey: ["script-drafts"] });
      setMessage(`已换「${draft.angle ?? "新角度"}」重新生成，看看这版。`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "请稍后重试";
      setMessage(`换方向生成失败：${detail}`);
    } finally {
      setChangingAngle(false);
    }
  }
```

6d. ScriptConfirm 渲染（L1625-1635）加 props：

```tsx
              onChangeAngle={confirmDraft.generationMode === "ai" ? () => void handleChangeAngle() : undefined}
              changingAngle={changingAngle}
```

- [ ] **Step 7: 跑测试确认通过 + 全量回归**

Run: `npx vitest run tests/script-confirm-analysis.test.tsx && npm test`
Expected: 新测试 PASS；dashboard 既有测试绿（ScriptConfirm props 增加为可选，不破坏既有渲染）

- [ ] **Step 8: Commit**

```bash
git add app/api/script-drafts/route.ts lib/api-client.ts components/script-confirm.tsx components/dashboard.tsx tests/script-confirm-analysis.test.tsx
git commit -m "feat(copy): 换个表达方向按钮（角度轮换重生成）+ 折叠创作解析——批次二 Task5"
```

---

### Task 6: 档案 UI 候选池（主营/特色两区块）

**Files:**
- Create: `components/store-field-candidates.tsx`
- Modify: `components/dashboard.tsx`（StoreFormValues L52-62、defaultStoreForm L76-86、storeFormSteps L88-137、storeProfileToFormValues L182-194、表单渲染 L1172-1263、submitCurrentStoreStep L591-651、handleSuggestStore L658-685）
- Test: `tests/store-field-candidates.test.tsx`（新建）

- [ ] **Step 1: 写失败测试（组件）**

新建 `tests/store-field-candidates.test.tsx`：

```tsx
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { StoreFieldCandidates } from "@/components/store-field-candidates";

const baseProps = {
  label: "门店的主营业务",
  items: ["短视频代运营"],
  max: 10,
  candidates: ["同城引流", "团购套餐设计"],
  loading: false,
  onAdd: vi.fn(),
  onRemove: vi.fn(),
  onRefreshCandidates: vi.fn(),
};

describe("StoreFieldCandidates", () => {
  it("渲染已填条目（带计数）与候选池", () => {
    render(<StoreFieldCandidates {...baseProps} />);
    expect(screen.getByText("短视频代运营")).toBeTruthy();
    expect(screen.getByText(/1\/10/)).toBeTruthy();
    expect(screen.getByText("同城引流")).toBeTruthy();
    expect(screen.getByText("团购套餐设计")).toBeTruthy();
  });

  it("点「填入」回调 onAdd；点删除回调 onRemove", () => {
    const onAdd = vi.fn();
    const onRemove = vi.fn();
    render(<StoreFieldCandidates {...baseProps} onAdd={onAdd} onRemove={onRemove} />);
    fireEvent.click(screen.getByRole("button", { name: "填入 同城引流" }));
    expect(onAdd).toHaveBeenCalledWith("同城引流");
    fireEvent.click(screen.getByRole("button", { name: "删除 短视频代运营" }));
    expect(onRemove).toHaveBeenCalledWith(0);
  });

  it("手动输入添加", () => {
    const onAdd = vi.fn();
    render(<StoreFieldCandidates {...baseProps} onAdd={onAdd} />);
    fireEvent.change(screen.getByPlaceholderText("手动输入后回车添加"), { target: { value: "新条目" } });
    fireEvent.keyDown(screen.getByPlaceholderText("手动输入后回车添加"), { key: "Enter" });
    expect(onAdd).toHaveBeenCalledWith("新条目");
  });

  it("达上限时填入与添加禁用并提示", () => {
    render(
      <StoreFieldCandidates
        {...baseProps}
        items={Array.from({ length: 10 }, (_, i) => `条目${i}`)}
      />,
    );
    expect(screen.getByText(/已达上限/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "填入 同城引流" })).toHaveProperty("disabled", true);
  });

  it("已在列表中的候选不重复展示填入", () => {
    render(<StoreFieldCandidates {...baseProps} candidates={["短视频代运营", "同城引流"]} />);
    expect(screen.queryByRole("button", { name: "填入 短视频代运营" })).toBeNull();
    expect(screen.getByRole("button", { name: "填入 同城引流" })).toBeTruthy();
  });

  it("重新生成一批回调", () => {
    const onRefresh = vi.fn();
    render(<StoreFieldCandidates {...baseProps} onRefreshCandidates={onRefresh} />);
    fireEvent.click(screen.getByRole("button", { name: /重新生成一批/ }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/store-field-candidates.test.tsx`
Expected: FAIL（组件不存在）

- [ ] **Step 3: 实现组件**

新建 `components/store-field-candidates.tsx`：

```tsx
"use client";

import { useState } from "react";

interface Props {
  /** 区块标题（如「门店的主营业务」）。 */
  label: string;
  /** 已填条目。 */
  items: string[];
  /** 上限（主营 10 / 特色 12）。 */
  max: number;
  /** AI 候选池（未填入的候选）。 */
  candidates: string[];
  /** 候选池加载中。 */
  loading: boolean;
  onAdd: (value: string) => void;
  onRemove: (index: number) => void;
  onRefreshCandidates: () => void;
}

/**
 * 档案字段候选池（批次二，参照参考图）：已填条目列表 + 手动输入 + AI 候选池
 * （逐条「填入」+「重新生成一批」）。表单值仍由调用方以逗号串存 react-hook-form，
 * 本组件只收发数组，不感知表单库。
 */
export function StoreFieldCandidates({ label, items, max, candidates, loading, onAdd, onRemove, onRefreshCandidates }: Props) {
  const [manual, setManual] = useState("");
  const full = items.length >= max;
  const pool = candidates.filter((c) => !items.includes(c));

  function submitManual() {
    const value = manual.trim();
    if (!value || full || items.includes(value)) return;
    onAdd(value);
    setManual("");
  }

  return (
    <div className="fieldCandidates" style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <strong>{label}</strong>
        <span style={{ fontSize: 12, color: "var(--muted, #888)" }}>{items.length}/{max}{full ? "（已达上限）" : ""}</span>
      </div>

      {items.length > 0 ? (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 4 }}>
          {items.map((item, index) => (
            <li key={`${item}-${index}`} style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <span>{index + 1}. {item}</span>
              <button type="button" className="secondaryButton" aria-label={`删除 ${item}`} onClick={() => onRemove(index)}>删除</button>
            </li>
          ))}
        </ul>
      ) : null}

      <input
        type="text"
        placeholder="手动输入后回车添加"
        value={manual}
        disabled={full}
        onChange={(e) => setManual(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submitManual(); } }}
      />

      <div style={{ borderTop: "1px solid var(--border, #333)", paddingTop: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 13 }}>选择你的{label.replace(/^门店的/, "")}</span>
          <button type="button" className="secondaryButton" disabled={loading} onClick={onRefreshCandidates}>
            {loading ? <span className="spinner" aria-hidden="true" /> : null}
            ↻ 重新生成一批
          </button>
        </div>
        {pool.length > 0 ? (
          <ul style={{ listStyle: "none", margin: "8px 0 0", padding: 0, display: "grid", gap: 4 }}>
            {pool.map((candidate) => (
              <li key={candidate} style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <span>{candidate}</span>
                <button type="button" className="secondaryButton" disabled={full} aria-label={`填入 ${candidate}`} onClick={() => onAdd(candidate)}>填入</button>
              </li>
            ))}
          </ul>
        ) : (
          <p style={{ fontSize: 12, color: "var(--muted, #888)" }}>{loading ? "AI 生成候选中…" : "点「重新生成一批」让 AI 给候选"}</p>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 跑组件测试确认通过**

Run: `npx vitest run tests/store-field-candidates.test.tsx`
Expected: 6 测试 PASS

- [ ] **Step 5: dashboard.tsx 接线**

5a. `StoreFormValues`（L52-62）加三字段（全字符串，与现结构一致）：

```ts
  nickname: string;
  ownerAge: string;
  yearsInBusiness: string;
```

5b. `defaultStoreForm`（L76-86）加：

```ts
  nickname: "",
  ownerAge: "",
  yearsInBusiness: "",
```

5c. `storeFormSteps` step1 字段列表（L88-137，location 后）加：

```ts
        { name: "nickname", label: "朋友们对你的称呼", kind: "input", placeholder: "如：君姐（可选）" },
        { name: "ownerAge", label: "您的年龄", kind: "input", placeholder: "如：48（可选）" },
        { name: "yearsInBusiness", label: "店开了多少年了", kind: "input", placeholder: "如：15（可选，填数字）" },
```

（字段类型以现有 `StoreField` 为准对齐属性名；required 不设。）

5d. `storeProfileToFormValues`（L182-194）加：

```ts
    nickname: store.nickname ?? "",
    ownerAge: store.ownerAge != null ? String(store.ownerAge) : "",
    yearsInBusiness: store.yearsInBusiness != null ? String(store.yearsInBusiness) : "",
```

5e. `submitCurrentStoreStep`（L591-651）组装 profile 处加（`splitCsv` 同级）：

```ts
      nickname: values.nickname.trim() || undefined,
      ownerAge: values.ownerAge.trim() ? Number(values.ownerAge.trim()) : undefined,
      yearsInBusiness: values.yearsInBusiness.trim() ? Number(values.yearsInBusiness.trim()) : undefined,
```

（Number 转换后若 NaN——schema 的 int/min/max 会 400 拦截并在 UI 显示错误，属预期防御。）

5f. 候选池 state（组件顶部 hooks 区）：

```ts
  const [fieldCandidates, setFieldCandidates] = useState<{ mainProducts: string[]; sellingPoints: string[] }>({ mainProducts: [], sellingPoints: [] });
  const [candidatesLoading, setCandidatesLoading] = useState<"" | "mainProducts" | "sellingPoints">("");
```

5g. 候选池拉取函数：

```ts
  /** 拉一批 AI 候选（批次二）：exclude 已填+池中现存，避免重复。 */
  async function refreshFieldCandidates(field: "mainProducts" | "sellingPoints") {
    const values = getValues();
    if (!values.name.trim() || !values.industry.trim()) {
      setMessage("请先填写门店名称与行业，AI 才能给候选。");
      return;
    }
    setCandidatesLoading(field);
    try {
      const existing = splitCsv(values[field]);
      const candidates = await suggestFieldCandidatesApi({
        name: values.name.trim(),
        industry: values.industry.trim(),
        location: values.location.trim() || undefined,
        field,
        exclude: [...existing, ...fieldCandidates[field]],
        nickname: values.nickname.trim() || undefined,
        ownerAge: values.ownerAge.trim() ? Number(values.ownerAge.trim()) : undefined,
        yearsInBusiness: values.yearsInBusiness.trim() ? Number(values.yearsInBusiness.trim()) : undefined,
      });
      setFieldCandidates((prev) => ({ ...prev, [field]: candidates }));
    } catch (error) {
      const detail = error instanceof Error ? error.message : "请稍后重试";
      setMessage(`候选生成失败：${detail}`);
    } finally {
      setCandidatesLoading("");
    }
  }
```

（import 加 `suggestFieldCandidatesApi`；`splitCsv` 复用现有 L1781。）

5h. 表单渲染改造（L1172-1263）：`mainProducts` 与 `sellingPoints` 两个字段从 textarea 渲染循环中特判出来，改用组件。在渲染循环的字段 map 里对这两个 name 跳过（`if (field.name === "mainProducts" || field.name === "sellingPoints") return null;`），并在 step2 区块渲染两个组件实例：

```tsx
          <StoreFieldCandidates
            label="门店的主营业务"
            items={splitCsv(watch("mainProducts"))}
            max={10}
            candidates={fieldCandidates.mainProducts}
            loading={candidatesLoading === "mainProducts"}
            onAdd={(v) => setValue("mainProducts", [...splitCsv(watch("mainProducts")), v].join("，"), { shouldDirty: true })}
            onRemove={(i) => setValue("mainProducts", splitCsv(watch("mainProducts")).filter((_, idx) => idx !== i).join("，"), { shouldDirty: true })}
            onRefreshCandidates={() => void refreshFieldCandidates("mainProducts")}
          />
          <StoreFieldCandidates
            label="门店特色/优势"
            items={splitCsv(watch("sellingPoints"))}
            max={12}
            candidates={fieldCandidates.sellingPoints}
            loading={candidatesLoading === "sellingPoints"}
            onAdd={(v) => setValue("sellingPoints", [...splitCsv(watch("sellingPoints")), v].join("，"), { shouldDirty: true })}
            onRemove={(i) => setValue("sellingPoints", splitCsv(watch("sellingPoints")).filter((_, idx) => idx !== i).join("，"), { shouldDirty: true })}
            onRefreshCandidates={() => void refreshFieldCandidates("sellingPoints")}
          />
```

（react-hook-form 的 `watch`/`setValue`/`getValues` 现有已在组件内使用，直接复用。）

5i. step2 的「AI 建议」按钮收窄到 step3：L1253 的条件 `storeFormStep >= 1` 改为 `storeFormStep >= 2`（step2 已由候选池接管；`handleSuggestStore` 整组建议保留给 step3 的 promotions/brandTone）。同时 `handleSuggestStore` 内对 mainProducts/sellingPoints 的 setValue 删除（只填 promotions/brandTone/targetCustomers），避免覆盖用户精挑的候选池结果——把 L673-677 的 setValue 行收窄为：

```ts
        setValue("targetCustomers", suggestion.targetCustomers.join("，"), { shouldDirty: true });
        setValue("promotions", suggestion.promotions.join("，"), { shouldDirty: true });
        if (suggestion.brandTone) setValue("brandTone", suggestion.brandTone, { shouldDirty: true });
```

- [ ] **Step 6: 全量测试回归**

Run: `npm test`
Expected: 全绿。dashboard 既有测试若断言旧 textarea/AI 建议按钮行为，按新交互更新（预期内更新，逐条核对不是真回归）

- [ ] **Step 7: Commit**

```bash
git add components/store-field-candidates.tsx components/dashboard.tsx tests/store-field-candidates.test.tsx
git commit -m "feat(store): 档案表单候选池交互（主营≤10/特色≤12 + 3人设字段）——批次二 Task6"
```

---

### Task 7: 五件套 + 推送

- [ ] **Step 1: 五件套全量验证**

Run: `npm test && npm run typecheck && npm run lint && npx prisma validate && npm run build`
Expected: 全绿（测试数 ≥ 批次二前 +20）

- [ ] **Step 2: Commit 剩余 + push**

```bash
git status   # 确认无遗漏文件
git push origin main
```

Expected: Zeabur 自动部署触发；迁移随部署自动应用（沿用既有机制）

- [ ] **Step 3: 验收路径（部署后人工）**

1. 档案页：填名称/行业/位置/称呼/年龄/店龄 → step2 两个候选池各拉一批 → 逐条填入 → 重新生成一批不重复 → 保存
2. 生成文案 → 确认卡片显示当前角度 → 点「换个表达方向」→ 新稿角度变化 → 展开「查看创作解析」三段齐全
3. 确认生成出片，全流程无报错

---

## Self-Review 记录

- **Spec 覆盖**：spec §3.1/4.3 迁移→Task1；§3.2 候选池 API→Task2；§4.1 规则文件→Task3；§4.2 引擎→Task4；§3.3 UI + §4.4 解析/换方向→Task5/6；§9 测试→各 Task TDD；§11 部署验收→Task7。✅
- **Placeholder 扫描**：无 TBD；所有代码步骤含完整代码。✅
- **类型一致性**：`suggestFieldCandidates`（服务）/`suggestFieldCandidatesApi`（前端）命名一致；`nextAngle`/`angleGuidance` 在 Task3 定义、Task5 使用一致；`CopyAnalysis` 在 Task1 types.ts 定义、Task4 script-engine 引用一致；`storeSuggestionV2InputSchema` Task2 定义与测试引用一致。✅
- **已知坑标注**：Task1 的 DATABASE_URL 覆盖坑、prisma upsert 白名单坑均已写入步骤。✅
