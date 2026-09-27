# Phase 3：用户形象 + 多形象轮播 + 分段生成 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 spec §6（`docs/superpowers/specs/2026-08-16-voiceover-centric-pipeline-design.md`）：用户上传人像视频创建真 HeyGen 数字分身（含 webcam 授权流）、多形象轮播口播、出镜段数字人视频 + 画外音段克隆声音 TTS 的分段生成渲染管线。

**Architecture:** 以 `AvatarProfile.providerAvatarId` 为权威（删除 env 模板覆盖逻辑，env 模板降级为平台公共形象兜底）。`Asset.category` 区分素材与人像视频。`talking_head` 处理器从「整段一个视频」升级为「按 segments 分段生成 + manifest 落 R2」，`video_render` 检测 manifest 走混排时间线（多 presenter 输入 filter graph）。TTS 返回 word_timestamps 使字幕按句精准对齐。

**Tech Stack:** Next.js 16 App Router、React 19、Prisma 7、BullMQ、Vitest、HeyGen REST API（v3 avatars / consent / voices/speech）。

**执行须知（每个任务通用）:**
- TDD：先写测试 → 跑到红 → 实现 → 跑到绿 → commit。每个任务结尾跑该任务相关测试文件 `npx vitest run <file>`，绿了之后跑全量 `npm test` 确认零回归再 commit。
- 提交信息用英文 conventional commits（与 git log 一致）。
- Prisma migration 用 `npx prisma migrate dev --name <name>` 生成（需本地 `.env` 的 `DATABASE_URL` 指向开发库）。
- 任何时候 `process.env` 直读禁止——用 `lib/env.ts` accessor。

---

### Task 0: HeyGen 真 key 冒烟验证（手工 gate，用户执行）

> 非代码任务。spec「风险与开放问题」#1/#2/#4 要求 Phase 3 实施前用真 key 验证。Task 1–2（纯数据层）不依赖本任务；Task 3（HeyGen provider 实现）之后、部署之前必须完成。

**Files:**
- 无代码改动；结果记录到本文件末尾「冒烟验证记录」或当面回报。

- [ ] **Step 1: 验证 digital_twin 创建 API 是否对当前订阅开放**

```bash
# 需要真 AVATAR_PROVIDER_API_KEY。视频 URL 用任意可公网访问的 30s+ 正脸讲话 mp4。
curl -s -X POST "https://api.heygen.com/v3/avatars" \
  -H "X-Api-Key: $HEYGEN_KEY" -H "Content-Type: application/json" \
  -d '{"type":"digital_twin","name":"smoke-test","video_url":"<PUBLIC_MP4_URL>"}'
```

预期：返回含 `group_id`（或等价字段）的 envelope。若 403/付费墙 → 停线回报，Phase 3 的 6.2 需要降级方案（photo avatar 或维持平台形象）。

- [ ] **Step 2: 验证 consent 链接签发**

```bash
curl -s -X POST "https://api.heygen.com/v3/avatars/<GROUP_ID>/consent" \
  -H "X-Api-Key: $HEYGEN_KEY" -H "Content-Type: application/json" -d '{}'
```

预期：返回授权链接（24h 有效）。**记录响应 JSON 的准确字段名**（`url` / `consent_url` / 嵌套层级）——Task 3 的解析代码以此为准。

- [ ] **Step 3: 验证分组状态轮询端点与字段形状**

```bash
curl -s "https://api.heygen.com/v3/avatar_groups/<GROUP_ID>" -H "X-Api-Key: $HEYGEN_KEY"
```

预期：返回训练/consent 状态。**记录准确端点路径与字段名**（status 枚举值、look_id / voice_id 的位置）。若路径不是 `/v3/avatar_groups/{id}`，以实际为准并改动 Task 3 常量。

- [ ] **Step 4: 验证克隆声音 TTS 与中文 word_timestamps**

需先有一个 ready 的分身（Step 1-3 走完授权+训练，或用现有模板声音）。 

```bash
curl -s -X POST "https://api.heygen.com/v3/voices/speech" \
  -H "X-Api-Key: $HEYGEN_KEY" -H "Content-Type: application/json" \
  -d '{"voice_id":"<VOICE_ID>","text":"今天来店里尝尝刚出炉的招牌蛋糕。"}'
```

预期：返回 `audio_url`、`duration`、`word_timestamps`。**记录：timestamps 单位是秒还是毫秒、中文粒度是按字还是按词。** Task 3 的归一化代码以此为准。

---

### Task 1: Asset.category 数据模型与上传链路

**Files:**
- Modify: `prisma/schema.prisma`（Asset model，约 line 78-99）
- Modify: `lib/types.ts:55-73`（Asset interface）
- Modify: `lib/repositories/mappers.ts:71-113`（toAsset / toAssetInput）
- Modify: `lib/schemas.ts:44-73`（confirmAssetUploadSchema / assetSchema）
- Modify: `lib/services/assets.ts:12-27,111-150`（UploadIntentInput / createUploadIntent）
- Modify: `app/api/assets/upload-intent/route.ts:12-34`
- Modify: `app/api/assets/confirm/route.ts:75-88`
- Modify: `worker/processors/video-render.ts:124-127`（渲染侧排除人像素材）
- Test: `tests/repositories/asset.test.ts`、`tests/api/assets-confirm.test.ts`、`tests/api/upload-intent.test.ts`、`tests/schemas.test.ts`

- [ ] **Step 1: 写失败测试 — category 双 repo 语义 + schema**

在 `tests/repositories/asset.test.ts` 追加（参照该文件既有 fixture 构造方式）：

```ts
it("persists category and defaults to material (memory repo)", async () => {
  const repo = new MemoryAssetRepository();
  const base = buildAsset({ id: "asset_mat" }); // 沿用文件内既有 fixture helper
  await repo.create(base);
  expect((await repo.findById("asset_mat"))?.category).toBe("material");

  await repo.create({ ...buildAsset({ id: "asset_av" }), category: "avatar_footage" });
  expect((await repo.findById("asset_av"))?.category).toBe("avatar_footage");
});
```

在 `tests/schemas.test.ts` 追加：

```ts
it("assetSchema defaults category to material and accepts avatar_footage", () => {
  const minimal = {
    id: "asset_1", ownerId: "o", storeId: "s", type: "video",
    originalFilename: "a.mp4", storageKey: "k", mimeType: "video/mp4",
    sizeBytes: 10, status: "uploaded", createdAt: new Date().toISOString(),
  };
  expect(assetSchema.parse(minimal).category).toBe("material");
  expect(assetSchema.parse({ ...minimal, category: "avatar_footage" }).category).toBe("avatar_footage");
  expect(assetSchema.safeParse({ ...minimal, category: "nope" }).success).toBe(false);
});
```

在 `tests/api/assets-confirm.test.ts` 追加（沿用该文件既有 mock/存储 stub 模式）：

```ts
it("persists category=avatar_footage from the confirm payload", async () => {
  // 构造合法 confirm body + category: "avatar_footage"，POST 后断言
  // getAssetRepository().findById(assetId)?.category === "avatar_footage"
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/repositories/asset.test.ts tests/schemas.test.ts tests/api/assets-confirm.test.ts`
Expected: FAIL（`category` 不在类型/ schema 上，编译或断言失败）

- [ ] **Step 3: 实现数据模型与链路**

`prisma/schema.prisma` Asset model 加字段（放在 `status` 后）：

```prisma
  status              String
  category            String          @default("material")
```

`lib/types.ts`：

```ts
export type AssetCategory = "material" | "avatar_footage";

export interface Asset {
  // …既有字段不变…
  status: AssetStatus;
  /** material=素材库 b-roll；avatar_footage=数字分身训练人像视频（永不进渲染时间线）。 */
  category: AssetCategory;
  createdAt: string;
}
```

`lib/repositories/mappers.ts` toAsset 加 `category: (row.category as Asset["category"]) ?? "material"`；toAssetInput 加 `category: asset.category`（import AssetCategory 不需要，用 `Asset["category"]`）。

`lib/schemas.ts`：assetSchema 与 confirmAssetUploadSchema 各加：

```ts
category: z.enum(["material", "avatar_footage"]).default("material"),
```

`lib/services/assets.ts`：

```ts
interface UploadIntentInput {
  ownerId: string;
  storeId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  /** material（默认）| avatar_footage。人像视频走同一存储链路与 MIME 校验。 */
  category?: "material" | "avatar_footage";
}
```

`createUploadIntent` 函数体不变（category 不进 storageKey——confirm 时落库即可；intent 无需携带）。**注意：upload-intent 路由必须把 category 校验后透传到响应**，让前端 confirm 时回传同一值：

`app/api/assets/upload-intent/route.ts` body 类型加 `category?: unknown`，在 `createUploadIntent` 调用前加：

```ts
const category = body.category === undefined ? "material" : body.category;
if (category !== "material" && category !== "avatar_footage") {
  return jsonError("category must be material or avatar_footage", 400);
}
```

`createUploadIntent({ ..., category })`；返回值 `UploadIntent` 加 `category: "material" | "avatar_footage"` 字段并在响应中带回。

`app/api/assets/confirm/route.ts`：`confirmAssetUploadSchema.parse` 已含 category（Step 3 schemas 改动）；在 `getAssetRepository().create({...})` 字面量中加 `category: input.category`。

`worker/processors/video-render.ts` 素材解析处（现 line 124-127）改为：

```ts
  // Resolve selected assets (filter to existing ones). avatar_footage 是数字分身
  // 训练素材，即使用户端把它塞进 selectedAssetIds 也绝不进 b-roll 时间线。
  const assetResults = await Promise.all(
    project.selectedAssetIds.map((id) => deps.assetRepository.findById(id))
  );
  const assets = assetResults.filter(
    (a): a is Asset => a !== null && (a.category ?? "material") === "material"
  );
```

- [ ] **Step 4: 生成 migration**

Run: `npx prisma migrate dev --name add_asset_category`
Expected: 生成 `prisma/migrations/<ts>_add_asset_category/migration.sql`，含 `ALTER TABLE "Asset" ADD COLUMN "category" TEXT NOT NULL DEFAULT 'material';`

- [ ] **Step 5: 跑测试确认通过 + 全量回归**

Run: `npx vitest run tests/repositories/asset.test.ts tests/schemas.test.ts tests/api/assets-confirm.test.ts tests/api/upload-intent.test.ts tests/video-render-processor-captions.test.ts` → PASS；然后 `npm test` → 全绿。

注意：代码里所有构造 Asset 字面量的测试 fixture 会因新增必填字段 `category` 报类型错——逐个补 `category: "material"`（`grep -rn "status: \"uploaded\"" tests/ lib/ worker/ | grep -v node_modules` 定位）。

- [ ] **Step 6: Commit**

```bash
git add prisma/ lib/types.ts lib/repositories/mappers.ts lib/schemas.ts lib/services/assets.ts app/api/assets/ worker/processors/video-render.ts tests/
git commit -m "feat(assets): add category (material|avatar_footage) across model, upload chain and render guard"
```

---

### Task 2: AvatarProfile 扩展字段 + AvatarRepository.update

**Files:**
- Modify: `prisma/schema.prisma`（AvatarProfile model，约 line 115-130）
- Modify: `lib/types.ts:88-100`
- Modify: `lib/repositories/types.ts:35-39`（AvatarRepository 加 update）
- Modify: `lib/repositories/mappers.ts:145-175`
- Modify: `lib/repositories/memory.ts:102-115`
- Modify: `lib/repositories/prisma.ts:152-169`
- Modify: `lib/schemas.ts:88-100`（avatarProfileSchema）
- Test: `tests/repositories/avatar.test.ts`（新建）

- [ ] **Step 1: 写失败测试**

新建 `tests/repositories/avatar.test.ts`：

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { MemoryAvatarRepository } from "@/lib/repositories/memory";
import { resetRuntimeStateForTests } from "@/lib/runtime-store";
import { nowIso } from "@/lib/ids";
import type { AvatarProfile } from "@/lib/types";

const savedDbUrl = process.env.DATABASE_URL;

function buildAvatar(overrides: Partial<AvatarProfile> = {}): AvatarProfile {
  const now = nowIso();
  return {
    id: "avatar_1",
    ownerId: "owner_1",
    storeId: "store_1",
    name: "店主本人",
    provider: "mock-avatar",
    providerAvatarId: undefined,
    providerVoiceId: undefined,
    providerGroupId: "group_1",
    consentStatus: "awaiting_user",
    trainingVideoAssetId: "asset_footage_1",
    statusReason: undefined,
    consentAcceptedAt: now,
    trainingStatus: "pending",
    fallbackMode: "tts_voiceover",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("AvatarRepository (memory)", () => {
  beforeEach(() => {
    delete process.env.DATABASE_URL;
    resetRuntimeStateForTests();
  });
  afterEach(() => {
    if (savedDbUrl) process.env.DATABASE_URL = savedDbUrl;
  });

  it("round-trips the Phase 3 fields (name/group/consent/footage/reason)", async () => {
    const repo = new MemoryAvatarRepository();
    await repo.create(buildAvatar());
    const loaded = await repo.findById("avatar_1");
    expect(loaded?.name).toBe("店主本人");
    expect(loaded?.providerGroupId).toBe("group_1");
    expect(loaded?.consentStatus).toBe("awaiting_user");
    expect(loaded?.trainingVideoAssetId).toBe("asset_footage_1");
  });

  it("update merges fields and preserves identity", async () => {
    const repo = new MemoryAvatarRepository();
    await repo.create(buildAvatar());
    const updated = await repo.update("avatar_1", {
      consentStatus: "approved",
      trainingStatus: "ready",
      providerAvatarId: "look_1",
      providerVoiceId: "voice_1",
    });
    expect(updated.consentStatus).toBe("approved");
    expect(updated.trainingStatus).toBe("ready");
    expect(updated.providerAvatarId).toBe("look_1");
    expect(updated.id).toBe("avatar_1");
    expect(updated.name).toBe("店主本人");
    expect((await repo.findById("avatar_1"))?.trainingStatus).toBe("ready");
  });

  it("update throws when the avatar does not exist", async () => {
    const repo = new MemoryAvatarRepository();
    await expect(repo.update("nope", { trainingStatus: "failed" })).rejects.toThrow();
  });

  it("legacy avatars without Phase 3 fields default sanely", async () => {
    const repo = new MemoryAvatarRepository();
    const legacy = buildAvatar();
    delete (legacy as Partial<AvatarProfile>).name;
    delete (legacy as Partial<AvatarProfile>).consentStatus;
    await repo.create(legacy as AvatarProfile);
    const loaded = await repo.findById("avatar_1");
    expect(loaded?.name).toBe("");
    expect(loaded?.consentStatus).toBe("approved");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/repositories/avatar.test.ts`
Expected: FAIL（类型错误：name/consentStatus 等不存在；update 不存在）

- [ ] **Step 3: 实现**

`lib/types.ts`：

```ts
export type AvatarConsentStatus = "awaiting_user" | "approved" | "rejected" | "expired";

export interface AvatarProfile {
  id: string;
  ownerId: string;
  storeId: string;
  /** 用户起的形象名（多形象 prompt 人设与 UI 展示用）；老数据为 ""。 */
  name: string;
  provider: AvatarProviderName;
  providerAvatarId?: string;
  providerVoiceId?: string;
  /** HeyGen avatar group id（digital_twin 创建时返回；授权/训练状态轮询的句柄）。 */
  providerGroupId?: string;
  /** 授权状态机：awaiting_user → approved | rejected | expired。老数据视为 approved。 */
  consentStatus: AvatarConsentStatus;
  /** 训练用人像视频（Asset.category="avatar_footage"）。 */
  trainingVideoAssetId?: string;
  /** 失败/被拒原因（UI 展示）。 */
  statusReason?: string;
  consentAcceptedAt: string;
  trainingStatus: AvatarTrainingStatus;
  fallbackMode: AvatarFallbackMode;
  createdAt: string;
  updatedAt: string;
}
```

`prisma/schema.prisma` AvatarProfile：

```prisma
  provider           String
  name               String       @default("")
  providerAvatarId   String?
  providerVoiceId    String?
  providerGroupId    String?
  consentStatus      String       @default("approved")
  trainingVideoAssetId String?
  statusReason       String?
```

（`consentStatus` 默认 `"approved"`：存量 mock 形象都是用户勾过授权的，回填语义正确；新建形象由路由显式写 `awaiting_user`。）

`lib/repositories/types.ts` AvatarRepository 加：

```ts
  update(id: string, data: Partial<AvatarProfile>): Promise<AvatarProfile>;
```

`lib/repositories/mappers.ts` toAvatarProfile 加：

```ts
    name: row.name ?? "",
    providerGroupId: row.providerGroupId ?? undefined,
    consentStatus: (row.consentStatus as AvatarProfile["consentStatus"]) ?? "approved",
    trainingVideoAssetId: row.trainingVideoAssetId ?? undefined,
    statusReason: row.statusReason ?? undefined,
```

toAvatarProfileInput 加：

```ts
    name: avatar.name,
    providerGroupId: avatar.providerGroupId ?? null,
    consentStatus: avatar.consentStatus,
    trainingVideoAssetId: avatar.trainingVideoAssetId ?? null,
    statusReason: avatar.statusReason ?? null,
```

`lib/repositories/memory.ts` MemoryAvatarRepository：create 处把缺省补齐（`name: avatar.name ?? ""`, `consentStatus: avatar.consentStatus ?? "approved"`，push 补齐后的对象），并加：

```ts
  async update(id: string, data: Partial<AvatarProfile>): Promise<AvatarProfile> {
    const state = getRuntimeState();
    const index = state.avatars.findIndex((a) => a.id === id);
    if (index < 0) throw new Error(`AvatarProfile not found: ${id}`);
    const updated = { ...state.avatars[index], ...data, id: state.avatars[index].id };
    state.avatars[index] = updated;
    return updated;
  }
```

`lib/repositories/prisma.ts` PrismaAvatarRepository 加（partial-update 模式同 PrismaRenderRepository.updateProject）：

```ts
  async update(id: string, data: Partial<AvatarProfile>): Promise<AvatarProfile> {
    const prismaData: Record<string, unknown> = {};
    if (data.name !== undefined) prismaData.name = data.name;
    if (data.providerAvatarId !== undefined) prismaData.providerAvatarId = data.providerAvatarId ?? null;
    if (data.providerVoiceId !== undefined) prismaData.providerVoiceId = data.providerVoiceId ?? null;
    if (data.providerGroupId !== undefined) prismaData.providerGroupId = data.providerGroupId ?? null;
    if (data.consentStatus !== undefined) prismaData.consentStatus = data.consentStatus;
    if (data.trainingStatus !== undefined) prismaData.trainingStatus = data.trainingStatus;
    if (data.statusReason !== undefined) prismaData.statusReason = data.statusReason ?? null;
    if (data.updatedAt !== undefined) prismaData.updatedAt = new Date(data.updatedAt);
    const row = await this.prisma.avatarProfile.update({ where: { id }, data: prismaData });
    return toAvatarProfile(row);
  }
```

`lib/schemas.ts` avatarProfileSchema 加：

```ts
  name: z.string().default(""),
  providerGroupId: z.string().optional(),
  consentStatus: z.enum(["awaiting_user", "approved", "rejected", "expired"]).default("approved"),
  trainingVideoAssetId: z.string().optional(),
  statusReason: z.string().optional(),
```

既有 `createAvatarProfile`（lib/services/avatar-provider.ts）构造的 AvatarProfile 字面量需补 `name: ""`（或从 input 传入——Task 4 重写时再接管，本任务先补 `name: ""` 与 `consentStatus: "approved"`）。`worker/processors/avatar-generation.ts` 的 legacy 字面量同样补齐。所有 AvatarProfile 测试 fixture 补新字段。

- [ ] **Step 4: 生成 migration**

Run: `npx prisma migrate dev --name extend_avatar_profile_phase3`

- [ ] **Step 5: 跑测试 + 全量回归**

Run: `npx vitest run tests/repositories/avatar.test.ts` → PASS；`npm test` → 全绿（fixture 补齐后）。

- [ ] **Step 6: Commit**

```bash
git add prisma/ lib/types.ts lib/repositories/ lib/schemas.ts lib/services/avatar-provider.ts worker/processors/avatar-generation.ts tests/
git commit -m "feat(avatars): extend AvatarProfile with name/group/consent/footage fields + repository update"
```

---

### Task 3: Provider 接口扩展（digital_twin / consent / status / TTS）+ mock + heygen

**Files:**
- Modify: `lib/services/avatar-provider.ts`（接口 + 新增 createDigitalTwinProfile）
- Modify: `lib/services/providers/mock.ts`
- Modify: `lib/services/providers/heygen.ts`
- Test: `tests/avatar-provider.test.ts`、`tests/providers/heygen.test.ts`

- [ ] **Step 1: 写失败测试 — mock provider 新能力**

在 `tests/avatar-provider.test.ts` 追加：

```ts
describe("digital twin provider contract (mock)", () => {
  it("createDigitalTwin returns a group id and a consent url", async () => {
    const provider = createMockProvider();
    const result = await provider.createDigitalTwin({
      name: "店主",
      footageUrl: "https://cdn.example.com/footage.mp4",
    });
    expect(result.groupId).toMatch(/^avatar_group/);
    expect(result.consentUrl).toContain(result.groupId);
  });

  it("getDigitalTwinStatus is ready by default with provider ids", async () => {
    const provider = createMockProvider();
    const status = await provider.getDigitalTwinStatus({ groupId: "g1" });
    expect(status).toMatchObject({
      consentStatus: "approved",
      trainingStatus: "ready",
    });
    expect(status.providerAvatarId).toBeTruthy();
    expect(status.providerVoiceId).toBeTruthy();
  });

  it("getDigitalTwinStatus follows an injected status sequence (consent state machine tests)", async () => {
    const provider = createMockProvider({
      twinStatusSequence: [
        { consentStatus: "awaiting_user", trainingStatus: "pending", consentUrl: "https://consent.example.com/g1" },
        { consentStatus: "approved", trainingStatus: "processing" },
        { consentStatus: "approved", trainingStatus: "ready", providerAvatarId: "look_9", providerVoiceId: "voice_9" },
      ],
    });
    expect((await provider.getDigitalTwinStatus({ groupId: "g1" })).consentStatus).toBe("awaiting_user");
    expect((await provider.getDigitalTwinStatus({ groupId: "g1" })).trainingStatus).toBe("processing");
    expect((await provider.getDigitalTwinStatus({ groupId: "g1" })).providerAvatarId).toBe("look_9");
    // 序列耗尽后保持最后一个状态
    expect((await provider.getDigitalTwinStatus({ groupId: "g1" })).providerAvatarId).toBe("look_9");
  });

  it("refreshConsent returns a fresh consent url", async () => {
    const provider = createMockProvider();
    const { consentUrl } = await provider.refreshConsent({ groupId: "g1" });
    expect(consentUrl).toContain("g1");
  });

  it("synthesizeSpeech returns duration + per-word timestamps; failTts throws", async () => {
    const provider = createMockProvider();
    const speech = await provider.synthesizeSpeech({
      providerVoiceId: "voice_1",
      text: "你好欢迎",
    });
    expect(speech.audioStorageKey).toMatch(/^voice_audio/);
    expect(speech.durationSeconds).toBeGreaterThan(0);
    expect(speech.words).toHaveLength(Array.from("你好欢迎").length);
    expect(speech.words[0]).toMatchObject({ word: "你", startSec: 0 });
    expect(speech.words.at(-1)!.endSec).toBeCloseTo(speech.durationSeconds, 5);

    await expect(
      createMockProvider({ failTts: true }).synthesizeSpeech({ providerVoiceId: "v", text: "x" }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 写失败测试 — heygen 实现**

在 `tests/providers/heygen.test.ts` 的 describe 内追加（复用该文件顶部 mockFetch/jsonResponse/putObjectFromBufferMock 基建）：

```ts
  it("createDigitalTwin posts v3/avatars then fetches the consent url", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ data: { group_id: "grp_1" } }))
      .mockResolvedValueOnce(jsonResponse({ data: { url: "https://consent.heygen.com/abc" } }));

    const { createHeyGenProvider } = await import("@/lib/services/providers/heygen");
    const result = await createHeyGenProvider().createDigitalTwin({
      name: "店主",
      footageUrl: "https://cdn.example.com/f.mp4",
    });

    expect(result).toEqual({ groupId: "grp_1", consentUrl: "https://consent.heygen.com/abc" });
    const createCall = mockFetch.mock.calls[0];
    expect(createCall[0]).toBe("https://api.heygen.com/v3/avatars");
    const body = JSON.parse(createCall[1].body as string);
    expect(body).toMatchObject({ type: "digital_twin", name: "店主", video_url: "https://cdn.example.com/f.mp4" });
    expect(mockFetch.mock.calls[1][0]).toBe("https://api.heygen.com/v3/avatars/grp_1/consent");
  });

  it("getDigitalTwinStatus maps group fields to the normalized state machine", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: {
          consent_status: "approved",
          status: "completed",
          looks: [{ id: "look_1" }],
          voice_id: "voice_1",
        },
      }),
    );
    const { createHeyGenProvider } = await import("@/lib/services/providers/heygen");
    const status = await createHeyGenProvider().getDigitalTwinStatus({ groupId: "grp_1" });
    expect(mockFetch.mock.calls[0][0]).toBe("https://api.heygen.com/v3/avatar_groups/grp_1");
    expect(status).toMatchObject({
      consentStatus: "approved",
      trainingStatus: "ready",
      providerAvatarId: "look_1",
      providerVoiceId: "voice_1",
    });
  });

  it("getDigitalTwinStatus maps rejected consent to failed with a reason", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: { consent_status: "rejected", status: "failed", reject_reason: "face mismatch" } }),
    );
    const { createHeyGenProvider } = await import("@/lib/services/providers/heygen");
    const status = await createHeyGenProvider().getDigitalTwinStatus({ groupId: "g" });
    expect(status.consentStatus).toBe("rejected");
    expect(status.trainingStatus).toBe("failed");
    expect(status.reason).toContain("face mismatch");
  });

  it("synthesizeSpeech posts to voices/speech, downloads audio to R2, normalizes ms timestamps", async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            audio_url: "https://cdn.heygen.com/a.mp3",
            duration: 1.5,
            word_timestamps: [
              { word: "你好", start: 0, end: 500 },
              { word: "欢迎", start: 500, end: 1500 },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));

    const { createHeyGenProvider } = await import("@/lib/services/providers/heygen");
    const speech = await createHeyGenProvider().synthesizeSpeech({
      providerVoiceId: "voice_1",
      text: "你好欢迎",
    });

    const call = mockFetch.mock.calls[0];
    expect(call[0]).toBe("https://api.heygen.com/v3/voices/speech");
    expect(JSON.parse(call[1].body as string)).toMatchObject({ voice_id: "voice_1", text: "你好欢迎" });
    expect(putObjectFromBufferMock).toHaveBeenCalledTimes(1);
    expect(speech.audioStorageKey).toMatch(/^voices\//);
    expect(speech.durationSeconds).toBe(1.5);
    // ms → s 归一化（Task 0 Step 4 若确认是秒，则改为原样透传并同步改此断言）
    expect(speech.words[1]).toEqual({ word: "欢迎", startSec: 0.5, endSec: 1.5 });
  });
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run tests/avatar-provider.test.ts tests/providers/heygen.test.ts`
Expected: FAIL（接口方法不存在）

- [ ] **Step 4: 实现接口与 mock**

`lib/services/avatar-provider.ts` 顶部扩展：

```ts
import type { AvatarConsentStatus, AvatarProfile, AvatarProviderName, AvatarTrainingStatus } from "@/lib/types";

export interface WordTimestamp {
  word: string;
  startSec: number;
  endSec: number;
}

/** 归一化后的分身状态（provider 内部形状差异收敛于此）。 */
export interface DigitalTwinStatus {
  consentStatus: AvatarConsentStatus;
  trainingStatus: AvatarTrainingStatus;
  /** trainingStatus="ready" 时给出：HeyGen look_id 与克隆声音 id。 */
  providerAvatarId?: string;
  providerVoiceId?: string;
  /** 拒绝/失败原因（UI 展示用，provider 原文）。 */
  reason?: string;
  /** 仍在 awaiting_user 时带回（可能已轮换的）授权链接，供前端重新打开。 */
  consentUrl?: string;
}

export interface AvatarProvider {
  name: AvatarProviderName;
  createAvatar(input: { trainingVideoAssetId: string; ownerId: string }): Promise<{
    providerAvatarId: string;
    providerVoiceId?: string;
  }>;
  generateTalkingHead(
    input: { providerAvatarId: string; providerVoiceId?: string; scriptText: string },
    onProgress?: (attempt: number, maxAttempts: number) => void,
  ): Promise<{ videoAssetId: string; durationSeconds: number }>;
  /** 创建数字分身（digital_twin），返回 group 句柄 + webcam 授权链接（24h 有效）。 */
  createDigitalTwin(input: { name: string; footageUrl: string }): Promise<{ groupId: string; consentUrl: string }>;
  /** 授权链接过期/被拒后重发。 */
  refreshConsent(input: { groupId: string }): Promise<{ consentUrl: string }>;
  /** 轮询授权 + 训练状态。 */
  getDigitalTwinStatus(input: { groupId: string }): Promise<DigitalTwinStatus>;
  /** 克隆声音 TTS；音频持久化到 R2 后返回 storageKey + 词级时间轴。 */
  synthesizeSpeech(input: { providerVoiceId: string; text: string }): Promise<{
    audioStorageKey: string;
    durationSeconds: number;
    words: WordTimestamp[];
  }>;
}
```

文件尾部新增服务函数（route 调它，负责编排 provider + 组装 profile，不落库）：

```ts
/**
 * Phase 3 形象创建（spec §6.2）：调真 provider 创建 digital_twin 并取 webcam
 * 授权链接，返回待持久化的 AvatarProfile（consentStatus=awaiting_user）。
 * 授权通过且训练完成后由 status 轮询端点写入 providerAvatarId/providerVoiceId。
 */
export async function createDigitalTwinProfile(input: {
  ownerId: string;
  storeId: string;
  name: string;
  footageAssetId: string;
  footageUrl: string;
  consentAccepted: boolean;
  provider: AvatarProvider;
}): Promise<{ profile: AvatarProfile; consentUrl: string }> {
  if (!input.consentAccepted) {
    throw new Error("创建数字人前必须确认肖像和声音授权");
  }
  const { groupId, consentUrl } = await input.provider.createDigitalTwin({
    name: input.name,
    footageUrl: input.footageUrl,
  });
  const now = nowIso();
  return {
    profile: {
      id: createId("avatar"),
      ownerId: input.ownerId,
      storeId: input.storeId,
      name: input.name,
      provider: input.provider.name,
      providerGroupId: groupId,
      consentStatus: "awaiting_user",
      trainingVideoAssetId: input.footageAssetId,
      consentAcceptedAt: now,
      trainingStatus: "pending",
      fallbackMode: "tts_voiceover",
      createdAt: now,
      updatedAt: now,
    },
    consentUrl,
  };
}

/** consent 状态机（spec §6.2/§6.5）：provider 状态 → profile 持久化增量。 */
export function applyDigitalTwinStatus(
  status: DigitalTwinStatus,
): Partial<AvatarProfile> {
  const patch: Partial<AvatarProfile> = {
    consentStatus: status.consentStatus,
    updatedAt: nowIso(),
  };
  if (status.consentStatus === "rejected" || status.consentStatus === "expired") {
    patch.trainingStatus = "failed";
    patch.statusReason = status.reason ?? (status.consentStatus === "expired" ? "授权链接已过期" : "授权被拒绝");
    return patch;
  }
  if (status.trainingStatus === "failed") {
    patch.trainingStatus = "failed";
    patch.statusReason = status.reason ?? "分身训练失败";
    return patch;
  }
  if (status.consentStatus === "approved" && status.trainingStatus === "ready") {
    patch.trainingStatus = "ready";
    patch.providerAvatarId = status.providerAvatarId;
    patch.providerVoiceId = status.providerVoiceId;
    patch.statusReason = undefined;
    return patch;
  }
  // approved + 训练途中
  patch.trainingStatus = status.trainingStatus === "ready" ? "ready" : "processing";
  return patch;
}
```

`lib/services/providers/mock.ts` 全文替换为：

```ts
import { createId } from "@/lib/ids";
import type { AvatarProvider, DigitalTwinStatus, WordTimestamp } from "@/lib/services/avatar-provider";
import { SPEECH_CHARS_PER_SECOND } from "@/lib/speech-rate";

interface MockProviderOptions {
  avatarId?: string;
  voiceId?: string;
  failTalkingHead?: boolean;
  failDigitalTwin?: boolean;
  failTts?: boolean;
  /** 每次 getDigitalTwinStatus 调用弹出序列头；耗尽后保持最后一个。 */
  twinStatusSequence?: DigitalTwinStatus[];
}

export function createMockProvider(options: MockProviderOptions = {}): AvatarProvider {
  const statusQueue = [...(options.twinStatusSequence ?? [])];
  return {
    name: "mock-avatar",
    async createAvatar() {
      return {
        providerAvatarId: options.avatarId ?? createId("provider_avatar"),
        providerVoiceId: options.voiceId ?? createId("provider_voice"),
      };
    },
    async generateTalkingHead(
      _input: { providerAvatarId: string; providerVoiceId?: string; scriptText: string },
      _onProgress?: (attempt: number, maxAttempts: number) => void,
    ) {
      if (options.failTalkingHead) {
        throw new Error("Mock provider talking-head generation failed");
      }
      return { videoAssetId: createId("avatar_video"), durationSeconds: 15 };
    },
    async createDigitalTwin(input) {
      if (options.failDigitalTwin) {
        throw new Error("Mock provider digital twin creation failed");
      }
      const groupId = createId("avatar_group");
      return { groupId, consentUrl: `https://consent.example.com/${groupId}?name=${encodeURIComponent(input.name)}` };
    },
    async refreshConsent(input) {
      return { consentUrl: `https://consent.example.com/${input.groupId}` };
    },
    async getDigitalTwinStatus() {
      if (statusQueue.length > 1) return statusQueue.shift() as DigitalTwinStatus;
      if (statusQueue.length === 1) return statusQueue[0] as DigitalTwinStatus;
      return {
        consentStatus: "approved",
        trainingStatus: "ready",
        providerAvatarId: options.avatarId ?? createId("provider_avatar"),
        providerVoiceId: options.voiceId ?? createId("provider_voice"),
      };
    },
    async synthesizeSpeech(input) {
      if (options.failTts) {
        throw new Error("Mock provider TTS failed");
      }
      const chars = Array.from(input.text);
      const durationSeconds = Math.max(chars.length / SPEECH_CHARS_PER_SECOND, 0.5);
      const perChar = durationSeconds / Math.max(chars.length, 1);
      const words: WordTimestamp[] = chars.map((word, i) => ({
        word,
        startSec: i * perChar,
        endSec: (i + 1) * perChar,
      }));
      return { audioStorageKey: createId("voice_audio"), durationSeconds, words };
    },
  };
}
```

- [ ] **Step 5: 实现 heygen**

`lib/services/providers/heygen.ts` 追加（放在 provider 对象方法内，复用 heyGenRequest / downloadVideoBytes / putObjectFromBuffer）。**Task 0 校准点：consent 响应字段名、avatar_groups 端点路径、word_timestamps 单位与粒度——若与下述不符，改这里与 Step 2 测试。**

```ts
    async createDigitalTwin(input) {
      const createRes = await heyGenRequest<HeyGenEnvelope<{ group_id?: string; avatar_group_id?: string; id?: string }>>(
        "/v3/avatars",
        "POST",
        { type: "digital_twin", name: input.name, video_url: input.footageUrl },
      );
      const groupId = createRes.data?.group_id ?? createRes.data?.avatar_group_id ?? createRes.data?.id;
      if (!groupId) throw new Error("HeyGen digital_twin create returned no group id");
      const { consentUrl } = await requestConsentUrl(groupId);
      return { groupId, consentUrl };
    },

    async refreshConsent(input) {
      return requestConsentUrl(input.groupId);
    },

    async getDigitalTwinStatus(input) {
      const res = await heyGenRequest<HeyGenEnvelope<HeyGenAvatarGroup>>(
        `/v3/avatar_groups/${input.groupId}`,
        "GET",
      );
      return normalizeGroupStatus(res.data ?? {});
    },

    async synthesizeSpeech(input) {
      const res = await heyGenRequest<HeyGenEnvelope<HeyGenSpeechData>>(
        "/v3/voices/speech",
        "POST",
        { voice_id: input.providerVoiceId, text: input.text },
      );
      const data = res.data;
      if (!data?.audio_url) throw new Error("HeyGen TTS returned no audio_url");
      const bytes = await downloadVideoBytes(data.audio_url); // 同一下载器（带超时）
      const storageKey = `voices/${createId("tts")}.mp3`;
      await putObjectFromBuffer(storageKey, bytes, "audio/mpeg");
      return {
        audioStorageKey: storageKey,
        durationSeconds: data.duration ?? 0,
        words: normalizeWordTimestamps(data.word_timestamps ?? [], data.duration ?? 0),
      };
    },
```

文件级新增（heygen.ts 底部；`createId` 需 import）：

```ts
// ── Digital twin (Phase 3) ──────────────────────────────────────────────────

interface HeyGenAvatarGroup {
  consent_status?: string;
  status?: string;
  reject_reason?: string;
  error?: string;
  looks?: { id?: string }[];
  look_id?: string;
  voice_id?: string;
  consent_url?: string;
  url?: string;
}

interface HeyGenSpeechData {
  audio_url?: string;
  duration?: number;
  word_timestamps?: { word?: string; start?: number; end?: number }[];
}

async function requestConsentUrl(groupId: string): Promise<{ consentUrl: string }> {
  const res = await heyGenRequest<HeyGenEnvelope<{ url?: string; consent_url?: string }>>(
    `/v3/avatars/${groupId}/consent`,
    "POST",
    {},
  );
  const url = res.data?.url ?? res.data?.consent_url;
  if (!url) throw new Error("HeyGen consent endpoint returned no url");
  return { consentUrl: url };
}

/** HeyGen group 原始字段 → 归一化状态机。未知/进行中的状态保守映射为 pending/processing。 */
function normalizeGroupStatus(data: HeyGenAvatarGroup): DigitalTwinStatus {
  const consentRaw = (data.consent_status ?? "").toLowerCase();
  const consentStatus =
    consentRaw === "approved" || consentRaw === "completed" || consentRaw === "success"
      ? "approved"
      : consentRaw === "rejected" || consentRaw === "denied" || consentRaw === "failed"
        ? "rejected"
        : consentRaw === "expired"
          ? "expired"
          : "awaiting_user";

  const statusRaw = (data.status ?? "").toLowerCase();
  const failed = statusRaw === "failed" || statusRaw === "error";
  const ready = statusRaw === "completed" || statusRaw === "ready" || statusRaw === "success";
  const trainingStatus =
    consentStatus === "rejected" || consentStatus === "expired" || failed
      ? "failed"
      : ready
        ? "ready"
        : consentStatus === "approved"
          ? "processing"
          : "pending";

  return {
    consentStatus,
    trainingStatus,
    providerAvatarId: data.looks?.find((l) => l.id)?.id ?? data.look_id,
    providerVoiceId: data.voice_id,
    reason: data.reject_reason ?? data.error,
    consentUrl: data.consent_url ?? data.url,
  };
}

/**
 * word_timestamps 归一化为秒。Task 0 Step 4 确认单位：若 HeyGen 返回毫秒
 * （end 远超 duration），按 /1000 处理；中文粒度按字/按词均可——消费端按句对齐。
 */
function normalizeWordTimestamps(
  raw: { word?: string; start?: number; end?: number }[],
  durationSec: number,
): WordTimestamp[] {
  const parsed = raw
    .filter((w): w is { word: string; start: number; end: number } =>
      Boolean(w.word) && typeof w.start === "number" && typeof w.end === "number")
    .map((w) => ({ word: w.word, start: w.start, end: w.end }));
  const looksLikeMs = parsed.some((w) => w.end > durationSec * 10 + 1);
  const scale = looksLikeMs ? 0.001 : 1;
  return parsed.map((w) => ({ word: w.word, startSec: w.start * scale, endSec: w.end * scale }));
}
```

`DigitalTwinStatus` / `WordTimestamp` 类型从 `@/lib/services/avatar-provider` import。

- [ ] **Step 6: 跑测试确认通过 + 回归**

Run: `npx vitest run tests/avatar-provider.test.ts tests/providers/heygen.test.ts` → PASS；`npm test` → 全绿。

- [ ] **Step 7: Commit**

```bash
git add lib/services/avatar-provider.ts lib/services/providers/ tests/avatar-provider.test.ts tests/providers/heygen.test.ts
git commit -m "feat(providers): digital twin, consent, status polling and cloned-voice TTS contracts"
```

---

### Task 4: POST /api/avatars 重写 + 状态轮询 + consent 重发

**Files:**
- Modify: `app/api/avatars/route.ts`（POST 全文重写；GET 本任务不动）
- Create: `app/api/avatars/[id]/status/route.ts`
- Create: `app/api/avatars/[id]/consent/route.ts`
- Test: `tests/api/avatars-create.test.ts`（新建）、`tests/api/avatars-status.test.ts`（新建）

- [ ] **Step 1: 写失败测试**

新建 `tests/api/avatars-create.test.ts`：

```ts
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { resetRuntimeStateForTests } from "@/lib/runtime-store";
import { getAssetRepository, getAvatarRepository, getStoreRepository } from "@/lib/repositories";
import { createMockProvider } from "@/lib/services/providers/mock";
import { nowIso } from "@/lib/ids";
import type { Asset, StoreProfile } from "@/lib/types";

// 用可控 mock provider 替换 env 工厂
vi.mock("@/lib/services/providers", () => ({
  createProviderFromEnv: () => createMockProvider(),
}));
// 不触真 S3：presign 直接返回假 URL
vi.mock("@/lib/storage", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/storage")>();
  return { ...original, createPresignedGetUrl: vi.fn(async () => "https://cdn.example.com/presigned.mp4") };
});

import { POST } from "@/app/api/avatars/route";

const savedDbUrl = process.env.DATABASE_URL;
const savedStorage = process.env.S3_BUCKET; // hasObjectStorage 依赖项按 lib/env.ts 实际 accessor stub

function seedStoreAndFootage(category: "material" | "avatar_footage") {
  const now = nowIso();
  const store: StoreProfile = {
    id: "store_1", ownerId: "demo_user", name: "测试店", industry: "餐饮",
    mainProducts: ["蛋糕"], targetCustomers: ["白领"], sellingPoints: ["现做"],
    brandTone: "亲切", forbiddenWords: [], createdAt: now, updatedAt: now,
  };
  const footage: Asset = {
    id: "asset_footage_1", ownerId: "demo_user", storeId: "store_1", type: "video",
    originalFilename: "me.mp4", storageKey: "stores/store_1/assets/asset_footage_1-me.mp4",
    mimeType: "video/mp4", sizeBytes: 1024, tags: [], businessTags: [],
    status: "ready", category, createdAt: now,
  };
  return { store, footage };
}

function post(body: unknown) {
  return POST(new Request("http://localhost/api/avatars", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }));
}

describe("POST /api/avatars (digital twin)", () => {
  beforeEach(async () => {
    delete process.env.DATABASE_URL;
    resetRuntimeStateForTests();
    const { store, footage } = seedStoreAndFootage("avatar_footage");
    await getStoreRepository().upsert(store);
    await getAssetRepository().create(footage);
  });
  afterEach(() => { if (savedDbUrl) process.env.DATABASE_URL = savedDbUrl; });

  it("creates a pending avatar with consent url (201)", async () => {
    const res = await post({ storeId: "store_1", footageAssetId: "asset_footage_1", name: "店主本人", consentAccepted: true });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.consentUrl).toContain("http");
    expect(json.avatar).toMatchObject({
      name: "店主本人",
      trainingStatus: "pending",
      consentStatus: "awaiting_user",
      trainingVideoAssetId: "asset_footage_1",
    });
    expect(json.avatar.providerGroupId).toBeTruthy();
    // providerAvatarId 此刻必须为空——ready 前不得有可合成 id
    expect(json.avatar.providerAvatarId).toBeUndefined();
  });

  it("rejects when consent not accepted", async () => {
    const res = await post({ storeId: "store_1", footageAssetId: "asset_footage_1", name: "x", consentAccepted: false });
    expect(res.status).toBe(400);
  });

  it("404s when the footage asset belongs to someone else / is material", async () => {
    const foreign: Asset = { ...seedStoreAndFootage("avatar_footage").footage, id: "asset_x", ownerId: "other" };
    await getAssetRepository().create(foreign);
    expect((await post({ storeId: "store_1", footageAssetId: "asset_x", name: "x", consentAccepted: true })).status).toBe(404);

    const material: Asset = { ...seedStoreAndFootage("material").footage, id: "asset_m" };
    await getAssetRepository().create(material);
    expect((await post({ storeId: "store_1", footageAssetId: "asset_m", name: "x", consentAccepted: true })).status).toBe(404);
  });

  it("400s on missing fields and overlong names", async () => {
    expect((await post({ storeId: "store_1", name: "x", consentAccepted: true })).status).toBe(400);
    expect((await post({ storeId: "store_1", footageAssetId: "asset_footage_1", name: "很".repeat(21), consentAccepted: true })).status).toBe(400);
  });
});
```

新建 `tests/api/avatars-status.test.ts`：

```ts
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { resetRuntimeStateForTests } from "@/lib/runtime-store";
import { getAvatarRepository } from "@/lib/repositories";
import { createMockProvider } from "@/lib/services/providers/mock";
import { nowIso } from "@/lib/ids";
import type { AvatarProfile } from "@/lib/types";
```

**实现说明（供写测试者）**：status 测试按状态机逐行覆盖（用 `twinStatusSequence` 注入 provider 状态）。锚定第一个用例的完整写法如下，其余照表复制：

```ts
import { GET } from "@/app/api/avatars/[id]/status/route";
import { POST as CONSENT_POST } from "@/app/api/avatars/[id]/consent/route";

// vi.hoisted 持有可变 provider 引用，每个 it 换 twinStatusSequence
const { providerRef } = vi.hoisted(() => ({
  providerRef: { current: createMockProvider() },
}));
vi.mock("@/lib/services/providers", () => ({
  createProviderFromEnv: () => providerRef.current,
}));

function seedAvatar(overrides: Partial<AvatarProfile> = {}): AvatarProfile {
  const now = nowIso();
  return {
    id: "avatar_1", ownerId: "demo_user", storeId: "store_1", name: "店主",
    provider: "mock-avatar", providerGroupId: "group_1",
    consentStatus: "awaiting_user", trainingStatus: "pending",
    trainingVideoAssetId: "asset_f1",
    consentAcceptedAt: now, fallbackMode: "tts_voiceover",
    createdAt: now, updatedAt: now, ...overrides,
  };
}

it("approved + ready writes provider ids and flips trainingStatus to ready", async () => {
  providerRef.current = createMockProvider({
    twinStatusSequence: [
      { consentStatus: "approved", trainingStatus: "ready", providerAvatarId: "look_9", providerVoiceId: "voice_9" },
    ],
  });
  await getAvatarRepository().create(seedAvatar());
  const res = await GET(new Request("http://localhost/api/avatars/avatar_1/status"), {
    params: Promise.resolve({ id: "avatar_1" }),
  } as never);
  expect(res.status).toBe(200);
  const json = await res.json();
  expect(json.avatar).toMatchObject({
    trainingStatus: "ready", consentStatus: "approved",
    providerAvatarId: "look_9", providerVoiceId: "voice_9",
  });
  // 终态缓存：再调不再触 provider
  const res2 = await GET(new Request("http://localhost/api/avatars/avatar_1/status"), {
    params: Promise.resolve({ id: "avatar_1" }),
  } as never);
  expect(res2.status).toBe(200);
});
```

| # | provider 返回 | 期望 profile |
|---|---|---|
| 1 | awaiting_user / pending | trainingStatus=pending, consentStatus=awaiting_user，响应带 consentUrl |
| 2 | approved / processing | approved / processing |
| 3 | approved / ready + ids | ready，写入 providerAvatarId/providerVoiceId（上方完整代码） |
| 4 | rejected | failed + statusReason |
| 5 | expired | failed + statusReason 含「过期」 |
| 6 | 非本人 avatar（seed ownerId: "other"） | 404 |

consent 重发测试：failed(expired) 的 avatar → POST consent → 200 + consentUrl，profile 回到 awaiting_user/pending、statusReason 清空；ready 的 avatar → POST consent → 409。

测试文件顶部 mock 模式同 avatars-create（`vi.mock("@/lib/services/providers", ...)` 返回带 `twinStatusSequence` 的 mock provider——每个 it 内通过 mock 变量换序列，用 `vi.hoisted` 持有一个 `currentProvider` 可变引用）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/api/avatars-create.test.ts tests/api/avatars-status.test.ts`
Expected: FAIL（路由不存在/旧契约不符）

- [ ] **Step 3: 实现 POST 重写**

`app/api/avatars/route.ts` POST 全文替换（GET 保留）：

```ts
export async function POST(request: Request) {
  let body: {
    storeId?: unknown;
    footageAssetId?: unknown;
    name?: unknown;
    consentAccepted?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return jsonError("Request body must be valid JSON", 400);
  }

  if (!body.storeId || !body.footageAssetId || !body.name) {
    return jsonError("storeId, footageAssetId and name are required", 400);
  }
  const name = String(body.name).trim();
  if (name.length === 0 || Array.from(name).length > 20) {
    return jsonError("name must be 1-20 characters", 400);
  }
  if (body.consentAccepted !== true) {
    return jsonError("创建数字人前必须确认肖像和声音授权", 400);
  }

  const ownerId = await getOwnerId();
  const limited = await applyRateLimit(request, ownerId);
  if (limited) return limited;

  // IDOR：人像素材必须属于本人、且确为 avatar_footage 视频（防拿 b-roll 素材建分身）。
  const footage = await getAssetRepository().findById(String(body.footageAssetId));
  if (
    !footage ||
    footage.ownerId !== ownerId ||
    footage.category !== "avatar_footage" ||
    footage.type !== "video"
  ) {
    return jsonError("Footage asset not found", 404);
  }
  const store = await getStoreRepository().findById(String(body.storeId));
  if (!store || store.ownerId !== ownerId) {
    return jsonError("Store not found", 404);
  }

  try {
    // presigned GET 供 HeyGen 拉取训练视频（900s 默认过期，HeyGen 创建时立即拉取）。
    const footageUrl = await createPresignedGetUrl(footage.storageKey);
    const { profile, consentUrl } = await createDigitalTwinProfile({
      ownerId,
      storeId: store.id,
      name,
      footageAssetId: footage.id,
      footageUrl,
      consentAccepted: true,
      provider: createProviderFromEnv(),
    });
    const saved = await getAvatarRepository().create(profile);
    return jsonOk({ avatar: saved, consentUrl }, 201);
  } catch (error) {
    // provider/presign 错误可能含内部细节——日志留全文，客户端只收通用文案（§8）。
    console.error("[avatars] digital twin creation failed:", error);
    return jsonError("Avatar creation failed", 502);
  }
}
```

import 更新：`getAssetRepository, getAvatarRepository, getStoreRepository`、`createDigitalTwinProfile`、`createProviderFromEnv`（来自 `@/lib/services/avatar-provider` 的 re-export `./providers`）、`createPresignedGetUrl` from `@/lib/storage`。删除 `createAvatarProfile, createMockAvatarProvider` import。

> 注意 `lib/services/avatar-provider.ts` 第 116 行已 `export { createProviderFromEnv } from "./providers"`——route 从 avatar-provider 导入即可，测试 mock `@/lib/services/providers` 能生效（re-export 同一模块引用）。

- [ ] **Step 4: 实现 status 轮询端点**

新建 `app/api/avatars/[id]/status/route.ts`：

```ts
import { jsonError, jsonOk } from "@/lib/api-response";
import { applyRateLimit } from "@/lib/rate-limit";
import { getAvatarRepository } from "@/lib/repositories";
import { getOwnerId } from "@/lib/auth-helpers";
import { applyDigitalTwinStatus, createProviderFromEnv } from "@/lib/services/avatar-provider";
import { nowIso } from "@/lib/ids";

/**
 * GET /api/avatars/[id]/status — 轮询分身授权+训练状态（spec §6.2.4）。
 * provider 状态经 applyDigitalTwinStatus 收敛后落库；awaiting_user 时带回
 * （可能已轮换的）consentUrl 供前端重新打开。只返回给属主本人。
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ownerId = await getOwnerId();
  const limited = await applyRateLimit(request, ownerId);
  if (limited) return limited;

  const repo = getAvatarRepository();
  const avatar = await repo.findById(id);
  if (!avatar || avatar.ownerId !== ownerId) {
    return jsonError("Avatar profile not found", 404);
  }
  if (!avatar.providerGroupId) {
    // 老数据（mock 时代创建）：没有 group 句柄可轮询，直接回现状。
    return jsonOk({ avatar });
  }
  if (avatar.trainingStatus === "ready" || avatar.trainingStatus === "failed") {
    return jsonOk({ avatar }); // 终态不再轮询 provider
  }

  let status;
  try {
    status = await createProviderFromEnv().getDigitalTwinStatus({ groupId: avatar.providerGroupId });
  } catch (error) {
    console.error("[avatars] status poll failed:", error);
    return jsonError("Failed to poll avatar status", 502);
  }

  const updated = await repo.update(id, { ...applyDigitalTwinStatus(status), updatedAt: nowIso() });
  return jsonOk({ avatar: updated, consentUrl: status.consentUrl });
}
```

- [ ] **Step 5: 实现 consent 重发端点**

新建 `app/api/avatars/[id]/consent/route.ts`：

```ts
import { jsonError, jsonOk } from "@/lib/api-response";
import { applyRateLimit } from "@/lib/rate-limit";
import { getAvatarRepository } from "@/lib/repositories";
import { getOwnerId } from "@/lib/auth-helpers";
import { createProviderFromEnv } from "@/lib/services/avatar-provider";
import { nowIso } from "@/lib/ids";

/**
 * POST /api/avatars/[id]/consent — 授权链接 24h 过期/被拒后重发（spec §6.5）。
 * 仅 failed（consent 类失败）或仍 awaiting_user 的形象可重发；ready 返回 409。
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ownerId = await getOwnerId();
  const limited = await applyRateLimit(request, ownerId);
  if (limited) return limited;

  const repo = getAvatarRepository();
  const avatar = await repo.findById(id);
  if (!avatar || avatar.ownerId !== ownerId) {
    return jsonError("Avatar profile not found", 404);
  }
  if (!avatar.providerGroupId) {
    return jsonError("Avatar has no provider group", 400);
  }
  if (avatar.trainingStatus === "ready") {
    return jsonError("Avatar is already ready", 409);
  }

  try {
    const { consentUrl } = await createProviderFromEnv().refreshConsent({ groupId: avatar.providerGroupId });
    const updated = await repo.update(id, {
      consentStatus: "awaiting_user",
      trainingStatus: "pending",
      statusReason: undefined,
      updatedAt: nowIso(),
    });
    return jsonOk({ avatar: updated, consentUrl });
  } catch (error) {
    console.error("[avatars] consent re-issue failed:", error);
    return jsonError("Failed to re-issue consent", 502);
  }
}
```

> Prisma partial-update 的 `statusReason: undefined` 不会清字段（`!== undefined` 守卫）——`applyDigitalTwinStatus` 与 consent 重发的「清空 statusReason」需要 prisma repo 支持显式置 null。修改 `lib/repositories/prisma.ts` update 守卫为：`if ("statusReason" in data) prismaData.statusReason = data.statusReason ?? null;`（memory repo 的 spread 对显式 `statusReason: undefined` 语义一致）。同步把 Task 2 的 prisma update 里所有字段守卫从 `!== undefined` 改为 `"field" in data` 形式，保证可清空。

- [ ] **Step 6: 跑测试确认通过 + 回归**

Run: `npx vitest run tests/api/avatars-create.test.ts tests/api/avatars-status.test.ts tests/api/avatars-talking-head.test.ts` → PASS；`npm test` 全绿。

注意：`tests/api/avatars-talking-head.test.ts` 的既有 fixture 若 seed 的 avatar 缺新必填字段（name/consentStatus），按 Task 2 模式补齐。

- [ ] **Step 7: Commit**

```bash
git add app/api/avatars/ lib/repositories/prisma.ts tests/api/avatars-create.test.ts tests/api/avatars-status.test.ts
git commit -m "feat(api): digital twin avatar creation with consent flow and status polling"
```

---

### Task 5: env 模板覆盖删除 + 平台公共形象兜底

**Files:**
- Create: `lib/services/platform-avatar.ts`
- Modify: `lib/services/providers/heygen.ts:208-219`（删覆盖逻辑）
- Modify: `app/api/avatars/route.ts` GET（注入平台形象）
- Modify: `app/api/avatars/talking-head/route.ts:38-44`（platform id 放行）
- Test: `tests/platform-avatar.test.ts`（新建）、`tests/providers/heygen.test.ts`（改）、`tests/api/avatars-create.test.ts`（追加 GET 用例）

**背景：** 现状 `generateTalkingHead`（heygen.ts:208-219）无条件用 env 模板覆盖 profile 的 provider ids——mock 时代留的脏 id 兼容逻辑，但使「全站共用一张脸」成为结构性行为（改进诉求 3 的根因）。本任务删除覆盖，`AvatarProfile.providerAvatarId` 成为唯一权威；env 模板降级为「平台公共形象」，仅在用户没有任何 ready 形象时出现在形象列表兜底。

- [ ] **Step 1: 写失败测试**

新建 `tests/platform-avatar.test.ts`：

```ts
import { describe, expect, it, afterEach, vi } from "vitest";
import {
  PLATFORM_AVATAR_ID,
  buildPlatformAvatar,
  isPlatformAvatarId,
  resolvePlatformProviderIds,
} from "@/lib/services/platform-avatar";

describe("platform avatar", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("builds a synthetic ready profile with stable id", () => {
    const p = buildPlatformAvatar("owner_1");
    expect(p.id).toBe(PLATFORM_AVATAR_ID);
    expect(p.ownerId).toBe("owner_1");
    expect(p.trainingStatus).toBe("ready");
    expect(p.consentStatus).toBe("approved");
    expect(p.name).toContain("平台");
    expect(isPlatformAvatarId(p.id)).toBe(true);
    expect(isPlatformAvatarId("avatar_user_1")).toBe(false);
  });

  it("resolves provider ids from env template", () => {
    vi.stubEnv("HEYGEN_AVATAR_TEMPLATE_ID", "tpl_1");
    vi.stubEnv("HEYGEN_VOICE_ID", "v_1");
    expect(resolvePlatformProviderIds()).toEqual({ providerAvatarId: "tpl_1", providerVoiceId: "v_1" });
  });

  it("returns null when no template configured (caller falls back to provider.createAvatar)", () => {
    expect(resolvePlatformProviderIds()).toBeNull();
  });
});
```

`tests/providers/heygen.test.ts`：把 `it("generateTalkingHead prefers HEYGEN_AVATAR_TEMPLATE_ID/VOICE_ID over stale input profile ids", ...)` 整段改为反向断言：

```ts
  it("generateTalkingHead sends the profile's own ids (no env template override)", async () => {
    // Phase 3：providerAvatarId 为权威（spec §6.3）。即使 env 配了模板也不得覆盖——
    // 模板只通过「平台公共形象」profile 进入合成。
    vi.stubEnv("HEYGEN_AVATAR_TEMPLATE_ID", "tpl_REAL");
    vi.stubEnv("HEYGEN_VOICE_ID", "v_REAL");

    mockFetch
      .mockResolvedValueOnce(jsonResponse({ data: { video_id: "vid_own" } }))
      .mockResolvedValueOnce(
        jsonResponse({ data: { status: "completed", video_url: "https://cdn/o.mp4", duration: 8 } }),
      )
      .mockResolvedValueOnce(new Response(new Uint8Array([7, 8, 9]), { status: 200 }));

    const { createHeyGenProvider } = await import("@/lib/services/providers/heygen");
    await createHeyGenProvider().generateTalkingHead({
      providerAvatarId: "look_user_1",
      providerVoiceId: "voice_user_1",
      scriptText: "x",
    });

    const createBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(createBody.avatar_id).toBe("look_user_1");
    expect(createBody.voice_id).toBe("voice_user_1");
  });
```

`tests/api/avatars-create.test.ts` 追加（沿用该文件 mock 基建）：

```ts
  it("GET appends the platform avatar only when the owner has no ready avatar", async () => {
    // 无形象 → 列表含平台兜底
    let res = await GET(new Request("http://localhost/api/avatars"));
    let json = await res.json();
    expect(json.avatars.some((a: { id: string }) => a.id === "avatar_platform")).toBe(true);

    // 创建一个 ready 形象后 → 平台兜底消失
    const now = new Date().toISOString();
    await getAvatarRepository().create({
      id: "avatar_ready", ownerId: "demo_user", storeId: "store_1", name: "店主",
      provider: "mock-avatar", providerAvatarId: "look_1", providerVoiceId: "voice_1",
      consentStatus: "approved", consentAcceptedAt: now, trainingStatus: "ready",
      fallbackMode: "tts_voiceover", createdAt: now, updatedAt: now,
    });
    res = await GET(new Request("http://localhost/api/avatars"));
    json = await res.json();
    expect(json.avatars.some((a: { id: string }) => a.id === "avatar_platform")).toBe(false);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/platform-avatar.test.ts tests/providers/heygen.test.ts tests/api/avatars-create.test.ts`
Expected: FAIL（platform-avatar 模块不存在；heygen 覆盖断言反转失败；GET 无注入）

- [ ] **Step 3: 实现 platform-avatar 模块**

新建 `lib/services/platform-avatar.ts`：

```ts
import { getHeygenAvatarTemplateId, getHeygenVoiceId } from "@/lib/env";
import { nowIso } from "@/lib/ids";
import type { AvatarProfile } from "@/lib/types";

/**
 * 平台公共形象（spec §6.3）：env 模板（HEYGEN_AVATAR_TEMPLATE_ID/HEYGEN_VOICE_ID）
 * 合成出的虚拟 AvatarProfile，只在用户没有任何 ready 形象时出现在形象列表兜底
 * （demo 模式 + 新用户）。不持久化——id 约定常量，渲染链路特判解析。
 */
export const PLATFORM_AVATAR_ID = "avatar_platform";

export function isPlatformAvatarId(id: string | undefined | null): boolean {
  return id === PLATFORM_AVATAR_ID;
}

export function buildPlatformAvatar(ownerId: string): AvatarProfile {
  const now = nowIso();
  return {
    id: PLATFORM_AVATAR_ID,
    ownerId,
    storeId: "",
    name: "平台公共形象",
    provider: "heygen",
    providerAvatarId: undefined,
    providerVoiceId: undefined,
    consentStatus: "approved",
    consentAcceptedAt: now,
    trainingStatus: "ready",
    fallbackMode: "template_avatar",
    createdAt: now,
    updatedAt: now,
  };
}

/** env 模板解析；未配置时由调用方回退 provider.createAvatar()（公共 stock 形象）。 */
export function resolvePlatformProviderIds(): {
  providerAvatarId: string;
  providerVoiceId?: string;
} | null {
  const templateId = getHeygenAvatarTemplateId();
  if (!templateId) return null;
  return { providerAvatarId: templateId, providerVoiceId: getHeygenVoiceId() };
}
```

- [ ] **Step 4: 删除 heygen env 覆盖**

`lib/services/providers/heygen.ts` generateTalkingHead 改为：

```ts
    async generateTalkingHead(input: TalkingHeadInput, onProgress?) {
      // Phase 3（spec §6.3）：profile 的 provider ids 是唯一权威。env 模板不再覆盖——
      // 它只经「平台公共形象」profile 在 talking_head 处理器解析后进入这里。
      const videoId = await createHeygenVideo(input);
      const status = await pollHeygenVideo(videoId, onProgress);
      ...
```

（删除 templateAvatarId/templateVoiceId 两行与 spread 覆盖，其余不变。）

- [ ] **Step 5: GET /api/avatars 注入平台兜底**

`app/api/avatars/route.ts` GET 改为：

```ts
export async function GET(request: Request) {
  const ownerId = await getOwnerId();
  const limited = await applyRateLimit(request, ownerId);
  if (limited) return limited;
  const avatars = await getAvatarRepository().listByOwner(ownerId);
  // 平台公共形象兜底：用户没有任何可用形象时提供开箱即用的数字人（demo/新用户）。
  if (!avatars.some((a) => a.trainingStatus === "ready")) {
    avatars.push(buildPlatformAvatar(ownerId));
  }
  return jsonOk({ avatars });
}
```

- [ ] **Step 6: talking-head 预览路由放行 platform id**

`app/api/avatars/talking-head/route.ts` 把 avatar 解析段（现 line 38-44）改为：

```ts
  // IDOR: avatar 必须属于本人且 ready；平台公共形象为约定 id，不查库。
  const avatar = isPlatformAvatarId(body.avatarProfileId)
    ? buildPlatformAvatar(ownerId)
    : await getAvatarRepository().findById(body.avatarProfileId);
  if (!avatar || avatar.ownerId !== ownerId) {
    return jsonError("Avatar profile not found", 404);
  }
  if (!isPlatformAvatarId(avatar.id) && !avatar.providerAvatarId) {
    return jsonError("Avatar profile not ready", 404);
  }
```

- [ ] **Step 7: 跑测试确认通过 + 回归**

Run: `npx vitest run tests/platform-avatar.test.ts tests/providers/heygen.test.ts tests/api/avatars-create.test.ts tests/api/avatars-talking-head.test.ts` → PASS；`npm test` 全绿。

- [ ] **Step 8: Commit**

```bash
git add lib/services/platform-avatar.ts lib/services/providers/heygen.ts app/api/avatars/ tests/
git commit -m "feat(avatars): profile-owned provider ids + platform fallback avatar (remove env override)"
```

---

### Task 6: UI — 素材库 category 过滤 + AI 分身上传/授权区

**Files:**
- Modify: `lib/api-client.ts`（upload-intent/confirm 加 category；createAvatarApi 新契约；新增 fetchAvatarStatusApi / reissueAvatarConsentApi）
- Modify: `components/dashboard.tsx`（assets memo 过滤、AI 分身 section 重写 line 1242-1287、simulateAvatarClone 替换、footage 上传 handler、状态轮询 effect）
- Test: `tests/dashboard.test.tsx`（avatar 区相关用例改写 + 新增授权流用例）

- [ ] **Step 1: 写失败测试 — api-client 新契约**

在 `tests/dashboard.test.tsx` 之外新建 `tests/api-client-avatars.test.ts`（fetch stub 模式参照既有测试）：

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  createAvatarApi,
  fetchAvatarStatusApi,
  reissueAvatarConsentApi,
} from "@/lib/api-client";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function okJson(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("avatar api client (Phase 3)", () => {
  beforeEach(() => mockFetch.mockReset());

  it("createAvatarApi posts the footage contract and returns avatar + consentUrl", async () => {
    mockFetch.mockResolvedValueOnce(okJson({ avatar: { id: "avatar_1" }, consentUrl: "https://consent/x" }, 201));
    const result = await createAvatarApi({
      storeId: "store_1", footageAssetId: "asset_f1", name: "店主", consentAccepted: true,
    });
    expect(result.consentUrl).toBe("https://consent/x");
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/avatars");
    expect(JSON.parse(init.body as string)).toEqual({
      storeId: "store_1", footageAssetId: "asset_f1", name: "店主", consentAccepted: true,
    });
  });

  it("fetchAvatarStatusApi hits the status endpoint", async () => {
    mockFetch.mockResolvedValueOnce(okJson({ avatar: { id: "avatar_1", trainingStatus: "ready" } }));
    const r = await fetchAvatarStatusApi("avatar_1");
    expect(mockFetch.mock.calls[0][0]).toBe("/api/avatars/avatar_1/status");
    expect(r.avatar.trainingStatus).toBe("ready");
  });

  it("reissueAvatarConsentApi posts to the consent endpoint", async () => {
    mockFetch.mockResolvedValueOnce(okJson({ avatar: { id: "avatar_1" }, consentUrl: "https://consent/new" }));
    const r = await reissueAvatarConsentApi("avatar_1");
    expect(mockFetch.mock.calls[0][0]).toBe("/api/avatars/avatar_1/consent");
    expect(mockFetch.mock.calls[0][1].method).toBe("POST");
    expect(r.consentUrl).toBe("https://consent/new");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/api-client-avatars.test.ts`
Expected: FAIL（导出不匹配：createAvatarApi 旧契约无 consentUrl；两个新函数不存在）

- [ ] **Step 3: 实现 api-client**

`lib/api-client.ts`：

```ts
// createUploadIntentApi 入参加 category（ConfirmAssetInput 同样）：
export async function createUploadIntentApi(input: {
  ownerId: string;
  storeId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  category?: "material" | "avatar_footage";
}): Promise<UploadIntentResponse> { /* 不变，直接 JSON.stringify(input) */ }

export interface ConfirmAssetInput {
  // …既有字段…
  category?: "material" | "avatar_footage";
}

// createAvatarApi 契约替换：
export async function createAvatarApi(input: {
  storeId: string;
  footageAssetId: string;
  name: string;
  consentAccepted: boolean;
}): Promise<{ avatar: AvatarProfile; consentUrl: string }> {
  return api<{ avatar: AvatarProfile; consentUrl: string }>("/api/avatars", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchAvatarStatusApi(
  avatarId: string,
): Promise<{ avatar: AvatarProfile; consentUrl?: string }> {
  return api<{ avatar: AvatarProfile; consentUrl?: string }>(
    `/api/avatars/${encodeURIComponent(avatarId)}/status`,
  );
}

export async function reissueAvatarConsentApi(
  avatarId: string,
): Promise<{ avatar: AvatarProfile; consentUrl: string }> {
  return api<{ avatar: AvatarProfile; consentUrl: string }>(
    `/api/avatars/${encodeURIComponent(avatarId)}/consent`,
    { method: "POST" },
  );
}
```

- [ ] **Step 4: 实现 dashboard 素材过滤 + footage 上传**

`components/dashboard.tsx`：

1) `assets` memo（line 347-357）末尾加 `.filter`——在 merge 后过滤：

```ts
  // 素材库只展示/参与选择 material；avatar_footage 是数字分身训练素材，走 AI 分身区。
  const assets = useMemo(() => {
    const seen = new Set<string>();
    const merged: Asset[] = [];
    const storeAssets = store ? serverAssets.filter((item) => item.storeId === store.id) : [];
    for (const asset of [...localAssets, ...storeAssets]) {
      if (seen.has(asset.id)) continue;
      seen.add(asset.id);
      merged.push(asset);
    }
    return merged.filter((a) => (a.category ?? "material") === "material");
  }, [localAssets, serverAssets, store]);

  // AI 分身区的人像视频池（本店 + category=avatar_footage）。
  const footageAssets = useMemo(() => {
    const storeAssets = store ? serverAssets.filter((item) => item.storeId === store.id) : [];
    return [...localAssets, ...storeAssets].filter((a) => a.category === "avatar_footage");
  }, [localAssets, serverAssets, store]);
```

2) `handleAssetUploads` 的 `createUploadIntentApi` 调用加 `category: "material"`；`confirmAssetUpload` 调用加 `category: "material"`。

3) 新增 footage 上传 handler（单文件、仅视频、不做 AI 分析）：

```ts
  const footageInputRef = useRef<HTMLInputElement>(null);
  const [footageUploading, setFootageUploading] = useState(false);
  const [selectedFootageId, setSelectedFootageId] = useState("");
  const [avatarName, setAvatarName] = useState("");

  async function handleFootageUpload(file: File) {
    if (!store) { setMessage("请先完成门店档案。"); return; }
    if (!file.type.startsWith("video/")) { setMessage("人像素材仅支持视频文件。"); return; }
    if (file.size > MAX_UPLOAD_BYTES) { setMessage("视频不超过 200MB。"); return; }
    setFootageUploading(true);
    try {
      const intent = await createUploadIntentApi({
        ownerId: store.ownerId, storeId: store.id,
        filename: file.name, contentType: file.type, sizeBytes: file.size,
        category: "avatar_footage",
      });
      await uploadFileToStorage(intent.uploadUrl, file, intent.headers);
      const uploaded = await confirmAssetUpload({
        assetId: intent.assetId, storeId: store.id, ownerId: store.ownerId,
        storageKey: intent.storageKey, originalFilename: file.name,
        mimeType: file.type, type: "video", sizeBytes: file.size,
        category: "avatar_footage",
      });
      setLocalAssets((prev) => (prev.some((a) => a.id === uploaded.id) ? prev : [...prev, uploaded]));
      setSelectedFootageId(uploaded.id);
      await queryClient.invalidateQueries({ queryKey: ["assets"] });
      setMessage("人像视频已上传。填写形象名字并确认授权后，创建你的 AI 分身。");
    } catch {
      setMessage("人像视频上传失败，请重试。");
    } finally {
      setFootageUploading(false);
    }
  }
```

4) `simulateAvatarClone`（line 790-828）整体替换为：

```ts
  async function handleCreateAvatar() {
    if (!store) { setMessage("请先完成门店档案。"); return; }
    if (!selectedFootageId) { setMessage("请先上传并选择一段人像视频。"); return; }
    if (!avatarName.trim()) { setMessage("请给形象起个名字（如：店主、店长小姐姐）。"); return; }
    if (!avatarConsent) { setMessage("请先确认肖像和声音授权。"); return; }
    setPendingAction("avatar");
    try {
      const { avatar: profile, consentUrl } = await createAvatarApi({
        storeId: store.id,
        footageAssetId: selectedFootageId,
        name: avatarName.trim(),
        consentAccepted: true,
      });
      setLocalAvatar(profile);
      await queryClient.invalidateQueries({ queryKey: ["avatars"] });
      // HeyGen webcam 授权：新窗口打开（24h 有效），用户念授权词完成授权。
      window.open(consentUrl, "_blank", "noopener,noreferrer");
      setMessage("已创建分身任务：请在新窗口完成真人授权（念一段授权词），完成后回到这里自动刷新状态。");
    } catch (error) {
      const detail = error instanceof Error ? error.message : "请稍后重试";
      setMessage(`创建 AI 分身失败：${detail}`);
    } finally {
      setPendingAction(null);
    }
  }
```

5) 状态轮询 effect（放在既有 useEffect 群附近）：

```ts
  // 分身状态轮询：有待授权/训练中的形象时每 10s 打 status 端点收敛状态机，
  // 全部终态后自动停止。避免刷新页面后授权进度丢失。
  const pendingAvatars = useMemo(
    () =>
      storeAvatars.filter(
        (a) =>
          !isPlatformAvatarId(a.id) &&
          (a.consentStatus === "awaiting_user" ||
            a.trainingStatus === "pending" ||
            a.trainingStatus === "processing"),
      ),
    [storeAvatars],
  );
  useEffect(() => {
    if (pendingAvatars.length === 0) return;
    let cancelled = false;
    const tick = async () => {
      for (const a of pendingAvatars) {
        try {
          await fetchAvatarStatusApi(a.id);
        } catch { /* 单次失败下轮再来 */ }
      }
      if (!cancelled) await queryClient.invalidateQueries({ queryKey: ["avatars"] });
    };
    const timer = setInterval(() => void tick(), 10_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [pendingAvatars, queryClient]);
```

（`isPlatformAvatarId` 从 `@/lib/services/platform-avatar` import——纯常量函数，client bundle 安全，它不 import env/storage。注意：platform-avatar.ts 当前 import 了 `lib/env`——env.ts 读 process.env，Next client 组件引用会内联为空对象但可构建；为稳妥把 `isPlatformAvatarId`/`PLATFORM_AVATAR_ID` 挪到 `lib/types.ts` 旁的新文件 `lib/platform-avatar-constants.ts`？**决定：保持单文件，dashboard 只 import 常量与纯函数——env accessor 调用只在 server 路径发生。Next 会把 `getHeygenAvatarTemplateId` tree-shake 不掉但运行时不调用即可。若构建报 `process` 相关错，再拆 constants 文件。**）

6) AI 分身 section（line 1242-1287）JSX 替换为：

```tsx
        <article className="card" id="avatar-clone">
          <div className="cardHeader">
            <div>
              <h2>AI 分身</h2>
              <p>上传一段你本人讲话的视频，AI 克隆你的形象和声音，以后不用出镜也能"真人"出镜</p>
            </div>
            <span className={storeAvatars.some((a) => a.trainingStatus === "ready") ? "statusBadge success" : "statusBadge warning"}>
              {storeAvatars.some((a) => a.trainingStatus === "ready") ? "已完成" : "待完成"}
            </span>
          </div>

          <input
            ref={footageInputRef}
            accept="video/*"
            className="srOnly"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void handleFootageUpload(f);
            }}
            type="file"
          />

          <div className="footageSection">
            <p className="resultHint">拍摄要求：30秒–5分钟、正脸面对镜头、光线充足、人声清晰、无背景音乐。</p>
            {footageAssets.length > 0 ? (
              <div className="mediaGrid" role="list" aria-label="人像视频列表">
                {footageAssets.map((item) => (
                  <label className={`mediaItem ${selectedFootageId === item.id ? "selected" : ""}`} key={item.id} role="listitem">
                    <input
                      aria-label={`选择人像视频 ${item.originalFilename}`}
                      checked={selectedFootageId === item.id}
                      onChange={() => setSelectedFootageId(item.id)}
                      type="radio"
                      name="footage"
                    />
                    <span className="mediaMeta"><strong>{item.originalFilename}</strong></span>
                  </label>
                ))}
              </div>
            ) : (
              <div className="emptyState avatarEmpty">
                <span>还没有人像视频。上传一段你本人讲话的视频开始克隆。</span>
              </div>
            )}
            <button
              className="secondaryButton"
              disabled={!store || footageUploading || Boolean(pendingAction)}
              onClick={() => footageInputRef.current?.click()}
              type="button"
            >
              {footageUploading ? <span className="spinner" aria-hidden="true" /> : null}
              上传人像视频
            </button>
          </div>

          {storeAvatars.filter((a) => !isPlatformAvatarId(a.id)).length > 0 ? (
            <ul className="analysisStatusList" aria-label="我的 AI 分身">
              {storeAvatars.filter((a) => !isPlatformAvatarId(a.id)).map((a) => (
                <li key={a.id}>
                  <span className={
                    a.trainingStatus === "ready" ? "statusBadge success"
                    : a.trainingStatus === "failed" ? "statusBadge warning"
                    : "statusBadge"
                  }>
                    {a.name || "未命名形象"}·
                    {a.trainingStatus === "ready" ? "已就绪"
                      : a.trainingStatus === "failed" ? `失败${a.statusReason ? `：${a.statusReason}` : ""}`
                      : a.consentStatus === "awaiting_user" ? "待真人授权"
                      : "训练中"}
                  </span>
                  {a.consentStatus === "awaiting_user" ? (
                    <button
                      className="secondaryButton"
                      onClick={() => void handleOpenConsent(a.id)}
                      type="button"
                    >
                      去完成授权
                    </button>
                  ) : null}
                  {a.trainingStatus === "failed" ? (
                    <button
                      className="secondaryButton"
                      onClick={() => void handleReissueConsent(a.id)}
                      type="button"
                    >
                      重新发起授权
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}

          <label>
            形象名字
            <input
              aria-label="形象名字"
              maxLength={20}
              onChange={(e) => setAvatarName(e.target.value)}
              placeholder="如：店主、店长小姐姐"
              type="text"
              value={avatarName}
            />
          </label>

          <label className="consentBox">
            <input checked={avatarConsent} onChange={(event) => setAvatarConsent(event.target.checked)} type="checkbox" />
            <span>我是视频中的本人（或已获其授权），同意克隆肖像和声音生成 AI 分身</span>
          </label>

          <button
            className="primaryButton"
            disabled={!store || !selectedFootageId || !avatarName.trim() || !avatarConsent || Boolean(pendingAction)}
            onClick={handleCreateAvatar}
            type="button"
          >
            {pendingAction === "avatar" ? <span className="spinner" aria-hidden="true" /> : null}
            创建 AI 分身
          </button>
        </article>
```

配套 handler：

```ts
  async function handleOpenConsent(avatarId: string) {
    try {
      const { consentUrl } = await fetchAvatarStatusApi(avatarId);
      if (consentUrl) {
        window.open(consentUrl, "_blank", "noopener,noreferrer");
        setMessage("请在新窗口完成真人授权。");
      } else {
        setMessage("授权链接已轮换，请点击「重新发起授权」。");
      }
    } catch {
      setMessage("获取授权链接失败，请稍后重试。");
    }
  }

  async function handleReissueConsent(avatarId: string) {
    try {
      const { consentUrl } = await reissueAvatarConsentApi(avatarId);
      await queryClient.invalidateQueries({ queryKey: ["avatars"] });
      window.open(consentUrl, "_blank", "noopener,noreferrer");
      setMessage("已重新发起授权：请在新窗口完成真人授权。");
    } catch {
      setMessage("重新发起授权失败，请稍后重试。");
    }
  }
```

7) `storeAvatars` memo（line 406-411）的平台形象跨店可见——改 filter：

```ts
  const storeAvatars = useMemo(() => {
    const list = store
      ? serverAvatars.filter((a) => a.storeId === store.id || isPlatformAvatarId(a.id))
      : [];
    return localAvatar && !list.some((a) => a.id === localAvatar.id)
      ? [localAvatar, ...list]
      : list;
  }, [serverAvatars, localAvatar, store]);
```

8) 进度面板/step 里 `avatar` 单数概念（line 403-404, 490-494, 506, 514）：`avatar` 用于步骤完成度判断，把 `avatar` 定义改为 `storeAvatars.find(a => a.trainingStatus === "ready") ?? null`（localAvatar 逻辑并入 storeAvatars 已覆盖）。删除旧 `const avatar = localAvatar ?? ...` 行，统一为（**位置必须放在 storeAvatars memo 之后**，line 411 之后）：

```ts
  const avatar = useMemo(
    () => storeAvatars.find((a) => a.trainingStatus === "ready") ?? null,
    [storeAvatars],
  );
```

- [ ] **Step 5: 改写 dashboard 测试中的 avatar 区用例**

`tests/dashboard.test.tsx`：
- 删除/替换引用旧契约（`trainingVideoAssetId`、`ownerId` 字段 POST、`创建 AI 形象` 旧流程、talking-head 预览触发）的用例（用 `grep -n "创建 AI 形象\|simulateAvatarClone\|trainingVideoAssetId\|requestTalkingHeadApi" tests/dashboard.test.tsx` 定位）。
- 新流程用例（渲染 → 上传人像视频 mock → 填名 → 勾选授权 → 点「创建 AI 分身」→ 断言 api-client mock 收到新契约 + window.open 被调；awaiting_user 形象显示「去完成授权」；failed 形象显示原因 + 「重新发起授权」）。window.open 用 `vi.stubGlobal("open", vi.fn())`——jsdom 的 window.open 直接 stub：`const openSpy = vi.spyOn(window, "open").mockImplementation(() => null)`。
- 素材库过滤用例：seed 一个 `category: "avatar_footage"` 的 asset，断言它不出现在素材库网格、但出现在人像视频列表。

- [ ] **Step 6: 跑测试确认通过 + 回归**

Run: `npx vitest run tests/api-client-avatars.test.ts tests/dashboard.test.tsx` → PASS；`npm test` 全绿；`npm run build` 确认 client 引用 platform-avatar 无构建问题。

- [ ] **Step 7: Commit**

```bash
git add lib/api-client.ts components/dashboard.tsx tests/dashboard.test.tsx tests/api-client-avatars.test.ts
git commit -m "feat(ui): avatar footage upload area + consent flow, asset library filters material only"
```

---

### Task 7: 脚本引擎多形象 personas + speakerIndex 派生

**Files:**
- Modify: `prisma/schema.prisma`（ScriptDraft 加 speakerAvatarIds）+ migration
- Modify: `lib/types.ts:129-150`（ScriptDraft）
- Modify: `lib/repositories/mappers.ts:177-219`（toScriptDraft/toScriptDraftInput）
- Modify: `lib/schemas.ts:116-134`（scriptDraftSchema）
- Modify: `lib/services/scene-derive.ts:20-42`（deriveSegmentsFromVoiceover）
- Modify: `lib/services/script-engine.ts`（personas prompt + speakerAssignments 解析）
- Modify: `app/api/script-drafts/route.ts:44-57`（POST 注入 personas）
- Test: `tests/scene-derive.test.ts`、`tests/script-engine.test.ts`、`tests/api/script-drafts.test.ts`（若无则新建路由级用例进 tests/api/）

**设计锚点（spec §6.4）：** AI prompt 告知各形象名字，segments 产出带 speakerIndex。speakerIndex 指向 **生成时刻 personas 数组下标**；该数组的 avatar id 顺序持久化到 `ScriptDraft.speakerAvatarIds`，渲染时按 id 对齐（不依赖确认时勾选顺序，子集勾选时回退第一个选中形象）。

- [ ] **Step 1: 写失败测试**

`tests/scene-derive.test.ts` 追加：

```ts
describe("deriveSegmentsFromVoiceover — speakerIndex (Phase 3)", () => {
  it("assigns speakerIndex from speakerByText verbatim matches", () => {
    const voiceover = "大家好，我是店主。今天推荐招牌蛋糕。快来店里。";
    const segments = deriveSegmentsFromVoiceover(voiceover, {
      speakerByText: new Map([["今天推荐招牌蛋糕。", 1]]),
    });
    expect(segments.map((s) => s.speakerIndex)).toEqual([0, 1, 0]);
  });

  it("prev segments win over speakerByText (user edit keeps assignments)", () => {
    const prev = [
      { index: 0, text: "大家好。", speakerIndex: 2, onCamera: true },
      { index: 1, text: "今天推荐招牌蛋糕。", speakerIndex: 1, onCamera: false },
    ];
    const segments = deriveSegmentsFromVoiceover("大家好。今天推荐招牌蛋糕。", {
      speakerByText: new Map([["今天推荐招牌蛋糕。", 0]]),
      prev,
    });
    expect(segments.map((s) => s.speakerIndex)).toEqual([2, 1]);
  });

  it("clamps negative/NaN speakerIndex to 0", () => {
    const segments = deriveSegmentsFromVoiceover("你好。", {
      speakerByText: new Map([["你好。", Number.NaN]]),
    });
    expect(segments[0]!.speakerIndex).toBe(0);
  });
});
```

`tests/script-engine.test.ts` 追加（沿用该文件的 ai-client mock 模式）：

```ts
  it("multi-persona: prompt lists avatar names and speakerAssignments map to speakerIndex", async () => {
    chatCompletionJSONMock.mockResolvedValueOnce({
      title: "t", hook: "h", cta: "c",
      voiceover: "开场白。 product介绍。 行动号召。",
      onCameraSentences: ["开场白。"],
      speakerAssignments: [
        { speakerIndex: 1, sentences: ["product介绍。"] },
        { speakerIndex: 0, sentences: ["开场白。", "行动号召。"] },
      ],
    });
    const draft = await createScriptDraft({
      store: baseStore, assetAnalyses: [], purpose: "store_traffic", targetDurationSec: 30,
      avatarPersonas: [
        { index: 0, name: "店主" },
        { index: 1, name: "店长小姐姐" },
      ],
    });
    // prompt 含人设名单
    const userPrompt = chatCompletionJSONMock.mock.calls[0][1] as string;
    expect(userPrompt).toContain("店主");
    expect(userPrompt).toContain("店长小姐姐");
    expect(userPrompt).toContain("speakerAssignments");
    // segments 按逐字匹配分配
    expect(draft.segments?.find((s) => s.text === "product介绍。")?.speakerIndex).toBe(1);
    expect(draft.segments?.find((s) => s.text === "开场白。")?.speakerIndex).toBe(0);
  });

  it("out-of-range speakerIndex falls back to 0 with a warn", async () => {
    chatCompletionJSONMock.mockResolvedValueOnce({
      title: "t", hook: "h", cta: "c", voiceover: "你好。再见。",
      speakerAssignments: [{ speakerIndex: 7, sentences: ["再见。"] }],
    });
    const draft = await createScriptDraft({
      store: baseStore, assetAnalyses: [], purpose: "store_traffic",
      avatarPersonas: [{ index: 0, name: "店主" }],
    });
    expect(draft.segments?.every((s) => s.speakerIndex === 0)).toBe(true);
  });

  it("single persona: no speakerAssignments required, all speakerIndex 0", async () => {
    chatCompletionJSONMock.mockResolvedValueOnce({
      title: "t", hook: "h", cta: "c", voiceover: "你好。再见。",
    });
    const draft = await createScriptDraft({
      store: baseStore, assetAnalyses: [], purpose: "store_traffic",
      avatarPersonas: [{ index: 0, name: "店主" }],
    });
    expect(draft.segments?.every((s) => s.speakerIndex === 0)).toBe(true);
  });
```

（`baseStore` 沿用文件内既有 fixture 名；`chatCompletionJSONMock` 若该文件叫别的名字，用既有 mock 句柄。）

路由级用例（新建 `tests/api/script-drafts-personas.test.ts`，模式参照 tests/api/ 下既有路由测试：seed store + ready avatar → POST → 断言 `script.speakerAvatarIds` 含该 avatar id）：

```ts
it("persists speakerAvatarIds from the store's ready avatars (createdAt order)", async () => {
  // seed store_1 + 该店两个 ready avatar（createdAt 一先一后）+ 一个 pending avatar + 一个别店 ready avatar
  const res = await POST(new Request("http://localhost/api/script-drafts", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ storeId: "store_1", purpose: "store_traffic", forceTemplate: true }),
  }));
  const json = await res.json();
  expect(json.script.speakerAvatarIds).toEqual(["avatar_early", "avatar_late"]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/scene-derive.test.ts tests/script-engine.test.ts tests/api/script-drafts-personas.test.ts`
Expected: FAIL（speakerByText 参数、avatarPersonas、speakerAvatarIds 均不存在）

- [ ] **Step 3: 实现 scene-derive 与 types**

`lib/services/scene-derive.ts` deriveSegmentsFromVoiceover 替换为：

```ts
/**
 * 从 voiceover 确定性重切 segments（spec §5.2/§6.4）：
 * - speakerIndex：prev 同文句继承 > speakerByText（AI speakerAssignments 逐字命中）> 0；
 * - onCamera 优先级：prev 同文句继承 > AI 出镜句选择 > 首/末句默认；
 * - 越界/非法 speakerIndex 一律收敛 0（渲染端按数组下标对齐，越界即脏数据）。
 */
export function deriveSegmentsFromVoiceover(
  voiceover: string,
  opts: {
    onCameraTexts?: string[];
    speakerByText?: Map<string, number>;
    prev?: ScriptSegment[];
  } = {},
): ScriptSegment[] {
  const sentences = splitVoiceoverSentences(voiceover);
  const onCameraSet = new Set((opts.onCameraTexts ?? []).map((s) => s.trim()).filter(Boolean));
  const speakerByText = opts.speakerByText ?? new Map<string, number>();
  const prevByText = new Map((opts.prev ?? []).map((s) => [s.text, s]));
  const last = sentences.length - 1;
  const setHasAnyHit = onCameraSet.size > 0 && sentences.some((text) => onCameraSet.has(text));
  if (onCameraSet.size > 0 && !setHasAnyHit) {
    console.warn("[scene-derive] AI onCameraSentences matched no sentence; falling back to first/last default");
  }

  return sentences.map((text, index) => {
    const prev = prevByText.get(text);
    const assigned = speakerByText.get(text);
    const speakerIndex =
      prev?.speakerIndex ??
      (typeof assigned === "number" && Number.isInteger(assigned) && assigned >= 0 ? assigned : 0);
    const onCamera = prev
      ? prev.onCamera
      : setHasAnyHit
        ? onCameraSet.has(text)
        : index === 0 || index === last;
    return { index, text, speakerIndex, onCamera };
  });
}
```

`lib/types.ts` ScriptDraft 加：

```ts
  /** 口播按句分段（服务端从 voiceover 派生/重切）。 */
  segments?: ScriptSegment[];
  /** speakerIndex → AvatarProfile.id 的对齐表（生成时刻的 personas 顺序）；渲染端按此解析说话人。 */
  speakerAvatarIds?: string[];
```

`lib/schemas.ts` scriptDraftSchema 加 `speakerAvatarIds: z.array(z.string()).optional(),`。

`prisma/schema.prisma` ScriptDraft 加 `speakerAvatarIds String[] @default([])`；mappers toScriptDraft 加 `speakerAvatarIds: row.speakerAvatarIds ?? []`，toScriptDraftInput 加 `speakerAvatarIds: script.speakerAvatarIds ?? []`。

migration：`npx prisma migrate dev --name add_script_speaker_avatar_ids`。

- [ ] **Step 4: 实现 script-engine personas**

`lib/services/script-engine.ts`：

1) `ScriptDraftInput` 加：

```ts
  /** 可用形象人设（index 对齐 speakerAvatarIds）；≥2 时 AI 分配每句说话人。 */
  avatarPersonas?: { index: number; name: string }[];
```

2) `AIScriptResponse` 加：

```ts
  /** 多形象时每句的说话人分配；sentences 必须逐字摘自 voiceover。 */
  speakerAssignments?: { speakerIndex: number; sentences: string[] }[];
```

3) `buildUserPrompt` 尾部追加 personas 段：

```ts
  if (input.avatarPersonas && input.avatarPersonas.length > 1) {
    lines.push(
      ``,
      `【出镜形象】本片 ${input.avatarPersonas.length} 位形象轮播出镜：`,
      ...input.avatarPersonas.map((p) => `${p.index + 1} 号：${sanitizePromptField(p.name, 20)}`),
      `请在 speakerAssignments 中把口播稿的【每一句】分配给一位形象（speakerIndex 从 0 起：0=1 号、1=2 号……），句子必须逐字摘自口播稿、覆盖全部句子且不重复；开场句与结尾 CTA 固定分配给 1 号形象。`,
    );
  }
```

4) `SCHEMA_DESCRIPTION` 加一行（单形象时 AI 可省略该字段）：

```ts
const SCHEMA_DESCRIPTION = `{
  "title": "视频标题（10字以内）",
  "hook": "开头吸引句（15字以内）",
  "voiceover": "完整口播文案（按目标时长控制总字数）",
  "highlights": ["口播稿中需标黄的关键词原文"],
  "onCameraSentences": ["适合真人出镜的口播句原文"],
  "speakerAssignments": [{"speakerIndex": 0, "sentences": ["逐字口播句"]}],
  "cta": "行动号召文案"
}`;
```

SYSTEM_PROMPT 要求列表加一条：`- speakerAssignments：仅在给了【出镜形象】名单时必填；每句逐字摘自口播稿，speakerIndex 不得超过形象数量-1`。

5) `createScriptDraftWithAI` 中 segments 派生处改为：

```ts
  const personaCount = input.avatarPersonas?.length ?? 0;
  const speakerByText = new Map<string, number>();
  if (personaCount > 1 && Array.isArray(aiResponse.speakerAssignments)) {
    for (const assignment of aiResponse.speakerAssignments) {
      const idx = Number(assignment?.speakerIndex);
      if (!Number.isInteger(idx) || idx < 0 || idx >= personaCount) {
        console.warn(`[script-engine] speakerAssignments index ${String(assignment?.speakerIndex)} out of range (0..${personaCount - 1}); sentences fall back to speaker 0`);
        continue;
      }
      for (const sentence of Array.isArray(assignment.sentences) ? assignment.sentences : []) {
        const key = String(sentence).trim();
        if (key) speakerByText.set(key, idx);
      }
    }
  }
  const segments = deriveSegmentsFromVoiceover(voiceover.copy, {
    onCameraTexts: Array.isArray(aiResponse.onCameraSentences)
      ? aiResponse.onCameraSentences.map(String)
      : [],
    speakerByText,
  });
```

6) `buildDraft` 入参与返回加 `speakerAvatarIds?: string[]`（返回对象里 `speakerAvatarIds: input.speakerAvatarIds ?? []`）；`createScriptDraftWithAI` / 模板路径 / forcedRawCopy 路径调用处传 `speakerAvatarIds: input.avatarPersonas?.map((p) => p.id)`——**注意 personas 目前只有 index+name，没有 id**。

   → 修正：`avatarPersonas` 类型改为 `{ index: number; id: string; name: string }[]`（id 不进 prompt，仅用于持久化对齐表；prompt 段只展示 name）。TemplateDraftInput 同样加 `speakerAvatarIds?: string[]`（路由模板路径也传）。forcedRawCopy 路径（`createScriptDraft` 分支 1）的 buildDraft 调用同样传 `speakerAvatarIds: input.avatarPersonas?.map((p) => p.id)`，保证三条路径产出的 draft 对齐表一致。

- [ ] **Step 5: 路由注入 personas**

`app/api/script-drafts/route.ts` POST：

```ts
import { getAssetAnalysisRepository, getAvatarRepository, getScriptRepository, getStoreRepository } from "@/lib/repositories";

// …POST 内，store 校验之后：
  // 多形象人设（spec §6.4）：本店 ready 形象，按创建时间排序，
  // speakerAvatarIds 持久化到 draft，渲染端 speakerIndex 按此对齐。
  const readyAvatars = (await getAvatarRepository().listByOwner(ownerId))
    .filter((a) => a.storeId === store.id && a.trainingStatus === "ready")
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  const avatarPersonas = readyAvatars.map((a, index) => ({
    index,
    id: a.id,
    name: a.name || `形象${index + 1}`,
  }));

  const script = body.forceTemplate
    ? createTemplateScriptDraft({
        store, purpose, reason: "manual_template_mode",
        targetDurationSec: durationSlot(body.targetDurationSec),
        speakerAvatarIds: avatarPersonas.map((p) => p.id),
      })
    : await createScriptDraft({
        store, assetAnalyses, purpose,
        platform: (body.platform ?? "douyin") as Platform,
        targetDurationSec: durationSlot(body.targetDurationSec),
        avatarPersonas,
      });
```

- [ ] **Step 6: 跑测试确认通过 + 回归**

Run: `npx vitest run tests/scene-derive.test.ts tests/script-engine.test.ts tests/api/script-drafts-personas.test.ts tests/api/script-drafts-id.test.ts` → PASS；`npm test` 全绿。

- [ ] **Step 7: Commit**

```bash
git add prisma/ lib/types.ts lib/schemas.ts lib/repositories/mappers.ts lib/services/scene-derive.ts lib/services/script-engine.ts app/api/script-drafts/route.ts tests/
git commit -m "feat(script): multi-persona speaker assignment with persisted speakerAvatarIds alignment"
```

---

### Task 8: render-projects 多形象 + RenderProject.avatarProfileIds + 任务图

**Files:**
- Modify: `prisma/schema.prisma`（RenderProject 加 avatarProfileIds）+ migration
- Modify: `lib/types.ts:152-168`（RenderProject）
- Modify: `lib/repositories/mappers.ts:221-257`
- Modify: `lib/schemas.ts:136-150`（renderProjectSchema）
- Modify: `lib/services/render-pipeline.ts`（createRenderProject + planRenderJobs）
- Modify: `app/api/render-projects/route.ts:58-72`
- Modify: `worker/processors/avatar-generation.ts`（数组校验路径）
- Test: `tests/api/render-projects.test.ts`、`tests/render-pipeline.test.ts`、`tests/worker-processors.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/api/render-projects.test.ts`：
- 把 `it("returns 400 when avatarProfileIds has more than one entry (single-avatar phase)")` 替换为：

```ts
  it("accepts up to 3 ready avatars; rejects the 4th", async () => {
    // seed 4 个 ready avatar（fixture helper 沿用文件内模式）
    const res = await post({
      scriptDraftId: script.id,
      selectedAssetIds: [asset.id],
      avatarProfileIds: ["avatar_a", "avatar_b", "avatar_c", "avatar_d"],
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/at most 3/i);
  });

  it("accepts 2 ready avatars and persists avatarProfileIds on the project", async () => {
    const res = await post({
      scriptDraftId: script.id,
      selectedAssetIds: [asset.id],
      avatarProfileIds: ["avatar_a", "avatar_b"],
    });
    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json.project.avatarProfileIds).toEqual(["avatar_a", "avatar_b"]);
    expect(json.project.avatarProfileId).toBe("avatar_a"); // legacy 字段 = 首位
    // 任务图：talking_head payload 带全部形象
    const th = json.jobs.find((j: { type: string }) => j.type === "talking_head");
    expect(th.payload.avatarProfileIds).toEqual(["avatar_a", "avatar_b"]);
  });

  it("rejects a non-ready avatar with 400", async () => {
    const res = await post({
      scriptDraftId: script.id,
      selectedAssetIds: [asset.id],
      avatarProfileIds: ["avatar_pending"],
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not ready/i);
  });

  it("accepts the platform avatar id without a repo row", async () => {
    const res = await post({
      scriptDraftId: script.id,
      selectedAssetIds: [asset.id],
      avatarProfileIds: ["avatar_platform"],
    });
    expect(res.status).toBe(202);
  });
```

`tests/render-pipeline.test.ts` 追加：

```ts
  it("plans avatar_generation + talking_head with avatarProfileIds payload, video_render depends on both", () => {
    const project = createRenderProject({
      ownerId: "o", storeId: "s", scriptDraft: draftFixture,
      selectedAssetIds: ["asset_1"],
      avatarProfiles: [avatarA, avatarB] as AvatarProfile[],
      aspectRatio: "9:16", subtitleStyle: "bold_bottom",
    });
    expect(project.avatarProfileId).toBe("avatar_a");
    expect(project.avatarProfileIds).toEqual(["avatar_a", "avatar_b"]);

    const jobs = planRenderJobs({ project, includeAvatar: true });
    const [avatarJob, thJob, renderJob] = jobs;
    expect(avatarJob!.payload.avatarProfileIds).toEqual(["avatar_a", "avatar_b"]);
    expect(thJob!.payload).toMatchObject({ avatarProfileIds: ["avatar_a", "avatar_b"], scriptDraftId: draftFixture.id });
    expect(thJob!.dependsOnJobIds).toEqual([avatarJob!.id]);
    expect(renderJob!.dependsOnJobIds).toEqual([avatarJob!.id, thJob!.id]);
  });
```

`tests/worker-processors.test.ts`（avatar_generation 用例处）追加：

```ts
  it("avatar_generation validates every avatarProfileId in the array", async () => {
    // seed avatar_a(ready) + avatar_b(ready) → 正常返回
    // seed 含缺失 id ["avatar_a", "avatar_missing"] → rejects
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/api/render-projects.test.ts tests/render-pipeline.test.ts tests/worker-processors.test.ts`
Expected: FAIL（>1 仍 400；avatarProfileIds 字段不存在）

- [ ] **Step 3: 实现数据模型**

`prisma/schema.prisma` RenderProject 加：

```prisma
  avatarProfileId  String?
  avatarProfileIds String[]       @default([])
```

migration：`npx prisma migrate dev --name add_render_avatar_ids`。

`lib/types.ts` RenderProject 加：

```ts
  avatarProfileId?: string;
  /** 多形象轮播（Phase 3）：有序 AvatarProfile.id 列表；空 = 纯素材成片。avatarProfileId 恒等于首元素（legacy 兼容）。 */
  avatarProfileIds?: string[];
```

`lib/repositories/mappers.ts` toRenderProject 加 `avatarProfileIds: row.avatarProfileIds ?? []`；toRenderProjectInput 加 `avatarProfileIds: project.avatarProfileIds ?? []`。

`lib/schemas.ts` renderProjectSchema 加 `avatarProfileIds: z.array(z.string()).optional(),`。

- [ ] **Step 4: 实现 render-pipeline**

`lib/services/render-pipeline.ts`：

```ts
interface CreateRenderProjectInput {
  ownerId: string;
  storeId: string;
  scriptDraft: ScriptDraft;
  selectedAssetIds: string[];
  /** Phase 3：有序形象列表（多形象轮播）。空 = 纯素材成片。 */
  avatarProfiles?: AvatarProfile[];
  aspectRatio: AspectRatio;
  subtitleStyle: RenderProject["subtitleStyle"];
  bgmTrackId?: string;
}

export function createRenderProject(input: CreateRenderProjectInput): RenderProject {
  const now = nowIso();
  const avatarProfileIds = (input.avatarProfiles ?? []).map((a) => a.id);
  return {
    id: createId("render"),
    ownerId: input.ownerId,
    storeId: input.storeId,
    scriptDraftId: input.scriptDraft.id,
    selectedAssetIds: input.selectedAssetIds,
    avatarProfileId: avatarProfileIds[0],
    avatarProfileIds,
    purpose: input.scriptDraft.purpose,
    aspectRatio: input.aspectRatio,
    subtitleStyle: input.subtitleStyle,
    bgmTrackId: input.bgmTrackId,
    targetDurationSec: input.scriptDraft.targetDurationSec,
    status: "queued",
    createdAt: now,
    updatedAt: now
  };
}
```

`planRenderJobs` 改为：

```ts
export function planRenderJobs(input: { project: RenderProject; includeAvatar: boolean }): Job[] {
  const now = nowIso();
  const jobs: Job[] = [];
  const avatarProfileIds = input.project.avatarProfileIds ?? [];

  if (input.includeAvatar && avatarProfileIds.length > 0) {
    const avatarJobId = createId("job");
    jobs.push({
      id: avatarJobId,
      ownerId: input.project.ownerId,
      projectId: input.project.id,
      type: "avatar_generation",
      status: "queued",
      progress: 0,
      payload: { avatarProfileIds, fallbackMode: "tts_voiceover" },
      dependsOnJobIds: [],
      createdAt: now,
      updatedAt: now
    });

    // talking_head 按 draft.segments 分段合成（Phase 3）：出镜段数字人视频 +
    // 画外音段克隆声音 TTS；处理器按 draft.speakerAvatarIds 对齐说话人。
    jobs.push({
      id: createId("job"),
      ownerId: input.project.ownerId,
      projectId: input.project.id,
      type: "talking_head",
      status: "queued",
      progress: 0,
      payload: { avatarProfileIds, scriptDraftId: input.project.scriptDraftId },
      dependsOnJobIds: [avatarJobId],
      createdAt: now,
      updatedAt: now
    });
  }

  jobs.push({
    id: createId("job"),
    ownerId: input.project.ownerId,
    projectId: input.project.id,
    type: "video_render",
    status: "queued",
    progress: 0,
    payload: {
      aspectRatio: input.project.aspectRatio,
      subtitleStyle: input.project.subtitleStyle,
      bgmTrackId: input.project.bgmTrackId
    },
    dependsOnJobIds: jobs.map((job) => job.id),
    createdAt: now,
    updatedAt: now
  });

  return jobs;
}
```

- [ ] **Step 5: 实现路由多选校验**

`app/api/render-projects/route.ts` 把 line 58-72 段替换为：

```ts
  // Phase 3：avatarProfileIds 多选（≤3），逐形像校验属主 + ready；平台公共形象免查库。
  const MAX_RENDER_AVATARS = 3;
  const avatarIds = Array.isArray(body.avatarProfileIds)
    ? (body.avatarProfileIds as unknown[]).filter((x): x is string => typeof x === "string")
    : undefined;
  if (avatarIds && avatarIds.length > MAX_RENDER_AVATARS) {
    return jsonError(`avatarProfileIds supports at most ${MAX_RENDER_AVATARS} avatars`, 400);
  }
  if (avatarIds && new Set(avatarIds).size !== avatarIds.length) {
    return jsonError("avatarProfileIds must not contain duplicates", 400);
  }
  const legacyId = body.avatarProfileId as string | undefined;
  const requestedIds = avatarIds ?? (legacyId ? [legacyId] : []);

  const avatarProfiles: AvatarProfile[] = [];
  for (const id of requestedIds) {
    if (isPlatformAvatarId(id)) {
      avatarProfiles.push(buildPlatformAvatar(ownerId));
      continue;
    }
    const profile = (await getAvatarRepository().findById(id)) ?? undefined;
    // IDOR：foreign/不存在一律 404，不泄漏存在性。
    if (!profile || profile.ownerId !== ownerId) {
      return jsonError("Avatar profile not found", 404);
    }
    if (profile.trainingStatus !== "ready" || !profile.providerAvatarId) {
      return jsonError(`Avatar profile not ready: ${profile.name || id}`, 400);
    }
    avatarProfiles.push(profile);
  }
```

`createRenderProject` 调用改 `avatarProfiles`，`planRenderJobs({ project, includeAvatar: avatarProfiles.length > 0 })`。import 加 `isPlatformAvatarId, buildPlatformAvatar` from `@/lib/services/platform-avatar`、`AvatarProfile` type。

- [ ] **Step 6: avatar_generation 处理器数组校验**

`worker/processors/avatar-generation.ts` 在单 id 路径前加：

```ts
  // Phase 3：多形象批量校验（planRenderJobs 新契约）。平台公共形象不查库。
  if (Array.isArray(payload.avatarProfileIds)) {
    const ready: string[] = [];
    for (const id of payload.avatarProfileIds as string[]) {
      if (isPlatformAvatarId(id)) continue;
      const avatar = await getAvatarRepository().findById(id);
      if (!avatar) {
        throw new Error(`Avatar profile not found: ${id}`);
      }
      ready.push(id);
    }
    return { avatarProfileIds: payload.avatarProfileIds, trainingStatus: "ready" as const, validated: ready };
  }
```

（payload 类型加 `avatarProfileIds?: string[]`；单 id legacy 路径保留。）

- [ ] **Step 7: 跑测试确认通过 + 回归**

Run: `npx vitest run tests/api/render-projects.test.ts tests/render-pipeline.test.ts tests/worker-processors.test.ts` → PASS；`npm test` 全绿。

注意既有用例里 `avatarProfileIds: [avatar.id]` 的 fixture avatar 需是 ready 且有 providerAvatarId（Task 2 后 fixture 已补字段，此处确认 trainingStatus: "ready" + providerAvatarId 非空）。

- [ ] **Step 8: Commit**

```bash
git add prisma/ lib/types.ts lib/schemas.ts lib/repositories/mappers.ts lib/services/render-pipeline.ts app/api/render-projects/route.ts worker/processors/avatar-generation.ts tests/
git commit -m "feat(render): multi-avatar render projects (<=3) with per-avatar readiness validation"
```

---

### Task 9: ScriptConfirm 形象多选 + 成本预估

**Files:**
- Create: `lib/cost-estimate.ts`
- Modify: `components/script-confirm.tsx`（radio 单选 → checkbox 多选 ≤3 + 成本行）
- Test: `tests/cost-estimate.test.ts`（新建）、`tests/script-confirm.test.tsx`

**设计：** 配额维持 1 次生成 = 1 配额（spec §6.4），确认卡片新增预估成本展示（出镜段 $0.0667/s、画外音段 ≈$0.0003/s，按 4.5 字/秒估算）。默认勾选第一个 ready 形象（与 Phase 2 默认一致，避免默认勾选全部推高成本）。不勾选任何形象 = 纯素材成片。

- [ ] **Step 1: 写失败测试**

新建 `tests/cost-estimate.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import {
  AVATAR_VIDEO_USD_PER_SEC,
  CLONED_TTS_USD_PER_SEC,
  estimateRenderCost,
} from "@/lib/cost-estimate";

const seg = (text: string, onCamera: boolean) => ({
  index: 0, text, speakerIndex: 0, onCamera,
});

describe("estimateRenderCost", () => {
  it("splits seconds by onCamera and prices the two tiers", () => {
    // 45 字出镜 = 10s；45 字画外音 = 10s
    const est = estimateRenderCost([seg("一".repeat(45), true), seg("二".repeat(45), false)]);
    expect(est.onCameraSec).toBe(10);
    expect(est.voiceoverSec).toBe(10);
    expect(est.totalUsd).toBeCloseTo(10 * AVATAR_VIDEO_USD_PER_SEC + 10 * CLONED_TTS_USD_PER_SEC, 4);
  });

  it("no avatars selected → zero cost regardless of segments", () => {
    expect(estimateRenderCost([seg("一".repeat(90), true)], 0).totalUsd).toBe(0);
  });

  it("empty/undefined segments → zero", () => {
    expect(estimateRenderCost(undefined, 2).totalUsd).toBe(0);
    expect(estimateRenderCost([], 1).totalUsd).toBe(0);
  });
});
```

`tests/script-confirm.test.tsx` 改写（该文件 line 63-89 两个用例替换 + 新增）：

```ts
  it("defaults to the first ready avatar checked; confirms with it", async () => {
    // 渲染含 2 个 ready 形象的卡片 → 只有第一个被勾选
    // 确认后 onConfirm 收到 avatarProfileIds: [firstReadyId]
  });

  it("multiple avatars can be checked up to 3; the 4th checkbox stays disabled", async () => {
    // 渲染 4 个 ready 形象 → 勾选 3 个后第 4 个 disabled
  });

  it("unchecking all avatars confirms with empty avatarProfileIds (asset_only)", async () => {
    // 取消默认勾选 → 确认 → avatarProfileIds: []
  });

  it("shows the estimated cost line when at least one avatar is checked", async () => {
    // 断言出现 /预计数字人成本/ 文案；取消全部勾选后消失
  });

  it("non-ready avatars are disabled and labeled", async () => {
    // trainingStatus !== "ready" → checkbox disabled + 「不可用」标记
  });
```

（每个用例写全 render 代码：沿用文件既有 `render(<ScriptConfirm .../>)` 模式与 `onConfirm` vi.fn 断言模式，props 结构不变。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/cost-estimate.test.ts tests/script-confirm.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现 cost-estimate**

新建 `lib/cost-estimate.ts`：

```ts
import type { ScriptSegment } from "@/lib/types";
import { estimateSegmentSeconds } from "@/lib/services/scene-derive";

/** HeyGen 定价（spec §2）：数字人视频 $0.0667/s；克隆声音 TTS ≈ $0.000333/s。 */
export const AVATAR_VIDEO_USD_PER_SEC = 0.0667;
export const CLONED_TTS_USD_PER_SEC = 0.000333;

export interface RenderCostEstimate {
  onCameraSec: number;
  voiceoverSec: number;
  videoUsd: number;
  ttsUsd: number;
  totalUsd: number;
}

/**
 * 确认卡片预估成本（spec §6.4）：按段字数 / 4.5 字每秒估算时长，
 * 出镜段计视频价、画外音段计 TTS 价。未选形象 = 纯素材成片，零数字人成本。
 */
export function estimateRenderCost(
  segments: ScriptSegment[] | undefined,
  avatarCount = 1,
): RenderCostEstimate {
  if (avatarCount <= 0) {
    return { onCameraSec: 0, voiceoverSec: 0, videoUsd: 0, ttsUsd: 0, totalUsd: 0 };
  }
  let onCameraSec = 0;
  let voiceoverSec = 0;
  for (const seg of segments ?? []) {
    const sec = estimateSegmentSeconds(seg.text);
    if (seg.onCamera) onCameraSec += sec;
    else voiceoverSec += sec;
  }
  const videoUsd = onCameraSec * AVATAR_VIDEO_USD_PER_SEC;
  const ttsUsd = voiceoverSec * CLONED_TTS_USD_PER_SEC;
  return { onCameraSec, voiceoverSec, videoUsd, ttsUsd, totalUsd: videoUsd + ttsUsd };
}
```

- [ ] **Step 4: 实现 ScriptConfirm 多选**

`components/script-confirm.tsx`：

1) state 替换：

```tsx
  // 形象多选（Phase 3，spec §6.4）：≤3，默认勾选第一个 ready 形象；全不勾 = 纯素材成片。
  const MAX_RENDER_AVATARS = 3;
  const [avatarIds, setAvatarIds] = useState<string[]>(
    () => {
      const first = avatars.find((a) => a.trainingStatus === "ready");
      return first ? [first.id] : [];
    },
  );
```

2) 成本估算 memo：

```tsx
  const costEstimate = useMemo(
    () => estimateRenderCost(draft.segments, avatarIds.length),
    [draft.segments, avatarIds.length],
  );
```

3) `handleConfirm` 改 `avatarProfileIds: avatarIds`。

4) avatarPicker fieldset 替换为：

```tsx
      <fieldset className="avatarPicker">
        <legend>出镜形象（可多选，轮播出镜，最多 {MAX_RENDER_AVATARS} 个；全不勾 = 纯素材成片）</legend>
        {avatars.map((a) => {
          const checked = avatarIds.includes(a.id);
          const ready = a.trainingStatus === "ready";
          const disabled = !ready || (!checked && avatarIds.length >= MAX_RENDER_AVATARS);
          return (
            <label key={a.id}>
              <input
                type="checkbox"
                name="avatar"
                checked={checked}
                disabled={disabled}
                onChange={() =>
                  setAvatarIds((prev) =>
                    checked ? prev.filter((id) => id !== a.id) : [...prev, a.id]
                  )
                }
              />
              {a.name || "未命名形象"}
              {isPlatformAvatarId(a.id) ? "（平台公共形象）" : ""}
              {ready ? "" : "（不可用）"}
            </label>
          );
        })}
        {avatars.length === 0 ? <span>暂无可用形象，将生成纯素材成片。</span> : null}
      </fieldset>

      {avatarIds.length > 0 ? (
        <p className="costHint" aria-label="成本预估">
          预计数字人成本约 ${costEstimate.totalUsd.toFixed(2)}（出镜 {costEstimate.onCameraSec}s +
          画外音 {costEstimate.voiceoverSec}s · 消耗 1 次生成配额）
        </p>
      ) : null}
```

import 加 `estimateRenderCost` from `@/lib/cost-estimate`、`isPlatformAvatarId` from `@/lib/services/platform-avatar`。

- [ ] **Step 5: 跑测试确认通过 + 回归**

Run: `npx vitest run tests/cost-estimate.test.ts tests/script-confirm.test.tsx` → PASS；`npm test` 全绿（dashboard.test.tsx 若引用 radio 行为同步修）。

- [ ] **Step 6: Commit**

```bash
git add lib/cost-estimate.ts components/script-confirm.tsx tests/cost-estimate.test.ts tests/script-confirm.test.tsx
git commit -m "feat(ui): multi-avatar picker with per-segment cost estimate on the confirm card"
```

---

### Task 10: talking_head 分段生成 + voice-track manifest + TTS 降级

**Files:**
- Create: `lib/services/voice-track.ts`
- Modify: `lib/types.ts:184`（VideoOutputKind 加 "segmented_voice"）
- Modify: `lib/repositories/types.ts:54`、`lib/repositories/memory.ts:164-169`、`lib/repositories/prisma.ts:229-235`（findTalkingHeadOutputByProject 覆盖双 kind）
- Modify: `worker/processors/talking-head.ts`（分段生成重写）
- Test: `tests/voice-track.test.ts`（新建）、`tests/talking-head-processor.test.ts`（重写主体）

**设计（spec §6.4/§6.5）：** talking_head 处理器从「整段口播一个数字人视频」升级为按 `draft.segments` 逐段合成：onCamera 段 → 该形象数字人视频（音视频一体）；画外音段 → 该形象克隆声音 TTS（拿 word_timestamps）。产物 = 每段视频/音频文件 + R2 上的 manifest JSON；`VideoOutput(kind="segmented_voice", storageKey=manifest key)` 供 video_render 消费。TTS 失败：重试 1 次 → 降级为该段数字人视频（`fellBackToVideo: true`）。`draft.segments` 为空（老数据）→ 保持 legacy 整段单视频路径。

- [ ] **Step 1: 写失败测试**

新建 `tests/voice-track.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { planSegmentSynthesis, voiceTrackManifestKey } from "@/lib/services/voice-track";
import type { ScriptSegment } from "@/lib/types";

const speakers = [
  { profileId: "avatar_a", providerAvatarId: "look_a", providerVoiceId: "voice_a" },
  { profileId: "avatar_b", providerAvatarId: "look_b", providerVoiceId: "voice_b" },
];

const segs: ScriptSegment[] = [
  { index: 0, text: "开场。", speakerIndex: 0, onCamera: true },
  { index: 1, text: "介绍。", speakerIndex: 1, onCamera: false },
  { index: 2, text: "收尾。", speakerIndex: 5, onCamera: true }, // 越界 → clamp 到末位
];

describe("planSegmentSynthesis", () => {
  it("maps each segment to its speaker with clamping", () => {
    const plan = planSegmentSynthesis(segs, speakers);
    expect(plan).toHaveLength(3);
    expect(plan[0]).toMatchObject({ segment: segs[0], speaker: speakers[0] });
    expect(plan[1]).toMatchObject({ speaker: speakers[1] });
    expect(plan[2]).toMatchObject({ speaker: speakers[1] }); // clamped
  });

  it("empty speakers throws (render-projects route guarantees non-empty)", () => {
    expect(() => planSegmentSynthesis(segs, [])).toThrow();
  });
});

describe("voiceTrackManifestKey", () => {
  it("is namespaced per project and ends with .json", () => {
    expect(voiceTrackManifestKey("render_1")).toBe("voice-tracks/render_1/manifest.json");
  });
});
```

`tests/talking-head-processor.test.ts` 追加分段套件（沿用该文件既有 seed 与 BullJob stub 模式；deps.provider 用 `createMockProvider({ avatarId, voiceId })` 的扩展 mock）：

```ts
describe("segmented synthesis (Phase 3)", () => {
  it("onCamera→video, offCamera→TTS; persists manifest output", async () => {
    // seed: draft.segments = [出镜(speaker 0), 画外音(speaker 0)]，avatar ready
    // payload: { avatarProfileIds: ["av_1"], scriptDraftId: "draft_seg" }
    const result = await processTalkingHead(job, deps);
    expect(result.kind).toBe("segmented_voice");
    expect(result.storageKey).toBe("voice-tracks/render_x/manifest.json");
    // uploadManifest 捕获的 manifest：
    const manifest = uploadManifestMock.mock.calls[0][1];
    expect(manifest.segments[0]).toMatchObject({ onCamera: true, videoStorageKey: expect.stringMatching(/^avatar_video/) });
    expect(manifest.segments[1]).toMatchObject({ onCamera: false, audioStorageKey: expect.stringMatching(/^voice_audio/) });
    expect(manifest.segments[1].words.length).toBeGreaterThan(0);
    expect(manifest.totalDurationSec).toBeGreaterThan(0);
  });

  it("speakerIndex resolves via draft.speakerAvatarIds, missing → first selected", async () => {
    // draft.speakerAvatarIds = ["av_b"]，segment speakerIndex=0，payload avatarProfileIds=["av_a","av_b"]
    // → 该段用 av_b 的 provider ids 合成（mock provider 按 input.providerVoiceId 断言）
  });

  it("TTS failure retries once then falls back to a talking-head video for that segment", async () => {
    // provider: failTtsOnce（扩展 mock 选项，第一次 TTS 抛错、第二次成功）→ 无 fellBackToVideo
    // provider: failTts: true → segment 1 有 videoStorageKey 且 fellBackToVideo === true
  });

  it("legacy: draft without segments keeps the single-video path", async () => {
    // segments: [] → kind === "talking_head"（既有行为不变）
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/voice-track.test.ts tests/talking-head-processor.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 voice-track 模块**

新建 `lib/services/voice-track.ts`：

```ts
import type { ScriptSegment } from "@/lib/types";
import type { WordTimestamp } from "@/lib/services/avatar-provider";

/** 合成用的形象解析结果（provider ids 已就绪）。 */
export interface ResolvedSpeaker {
  profileId: string;
  providerAvatarId: string;
  providerVoiceId?: string;
}

export interface VoiceTrackSegment {
  /** 对齐 ScriptSegment.index。 */
  index: number;
  speakerIndex: number;
  onCamera: boolean;
  text: string;
  /** onCamera 段 / TTS 降级段：数字人视频（音视频一体）storageKey。 */
  videoStorageKey?: string;
  /** 画外音段：TTS 音频 storageKey。 */
  audioStorageKey?: string;
  durationSec: number;
  /** TTS 词级时间轴（相对本段起点的秒）；onCamera 段没有（HeyGen 视频不返回）。 */
  words?: WordTimestamp[];
  /** TTS 重试失败后降级为数字人视频的标记（spec §6.5）。 */
  fellBackToVideo?: boolean;
}

export interface VoiceTrackManifest {
  version: 1;
  segments: VoiceTrackSegment[];
  totalDurationSec: number;
}

export function voiceTrackManifestKey(projectId: string): string {
  return `voice-tracks/${projectId}/manifest.json`;
}

export interface SegmentSynthesisPlan {
  segment: ScriptSegment;
  speaker: ResolvedSpeaker;
}

/**
 * 逐段 → 说话人解析。speakerIndex 经 draft.speakerAvatarIds 对齐到本次选中的
 * 形象列表；id 不在选中集（用户取消勾选）或下标越界 → 回退第一个选中形象。
 */
export function planSegmentSynthesis(
  segments: ScriptSegment[],
  speakers: ResolvedSpeaker[],
  speakerAvatarIds?: string[],
): SegmentSynthesisPlan[] {
  if (speakers.length === 0) {
    throw new Error("planSegmentSynthesis requires at least one speaker");
  }
  return segments.map((segment) => {
    const wantedId = speakerAvatarIds?.[segment.speakerIndex];
    const byId = wantedId ? speakers.find((s) => s.profileId === wantedId) : undefined;
    const byIndex = speakers[Math.min(Math.max(segment.speakerIndex, 0), speakers.length - 1)];
    return { segment, speaker: byId ?? byIndex ?? (speakers[0] as ResolvedSpeaker) };
  });
}
```

`lib/types.ts`：`export type VideoOutputKind = "talking_head" | "segmented_voice" | "final_composite" | "slideshow";`

repo 三处：`findTalkingHeadOutputByProject` 查询条件从 `kind === "talking_head"` 放宽为 `kind in ("talking_head", "segmented_voice")`（prisma 用 `kind: { in: [...] }`，memory 用 `.includes`），方法注释加「segmented_voice 是 Phase 3 分段口播产物，同为 video_render 的配音源」。

- [ ] **Step 4: 重写 talking_head 处理器**

`worker/processors/talking-head.ts` 全文替换：

```ts
import type { Job } from "bullmq";
import { createId, nowIso } from "@/lib/ids";
import type { AvatarProvider } from "@/lib/services/avatar-provider";
import { createProviderFromEnv, requestAvatarTalkingHead } from "@/lib/services/avatar-provider";
import {
  isPlatformAvatarId,
  resolvePlatformProviderIds,
} from "@/lib/services/platform-avatar";
import {
  planSegmentSynthesis,
  voiceTrackManifestKey,
  type ResolvedSpeaker,
  type VoiceTrackManifest,
  type VoiceTrackSegment,
} from "@/lib/services/voice-track";
import { putObjectFromBuffer } from "@/lib/storage";
import {
  getAvatarRepository,
  getRenderRepository,
  getScriptRepository
} from "@/lib/repositories";
import type {
  AvatarRepository,
  RenderRepository,
  ScriptRepository
} from "@/lib/repositories/types";
import type { AvatarProfile, VideoOutput } from "@/lib/types";
import type { ProcessorFn } from "./index";

export interface TalkingHeadDeps {
  avatarRepository: AvatarRepository;
  scriptRepository: ScriptRepository;
  renderRepository: RenderRepository;
  provider: AvatarProvider;
  /** manifest JSON 上传（默认 R2）；测试注入捕获。 */
  uploadManifest: (key: string, manifest: VoiceTrackManifest) => Promise<void>;
}

const defaultUploadManifest = async (key: string, manifest: VoiceTrackManifest): Promise<void> => {
  await putObjectFromBuffer(key, new TextEncoder().encode(JSON.stringify(manifest)), "application/json");
};

export const talkingHeadProcessor: ProcessorFn = (job) =>
  processTalkingHead(job, {
    avatarRepository: getAvatarRepository(),
    scriptRepository: getScriptRepository(),
    renderRepository: getRenderRepository(),
    provider: createProviderFromEnv(),
    uploadManifest: defaultUploadManifest
  });

/** payload → 有序 speaker 解析（含平台公共形象；缺失/未就绪直接抛错走 job 重试）。 */
async function resolveSpeakers(
  ids: string[],
  deps: Pick<TalkingHeadDeps, "avatarRepository" | "provider">,
  ownerId: string,
): Promise<ResolvedSpeaker[]> {
  const speakers: ResolvedSpeaker[] = [];
  for (const id of ids) {
    if (isPlatformAvatarId(id)) {
      const envIds = resolvePlatformProviderIds();
      if (envIds) {
        speakers.push({ profileId: id, ...envIds });
        continue;
      }
      // env 未配模板 → provider 公共形象解析（heygen 公共 stock / mock 随机 id）。
      const created = await deps.provider.createAvatar({ trainingVideoAssetId: "", ownerId });
      speakers.push({
        profileId: id,
        providerAvatarId: created.providerAvatarId,
        providerVoiceId: created.providerVoiceId,
      });
      continue;
    }
    const avatar: AvatarProfile | null = await deps.avatarRepository.findById(id);
    if (!avatar?.providerAvatarId) {
      throw new Error(`Avatar profile ${id} not ready (missing providerAvatarId)`);
    }
    speakers.push({
      profileId: id,
      providerAvatarId: avatar.providerAvatarId,
      providerVoiceId: avatar.providerVoiceId,
    });
  }
  return speakers;
}

export async function processTalkingHead(job: Job, deps: TalkingHeadDeps): Promise<VideoOutput> {
  const payload = job.data.payload as {
    avatarProfileId?: string;
    avatarProfileIds?: string[];
    scriptDraftId: string;
  };
  const projectId = (job.data.projectId as string | undefined) ?? null;
  const ownerId = (job.data.ownerId as string) ?? "demo_user";

  const draft = await deps.scriptRepository.findById(payload.scriptDraftId);
  if (!draft) {
    throw new Error(`Script draft ${payload.scriptDraftId} not found`);
  }

  const avatarIds = payload.avatarProfileIds ?? (payload.avatarProfileId ? [payload.avatarProfileId] : []);
  if (avatarIds.length === 0) {
    throw new Error("talking_head requires at least one avatarProfileId");
  }
  const speakers = await resolveSpeakers(avatarIds, deps, ownerId);

  const segments = draft.segments ?? [];

  // ── Legacy 路径：无 segments 的老 draft → 整段单视频（Phase 2 行为） ──
  if (segments.length === 0) {
    const speaker = speakers[0] as ResolvedSpeaker;
    const result = await requestAvatarTalkingHead({
      provider: deps.provider,
      avatarProfileId: speaker.profileId,
      providerAvatarId: speaker.providerAvatarId,
      providerVoiceId: speaker.providerVoiceId,
      scriptText: draft.voiceover,
      onProgress: (attempt, maxAttempts) => {
        const pct = 5 + Math.round((attempt / maxAttempts) * 80);
        void job.updateProgress(pct);
      }
    });
    await job.updateProgress(90);
    const output = buildOutput(projectId, ownerId, result.videoAssetId, result.durationSeconds, "talking_head");
    await persistOutput(deps, output);
    await job.updateProgress(100);
    return output;
  }

  // ── Phase 3 分段路径 ──
  const plan = planSegmentSynthesis(segments, speakers, draft.speakerAvatarIds);
  const trackSegments: VoiceTrackSegment[] = [];

  for (let i = 0; i < plan.length; i++) {
    const { segment, speaker } = plan[i]!;
    if (segment.onCamera) {
      // 出镜段：数字人视频（音视频一体）
      const result = await deps.provider.generateTalkingHead({
        providerAvatarId: speaker.providerAvatarId,
        providerVoiceId: speaker.providerVoiceId,
        scriptText: segment.text,
      });
      trackSegments.push({
        index: segment.index,
        speakerIndex: segment.speakerIndex,
        onCamera: true,
        text: segment.text,
        videoStorageKey: result.videoAssetId,
        durationSec: result.durationSeconds,
      });
    } else {
      // 画外音段：克隆声音 TTS（含词级时间轴）；失败重试 1 次 → 降级数字人视频（spec §6.5）
      trackSegments.push(await synthesizeOffCameraSegment(segment, speaker, deps.provider));
    }
    void job.updateProgress(5 + Math.round(((i + 1) / plan.length) * 80));
  }

  const manifest: VoiceTrackManifest = {
    version: 1,
    segments: trackSegments,
    totalDurationSec: trackSegments.reduce((acc, s) => acc + s.durationSec, 0),
  };
  const manifestKey = voiceTrackManifestKey(projectId ?? job.id);
  await job.updateProgress(90);
  await deps.uploadManifest(manifestKey, manifest);

  const output = buildOutput(projectId, ownerId, manifestKey, manifest.totalDurationSec, "segmented_voice");
  await persistOutput(deps, output);
  await job.updateProgress(100);
  return output;
}

async function synthesizeOffCameraSegment(
  segment: { index: number; speakerIndex: number; text: string },
  speaker: ResolvedSpeaker,
  provider: AvatarProvider,
): Promise<VoiceTrackSegment> {
  const base = {
    index: segment.index,
    speakerIndex: segment.speakerIndex,
    onCamera: false as const,
    text: segment.text,
  };
  if (!speaker.providerVoiceId) {
    // 无克隆声音（理论上 ready 形象都有）→ 直接降级数字人视频
    const result = await provider.generateTalkingHead({
      providerAvatarId: speaker.providerAvatarId,
      scriptText: segment.text,
    });
    return { ...base, videoStorageKey: result.videoAssetId, durationSec: result.durationSeconds, fellBackToVideo: true };
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const speech = await provider.synthesizeSpeech({
        providerVoiceId: speaker.providerVoiceId,
        text: segment.text,
      });
      return {
        ...base,
        audioStorageKey: speech.audioStorageKey,
        durationSec: speech.durationSeconds,
        words: speech.words,
      };
    } catch (error) {
      console.warn(
        `[talking_head] TTS attempt ${attempt + 1} failed for segment ${segment.index}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const result = await provider.generateTalkingHead({
    providerAvatarId: speaker.providerAvatarId,
    providerVoiceId: speaker.providerVoiceId,
    scriptText: segment.text,
  });
  return { ...base, videoStorageKey: result.videoAssetId, durationSec: result.durationSeconds, fellBackToVideo: true };
}

function buildOutput(
  projectId: string | null,
  ownerId: string,
  storageKey: string,
  durationSeconds: number,
  kind: VideoOutput["kind"],
): VideoOutput {
  return {
    id: createId("output"),
    ownerId,
    renderProjectId: projectId,
    storageKey,
    coverStorageKey: undefined,
    aspectRatio: "9:16",
    durationSeconds,
    kind,
    status: "ready",
    createdAt: nowIso()
  };
}

async function persistOutput(deps: TalkingHeadDeps, output: VideoOutput): Promise<void> {
  // Persist 供 video_render 经 findTalkingHeadOutputByProject 获取；RenderProject
  // 状态由 finalizeProjectStatus() 统一收敛，避免并发竞争。
  try {
    await deps.renderRepository.createOutput(output);
  } catch (err) {
    console.error(
      `[talking_head] Failed to persist VideoOutput: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
```

> 注意：`lib/services/avatar-provider.ts` 需要 re-export voice-track 的类型吗？不需要——voice-track import avatar-provider 的 WordTimestamp，processor import 两者，无环。

- [ ] **Step 5: 跑测试确认通过 + 回归**

Run: `npx vitest run tests/voice-track.test.ts tests/talking-head-processor.test.ts` → PASS；`npm test` 全绿。

- [ ] **Step 6: Commit**

```bash
git add lib/services/voice-track.ts lib/types.ts lib/repositories/ worker/processors/talking-head.ts tests/
git commit -m "feat(worker): segmented voice-track synthesis (on-camera video + cloned-voice TTS with fallback)"
```

---

### Task 11: 混排时间线 + 多 presenter 输入 filter graph + video_render 接入

**Files:**
- Create: `lib/services/segmented-compose.ts`
- Modify: `worker/processors/video-render.ts`（manifest 分支 + loadVoiceTrack 依赖注入）
- Test: `tests/segmented-compose.test.ts`（新建）、`tests/video-render-processor-captions.test.ts`（追加分段用例）

**设计：** `video_render` 检测 talking_head 产物 kind： `"segmented_voice"` → 加载 manifest 走分段混排；否则保持 Phase 1/2 行为。时间线：onCamera 段放对应形象的 talking-head 画面（每段一个独立 mp4 输入）；画外音段时长内顺序铺 b-roll（素材循环复用规则同 Phase 1）；音频 = 逐段（视频原声 | TTS 音频）concat 成连续音轨 + BGM duck。字幕：每段一条 cue，边界 = 段真实时长（TTS 段时长即词级时间轴总长，天然精准）；onCamera 段无词级数据，段内整句一条 cue。

- [ ] **Step 1: 写失败测试**

新建 `tests/segmented-compose.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import {
  buildSegmentedCaptionCues,
  buildSegmentedFilterGraph,
  buildSegmentedTimeline,
} from "@/lib/services/segmented-compose";
import type { VoiceTrackManifest } from "@/lib/services/voice-track";
import type { Asset } from "@/lib/types";

const videoAsset = (id: string, dur = 6): Asset => ({
  id, ownerId: "o", storeId: "s", type: "video", originalFilename: `${id}.mp4`,
  storageKey: `k/${id}`, mimeType: "video/mp4", sizeBytes: 1,
  tags: [], businessTags: [], status: "ready", category: "material",
  createdAt: new Date().toISOString(), durationSeconds: dur,
});

const manifest: VoiceTrackManifest = {
  version: 1,
  totalDurationSec: 20,
  segments: [
    { index: 0, speakerIndex: 0, onCamera: true, text: "开场白。", videoStorageKey: "avatars/s0.mp4", durationSec: 4 },
    { index: 1, speakerIndex: 0, onCamera: false, text: "介绍产品。", audioStorageKey: "voices/s1.mp3", durationSec: 10,
      words: [{ word: "介绍", startSec: 0, endSec: 1 }, { word: "产品", startSec: 1, endSec: 2 }] },
    { index: 2, speakerIndex: 0, onCamera: true, text: "快来店里。", videoStorageKey: "avatars/s2.mp4", durationSec: 6 },
  ],
};

describe("buildSegmentedTimeline", () => {
  it("onCamera segments keep exact voice durations; broll fills off-camera windows", () => {
    const { segments, totalDurationSec } = buildSegmentedTimeline({
      manifest,
      assets: [videoAsset("a", 6), videoAsset("b", 6)],
      selectedAssetIds: ["a", "b"],
    });
    // 段序：presenter(4s) → broll×? 铺满 10s → presenter(6s)
    expect(segments[0]).toMatchObject({ role: "presenter", durationSec: 4, manifestIndex: 0 });
    const brollWindow = segments.filter((s) => s.role === "broll");
    expect(brollWindow.reduce((acc, s) => acc + s.durationSec, 0)).toBeCloseTo(10, 5);
    expect(segments.at(-1)).toMatchObject({ role: "presenter", durationSec: 6, manifestIndex: 2 });
    expect(totalDurationSec).toBeCloseTo(20, 5);
    // 相邻段首尾相接
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i]!.startSec).toBeCloseTo(segments[i - 1]!.endSec, 5);
    }
  });

  it("broll pool cycles within a long off-camera window and reuses assets", () => {
    const { segments } = buildSegmentedTimeline({
      manifest: { ...manifest, segments: [manifest.segments[1]!], totalDurationSec: 10 },
      assets: [videoAsset("a", 3)],
      selectedAssetIds: ["a"],
    });
    // 3+3+3+1：单素材循环复用，最后一段截断到窗口余量
    const durations = segments.map((s) => s.durationSec);
    expect(durations.reduce((a, b) => a + b, 0)).toBeCloseTo(10, 5);
    expect(segments.length).toBe(4);
    expect(segments.every((s) => s.assetId === "a")).toBe(true);
  });

  it("target beyond voice length appends a broll tail (Phase 1 fill semantics)", () => {
    const { segments, totalDurationSec } = buildSegmentedTimeline({
      manifest: { ...manifest, segments: [manifest.segments[0]!], totalDurationSec: 4 },
      assets: [videoAsset("a", 6)],
      selectedAssetIds: ["a"],
      targetDurationSec: 10,
    });
    expect(totalDurationSec).toBeCloseTo(10, 5);
    expect(segments.at(-1)!.role).toBe("broll");
  });

  it("empty asset pool → black broll beats (never crash)", () => {
    const { segments } = buildSegmentedTimeline({ manifest, assets: [], selectedAssetIds: [] });
    const broll = segments.filter((s) => s.role === "broll");
    expect(broll.length).toBeGreaterThan(0);
    expect(broll.every((s) => s.assetId === null)).toBe(true);
  });
});

describe("buildSegmentedCaptionCues", () => {
  it("emits one cue per manifest segment with exact accumulated boundaries", () => {
    const cues = buildSegmentedCaptionCues(manifest);
    expect(cues).toEqual([
      { startSec: 0, endSec: 4, text: "开场白。" },
      { startSec: 4, endSec: 14, text: "介绍产品。" },
      { startSec: 14, endSec: 20, text: "快来店里。" },
    ]);
  });
});

describe("buildSegmentedFilterGraph", () => {
  it("trims each presenter segment from its own video input and concats per-segment audio", () => {
    const { segments, totalDurationSec } = buildSegmentedTimeline({
      manifest, assets: [videoAsset("a", 6)], selectedAssetIds: ["a"],
    });
    const graph = buildSegmentedFilterGraph({
      segments,
      manifest,
      segmentVideoInputIndex: { 0: 0, 2: 1 },
      segmentAudioInputIndex: { 1: 2 },
      assetInputIndex: { a: 3 },
      assPath: "/tmp/subs.ass",
      width: 1080,
      height: 1920,
      totalDurationSec,
    });
    // 两个 presenter 段分别从 input 0 / 1 trim
    expect(graph.filterComplex).toContain("[0:v]trim=start=0:duration=4");
    expect(graph.filterComplex).toContain("[1:v]trim=start=0:duration=6");
    // 音频：段0 取视频原声、段1 取 TTS 输入、段2 取视频原声 → 三段 concat
    expect(graph.filterComplex).toContain("[0:a]atrim=duration=4");
    expect(graph.filterComplex).toContain("[2:a]atrim=duration=10");
    expect(graph.filterComplex).toContain("[1:a]atrim=duration=6");
    expect(graph.filterComplex).toMatch(/concat=n=3:v=0:a=1\[avoicecat\]/);
    // 字幕烧录 + 映射
    expect(graph.filterComplex).toContain("subtitles=");
    expect(graph.mapVideo).toBe("[vsub]");
  });

  it("TTS-fallback segments take audio from their fallback video input", () => {
    const fbManifest: VoiceTrackManifest = {
      version: 1, totalDurationSec: 5,
      segments: [{ index: 0, speakerIndex: 0, onCamera: false, text: "降级段。", videoStorageKey: "avatars/fb.mp4", durationSec: 5, fellBackToVideo: true }],
    };
    const { segments, totalDurationSec } = buildSegmentedTimeline({
      manifest: fbManifest, assets: [videoAsset("a")], selectedAssetIds: ["a"],
    });
    const graph = buildSegmentedFilterGraph({
      segments, manifest: fbManifest,
      segmentVideoInputIndex: { 0: 0 },
      segmentAudioInputIndex: {},
      assetInputIndex: { a: 1 },
      assPath: "/tmp/s.ass", width: 1080, height: 1920, totalDurationSec,
    });
    expect(graph.filterComplex).toContain("[0:a]atrim=duration=5");
    // 降级段画面仍是 b-roll（onCamera=false），不从 fallback 视频取画面
    const videoPart = graph.filterComplex.split(";").filter((p) => p.includes(":v]trim"));
    expect(videoPart.every((p) => !p.startsWith("[0:v]trim=start=0:duration=5"))).toBe(true);
  });
});
```

`tests/video-render-processor-captions.test.ts` 追加：

```ts
  it("segmented_voice output drives the manifest path (caption per segment, mixed timeline)", async () => {
    // seed: project + draft(segments 2 句) + VideoOutput kind="segmented_voice"
    //   storageKey="voice-tracks/p/manifest.json"
    // deps.loadVoiceTrack stub 返回两段 manifest（1 出镜 1 画外音）
    // deps.renderComposite 捕获入参：
    //   - input.voiceTrack === manifest
    //   - assContent 含两条 Dialogue、边界 = 段真实时长
    //   - segments 混排（presenter + broll）
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/segmented-compose.test.ts tests/video-render-processor-captions.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 segmented-compose**

新建 `lib/services/segmented-compose.ts`：

```ts
import type { Asset, SceneRole } from "@/lib/types";
import type { VoiceTrackManifest } from "@/lib/services/voice-track";
import type { CaptionCue, FilterGraphResult, TimelineSegment } from "@/lib/services/video-compose";

/** 分段混排时间线段：manifestIndex 指向 manifest.segments 的音轨来源段。 */
export interface SegmentedTimelineSegment extends TimelineSegment {
  manifestIndex: number;
}

export interface BuildSegmentedTimelineArgs {
  manifest: VoiceTrackManifest;
  assets: Asset[];
  selectedAssetIds: string[];
  /** assetId → ffprobe 实际秒数（视频）；图片用 imageDefaultSec。 */
  assetDurations?: Record<string, number>;
  /** 目标成片时长：voice 不足时尾部 b-roll 铺满（Phase 1 语义）；voice 超长不截断。 */
  targetDurationSec?: number;
  imageDefaultSec?: number;
  maxClipSec?: number;
}

/**
 * Phase 3 混排时间线（spec §6.4）：
 * - onCamera 段 = presenter 段，时长 = 该段数字人视频真实时长；
 * - 画外音段窗口内顺序铺 b-roll（素材池循环复用，末段截断到窗口余量）；
 * - 素材池为空时黑场兜底；voice 总长短于 targetDurationSec 时尾部 b-roll 铺满。
 * Σ durationSec === totalDurationSec（与 buildTimeline 同契约）。
 */
export function buildSegmentedTimeline(args: BuildSegmentedTimelineArgs): {
  segments: SegmentedTimelineSegment[];
  totalDurationSec: number;
} {
  const imageDefaultSec = args.imageDefaultSec ?? 3;
  const maxClipSec = args.maxClipSec ?? 12;
  const assetDurations = args.assetDurations ?? {};

  // 有序去重素材池（勾选顺序；category 守卫在 processor 层已做）。
  const seen = new Set<string>();
  const pool: Asset[] = [];
  for (const id of args.selectedAssetIds) {
    if (seen.has(id)) continue;
    const asset = args.assets.find((a) => a.id === id);
    if (asset) { seen.add(id); pool.push(asset); }
  }
  const naturalFor = (a: Asset): number =>
    a.type === "video"
      ? Math.min(Math.max(assetDurations[a.id] ?? imageDefaultSec, 0.5), maxClipSec)
      : imageDefaultSec;

  const beats: { role: SceneRole; manifestIndex: number; assetId: string | null; duration: number }[] = [];
  let poolCursor = 0;

  /** 在 duration 窗口内铺 b-roll；窗口必须被恰好填满（末段截断）。 */
  const fillBrollWindow = (windowSec: number, manifestIndex: number): void => {
    let remaining = windowSec;
    let guard = 0;
    while (remaining > 0.001 && guard < 1000) {
      guard++;
      const asset = pool[poolCursor % pool.length];
      poolCursor++;
      const natural = asset ? naturalFor(asset) : remaining;
      const slice = Math.min(natural, remaining);
      beats.push({ role: "broll", manifestIndex, assetId: asset?.id ?? null, duration: slice });
      remaining -= slice;
      if (pool.length === 0) break; // 黑场一段即可铺满
    }
  };

  args.manifest.segments.forEach((seg, manifestIndex) => {
    if (seg.onCamera) {
      beats.push({ role: "presenter", manifestIndex, assetId: null, duration: seg.durationSec });
    } else {
      fillBrollWindow(seg.durationSec, manifestIndex);
    }
  });

  // voice 短于目标档位 → 尾部 b-roll 铺满（音轨在 filter graph 侧 apad）。
  let contentTotal = beats.reduce((acc, b) => acc + b.duration, 0);
  if (args.targetDurationSec !== undefined && args.targetDurationSec > contentTotal) {
    fillBrollWindow(args.targetDurationSec - contentTotal, args.manifest.segments.length - 1);
    contentTotal = args.targetDurationSec;
  }

  let cursor = 0;
  const segments: SegmentedTimelineSegment[] = beats.map((b, i) => {
    const start = cursor;
    cursor += b.duration;
    return {
      role: b.role,
      startSec: start,
      endSec: cursor,
      durationSec: b.duration,
      sceneOrder: i + 1,
      text: "",
      assetId: b.assetId,
      manifestIndex: b.manifestIndex,
    };
  });
  return { segments, totalDurationSec: cursor };
}

/**
 * 分段字幕：每段一条 cue，边界 = 段真实时长累计（TTS 段时长来自词级时间轴，
 * 天然与配音对齐；onCamera 段整句一条）。标黄仍由 buildAss 的 highlights 包裹。
 */
export function buildSegmentedCaptionCues(manifest: VoiceTrackManifest): CaptionCue[] {
  let cursor = 0;
  return manifest.segments.map((seg) => {
    const cue = { startSec: cursor, endSec: cursor + seg.durationSec, text: seg.text };
    cursor += seg.durationSec;
    return cue;
  });
}

export interface BuildSegmentedFilterGraphArgs {
  segments: SegmentedTimelineSegment[];
  manifest: VoiceTrackManifest;
  /** manifest index → 该段数字人视频（onCamera 或 TTS 降级）的 ffmpeg 输入下标。 */
  segmentVideoInputIndex: Record<number, number>;
  /** manifest index → 该段 TTS 音频的 ffmpeg 输入下标。 */
  segmentAudioInputIndex: Record<number, number>;
  assetInputIndex: Record<string, number>;
  bgmInputIndex?: number;
  assPath: string;
  width: number;
  height: number;
  totalDurationSec: number;
}

/**
 * 分段 filter graph：画面按时间线（presenter 段从对应形象视频 trim；b-roll 段
 * 从素材 trim/黑场）；音频按 manifest 段序 concat（onCamera/降级段取视频原声，
 * 画外音段取 TTS 音频），apad 到总时长后与 BGM duck 混音。
 */
export function buildSegmentedFilterGraph(args: BuildSegmentedFilterGraphArgs): FilterGraphResult {
  const { width, height, assPath, totalDurationSec } = args;
  const parts: string[] = [];
  const videoLabels: string[] = [];

  const scaledChain = (inPrefix: string, outLabel: string): string =>
    `${inPrefix}scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30${outLabel}`;

  args.segments.forEach((seg, i) => {
    const outLabel = `[v${i}]`;
    if (seg.role === "presenter") {
      const videoIdx = args.segmentVideoInputIndex[seg.manifestIndex];
      if (videoIdx === undefined) {
        // 数据损坏兜底：黑场而不是崩图
        parts.push(`color=c=black:s=${width}x${height}:d=${seg.durationSec},fps=30${outLabel}`);
      } else {
        parts.push(
          scaledChain(
            `[${videoIdx}:v]trim=start=0:duration=${seg.durationSec},setpts=PTS-STARTPTS,`,
            outLabel,
          ),
        );
      }
    } else {
      const idx = seg.assetId != null ? args.assetInputIndex[seg.assetId] : undefined;
      if (idx === undefined) {
        parts.push(`color=c=black:s=${width}x${height}:d=${seg.durationSec},fps=30${outLabel}`);
      } else {
        parts.push(scaledChain(`[${idx}:v]trim=duration=${seg.durationSec},setpts=PTS-STARTPTS,`, outLabel));
      }
    }
    videoLabels.push(outLabel);
  });

  parts.push(`${videoLabels.join("")}concat=n=${videoLabels.length}:v=1:a=0[vcat]`);
  parts.push(`[vcat]subtitles='${escapeFilterPath(assPath)}'[vsub]`);

  // 音轨：按 manifest 段序 concat。onCamera 与 TTS 降级段取视频原声；画外音段取 TTS。
  const audioLabels: string[] = [];
  args.manifest.segments.forEach((seg, manifestIndex) => {
    const label = `[a${manifestIndex}]`;
    const videoIdx = args.segmentVideoInputIndex[manifestIndex];
    const audioIdx = args.segmentAudioInputIndex[manifestIndex];
    if (seg.onCamera || seg.fellBackToVideo) {
      if (videoIdx !== undefined) {
        parts.push(`[${videoIdx}:a]atrim=duration=${seg.durationSec},asetpts=PTS-STARTPTS${label}`);
        audioLabels.push(label);
      }
    } else if (audioIdx !== undefined) {
      parts.push(`[${audioIdx}:a]atrim=duration=${seg.durationSec},asetpts=PTS-STARTPTS${label}`);
      audioLabels.push(label);
    }
  });
  if (audioLabels.length === 0) {
    parts.push(`anullsrc=channel_layout=stereo:sample_rate=44100,atrim=duration=${totalDurationSec}[avoice0]`);
  } else {
    parts.push(`${audioLabels.join("")}concat=n=${audioLabels.length}:v=0:a=1[avoicecat]`);
    parts.push(`[avoicecat]apad,atrim=duration=${totalDurationSec},aresample=async=1[avoice0]`);
  }

  if (args.bgmInputIndex !== undefined) {
    parts.push(`[${args.bgmInputIndex}:a]volume=-20dB,atrim=duration=${totalDurationSec}[abgm]`);
    parts.push(`[avoice0][abgm]amix=inputs=2:duration=first:dropout_transition=0[aout]`);
    return { filterComplex: parts.join(";"), mapVideo: "[vsub]", mapAudio: "[aout]" };
  }
  return { filterComplex: parts.join(";"), mapVideo: "[vsub]", mapAudio: "[avoice0]" };
}

// 与 video-compose.ts 同一实现（小函数不复用导入，避免循环依赖）。
function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}
```

> `escapeFilterPath` 在 video-compose.ts 是私有函数——把它从 video-compose.ts export 出来，segmented-compose import，避免复制（DRY）。

- [ ] **Step 4: video_render 接入 manifest 分支**

`worker/processors/video-render.ts`：

1) deps 加：

```ts
export interface VideoRenderDeps {
  // …既有…
  /** 加载 voice-track manifest（kind="segmented_voice" 时）；测试注入。 */
  loadVoiceTrack: (storageKey: string) => Promise<VoiceTrackManifest>;
}

const defaultLoadVoiceTrack = async (storageKey: string): Promise<VoiceTrackManifest> => {
  const bytes = await getObjectToBuffer(storageKey);
  return JSON.parse(new TextDecoder().decode(bytes)) as VoiceTrackManifest;
};
```

`videoRenderProcessor` 的 deps 字面量加 `loadVoiceTrack: defaultLoadVoiceTrack`。

2) `processVideoRender` 在拿到 `talkingHead` 后插入分支：

```ts
  const voiceTrack =
    talkingHead?.kind === "segmented_voice"
      ? await deps.loadVoiceTrack(talkingHead.storageKey)
      : null;
```

3) 时间线与字幕分支（替换 buildTimeline 调用段）：

```ts
  let segments: TimelineSegment[];
  let totalDurationSec: number;
  if (voiceTrack) {
    const built = buildSegmentedTimeline({
      manifest: voiceTrack,
      assets,
      selectedAssetIds: project.selectedAssetIds,
      assetDurations,
      targetDurationSec: project.targetDurationSec,
    });
    segments = built.segments;
    totalDurationSec = built.totalDurationSec;
  } else {
    const built = buildTimeline({
      scenes: draft.scenes,
      assets,
      selectedAssetIds: project.selectedAssetIds,
      assetDurations,
      talkingHeadDurationSec: talkingHead?.durationSeconds,
      targetDurationSec: project.targetDurationSec
    });
    segments = built.segments;
    totalDurationSec = built.totalDurationSec;
  }
```

4) 字幕分支：

```ts
  const captionCues = voiceTrack
    ? buildSegmentedCaptionCues(voiceTrack)
    : mode === "presenter_broll"
      ? buildCaptionCues(draft.voiceover, totalDurationSec)
      : [];
```

（`mode` 保持 `resolveCompositionMode(talkingHead)`——segmented_voice 输出非 null 即 presenter_broll。）

5) `RenderCompositeInput` 加 `voiceTrack?: VoiceTrackManifest | null;`，renderComposite 调用处传 `voiceTrack`。

6) `defaultRenderComposite` 加分段输入下载与图构建分支：

```ts
    const inputs: FfmpegInput[] = [];
    const assetInputIndex: Record<string, number> = {};
    let talkingHeadInputIndex: number | undefined;
    const segmentVideoInputIndex: Record<number, number> = {};
    const segmentAudioInputIndex: Record<number, number> = {};
    let nextIdx = 0;

    if (input.voiceTrack) {
      // 分段产物下载：onCamera/降级段是 mp4；画外音段是 TTS mp3。
      for (let m = 0; m < input.voiceTrack.segments.length; m++) {
        const seg = input.voiceTrack.segments[m]!;
        if (seg.videoStorageKey) {
          const p = join(dir, `seg-${m}.mp4`);
          await downloadToFile(seg.videoStorageKey, p);
          segmentVideoInputIndex[m] = nextIdx++;
          inputs.push({ path: p, isImage: false });
        } else if (seg.audioStorageKey) {
          const p = join(dir, `seg-${m}.mp3`);
          await downloadToFile(seg.audioStorageKey, p);
          segmentAudioInputIndex[m] = nextIdx++;
          inputs.push({ path: p, isImage: false });
        }
      }
    } else if (input.mode === "presenter_broll" && input.talkingHead) {
      const thPath = join(dir, "th.mp4");
      await downloadToFile(input.talkingHead.storageKey, thPath);
      talkingHeadInputIndex = 0;
      inputs.push({ path: thPath, isImage: false });
      nextIdx = 1;
    }

    // 素材下载循环（原逻辑，nextIdx 起始值改为当前值，进度公式不变）
    // …for (const seg of input.segments) { … assetInputIndex[asset.id] = nextIdx++; }

    const filter = input.voiceTrack
      ? buildSegmentedFilterGraph({
          segments: input.segments as SegmentedTimelineSegment[],
          manifest: input.voiceTrack,
          segmentVideoInputIndex,
          segmentAudioInputIndex,
          assetInputIndex,
          bgmInputIndex,
          assPath,
          width,
          height,
          totalDurationSec: input.totalDurationSec,
        })
      : buildFilterGraph({ /* 既有入参不变 */ });
```

（BGM 下载段不变，紧跟素材下载之后。）

- [ ] **Step 5: 跑测试确认通过 + 回归**

Run: `npx vitest run tests/segmented-compose.test.ts tests/video-render-processor-captions.test.ts tests/video-render-composite.test.ts tests/video-compose.test.ts` → PASS；`npm test` 全绿。

- [ ] **Step 6: Commit**

```bash
git add lib/services/segmented-compose.ts lib/services/video-compose.ts worker/processors/video-render.ts tests/
git commit -m "feat(render): mixed timeline with per-segment presenter inputs, voice concat and precise caption cues"
```

---

### Task 12: 全量回归 + 冒烟 checklist + 文档收尾

**Files:**
- Modify: `docs/superpowers/specs/2026-08-16-voiceover-centric-pipeline-design.md`（头部状态行）

- [ ] **Step 1: 全量验证**

Run（逐条确认输出）:
```bash
npm test                 # 全绿
npm run typecheck        # 0 error
npm run lint             # 0 error
npx prisma validate      # schema valid
npm run build            # 构建通过
```

- [ ] **Step 2: 本地 demo 模式冒烟（无 HeyGen key 走 mock provider）**

```bash
# APP_MODE=demo + REDIS + 本地 postgres 起 app + worker
# 1. 上传一段视频为 avatar_footage → 创建分身（mock 立即 ready）→ 状态轮询收敛
# 2. 生成脚本（2 个 mock 形象）→ 确认卡片勾选 2 个 → 确认生成
# 3. worker 跑完 → 产物页播放：出镜段/画外音段混排、字幕逐句对齐、标黄生效
```

- [ ] **Step 3: Task 0 真 key 冒烟复核**

确认 Task 0 的四个 curl 结果与 Task 3 实现一致（consent 字段名 / avatar_groups 路径 / timestamps 单位）；不一致处改 heygen.ts 常量与对应测试。

- [ ] **Step 4: spec 状态更新**

`docs/superpowers/specs/2026-08-16-voiceover-centric-pipeline-design.md` 头部状态行改为：

```markdown
状态：已确认（三期设计均已获用户批准）。Phase 1 已上线（2026-08-17）；Phase 2 已实施（2026-08-20）；Phase 3 已实施（2026-08-25）。
```

- [ ] **Step 5: Commit + push（触发 Zeabur 自动部署 + migrate deploy）**

```bash
git add docs/superpowers/specs/2026-08-16-voiceover-centric-pipeline-design.md
git commit -m "docs(spec): mark Phase 3 implemented"
git push
```

部署后人工验证（生产）：创建一个真分身走完 webcam 授权 → 生成一条 45s 双形象视频 → 核对成片（分段画面、克隆声音画外音、字幕对齐与标黄）。

---

## 冒烟验证记录

> Task 0 执行后在此填写：digital_twin 创建（可用/付费墙）、consent 响应字段名、avatar_groups 端点与状态枚举、word_timestamps 单位与中文粒度。

**2026-08-25 真 key 冒烟（代理 127.0.0.1:7892，key 有效 /v2/avatars 200）：**

1. **digital_twin 创建（Step 1）— 契约已探明，配额阻塞：**
   - 正确形状：`POST /v3/avatars` JSON `{"type":"digital_twin","name":...,"file":{"type":"url","url":...}}`（**不是**计划假设的 `video_url` 平铺字段；multipart 也拒绝，只要 JSON）。
   - URL 必须 serve `Content-Type: video/mp4`（octet-stream 报 `Content type not match binary/octet-stream != video/mp4`）。
   - 错误 envelope：`{"error":{"code","message","param?"}}`。
   - **配额红线**：`resource_limit_reached: You've reached the limit of 1 verified avatar group slots`——当前订阅仅 1 个 verified avatar group（已被既有形象占用）。API 本身对订阅开放（非付费墙），但多形象真 key E2E 需用户决策（升级 / 释放槽位）。
2. **consent（Step 2）— 路径存在，快乐路径未验证：** `POST /v3/avatars/{group_id}/consent` 路由存在（传 avatar_id 返回 JSON `avatar_not_found: "Avatar group ... not found"`，证实 path param 是 group_id）。响应字段名（url / consent_url）未能验证（无可用 group）。
3. **状态轮询（Step 3）— 路径修正：** 真实端点是 **`GET /v3/avatars/{group_id}`**（同样 JSON avatar_not_found）；计划假设的 `/v3/avatar_groups/{id}` 是不存在的路由（HTML 404）。`/v2/video_avatar/{id}` 是 legacy 且 forbidden（2026-10-31 下线），不可用。
4. **克隆声音 TTS（Step 4）— 全量验证通过：** `POST /v3/voices/speech` `{voice_id, text}` → `{"data":{"audio_url","duration","word_timestamps":[{word,start,end}]}}`。
   - **单位是秒**（float，如 3.813877551020408），不是毫秒；
   - **中文粒度按字**（每字一条）；
   - **含 `<start>`/`<end>` 哨兵词**（零时长，须过滤）；
   - **audio_url 是 `.wav`**（resource2.heygen.ai/text_to_speech/...），不是 mp3 → storageKey 扩展名与 contentType 需改 `audio/wav`；
   - Git Bash curl 中文 `-d` 会 mangling，须 `--data-binary @file` + UTF-8（生产 Node fetch 无此问题）。
