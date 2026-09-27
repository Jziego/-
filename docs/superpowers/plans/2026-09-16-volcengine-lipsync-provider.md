# 火山引擎 MediaKit 对口型（VolcEngine Lip-Sync）正式接入实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `volcengine-lipsync` 数字人供应商——用户上传本人实拍口播视频（无需训练/授权流程），渲染时按文案生成配音并改口型，产出"真人出镜"成片。

**Architecture:** 新建 `VolcEngineLipSyncProvider` 实现现有 `AvatarProvider` 接口（`lib/services/avatar-provider.ts`），内部串联两个火山引擎服务：豆包语音合成大模型 2.0（V3 HTTP 单向流式，`enable_subtitle=true` 拿字级时间戳）→ MediaKit 视频口型对齐（`POST /api/v1/tools/lip-sync`，轮询任务，产物下载转存 R2）。渲染管线复用 Phase 3 分段合成 + voice-track manifest + ffmpeg 混排，零改动；talking_head 处理器改为**按 AvatarProfile.provider 逐形象解析 provider**（HeyGen 老形象与对口型新形象可混排）。新建形象零等待：无外部授权流，`createDigitalTwin` 不调远端，首轮状态轮询（~10s）即就绪。

**Tech Stack:** Next.js 16 API routes、BullMQ worker、Prisma（provider/category 均为 String 列，**无需迁移**）、火山 MediaKit REST、豆包 TTS V3 HTTP Chunked、Vitest（TDD）、ffmpeg/ffprobe（worker 已有）。

---

## 背景与已核实的外部契约（执行者必读）

### 探针实测结论（2026-09-16，已花 ~¥1 验证）

- `scripts/probe-lipsync.mjs`：MediaKit 对口型全链路一次跑通（本地上传→提交→轮询→下载）。RTF≈7（31.7s 音频处理 3-4 分钟）、并发≥2、720×1280 9:16 保持、HEVC 输入自动转 H.264、无可见水印、抽帧确认嘴型真被新配音重塑。
- `scripts/probe-doubao-tts.mjs`：豆包 TTS 探针（**本计划 Task 0 要用真 Key 跑通**）。已实测：MediaKit 的 Key 调语音服务返回 401——**语音服务需要单独开通+单独的 API Key**。

### MediaKit 对口型 API（文档 6448/2658349、6448/2278532，探针实证）

- Base: `https://mediakit.cn-beijing.volces.com`
- 鉴权: `Authorization: Bearer ${MEDIKIT_API_KEY}`
- 提交: `POST /api/v1/tools/lip-sync`，Body `{"video_url": "...", "audio_url": "...", "enable_video_loop": true}` → 响应顶层 `task_id`；失败时 `success=false` + `error{code,message,param,type}`
- 查询: `GET /api/v1/tasks/{task_id}` → `{status: "running"|"completed"|"failed", error?: {...}, result?: {video_url, duration}, expires_at}`
- `enable_video_loop=true`：音频长于视频时画面镜像循环（正→反→正），**输出时长恒等于音频时长**；`false` 取短者截断。本计划恒用 `true`
- `result.video_url` 24h 有效，**必须立即下载转存 R2**
- 输入约束：视频 mp4 ≤30min、单人真人、水平 ±45°/俯仰 ±15°、非 HDR；音频 mp3/aac/wav/m4a/flac
- 计费：¥1/分钟按输出时长

### 豆包 TTS V3 HTTP Chunked 单向流式（文档 6561/1598757，原文核实）

- URL: `POST https://openspeech.bytedance.com/api/v3/tts/unidirectional`
- Headers: `X-Api-Key: <语音控制台 API Key>`、`X-Api-Resource-Id: seed-tts-2.0`（TTS 2.0 音色）/ `seed-icl-2.0`（复刻音色）、可选 `X-Api-Request-Id: <uuid>`
- Body: `{"user":{"uid":"..."},"namespace":"BidirectionalTTS","req_params":{"text":"...","speaker":"zh_female_vv_uranus_bigtts","audio_params":{"format":"mp3","sample_rate":24000,"enable_subtitle":true}}}`
- **音色代际必须匹配 resourceId（2026-09-16 真 Key 实测）**：`_moon_bigtts` 后缀=语音合成 1.0 音色（配 `seed-tts-1.0`，需开通 1.0 字符版）；`_uranus_bigtts` 后缀=2.0 音色（配 `seed-tts-2.0`）。代际错配报 `55000000 resource ID is mismatched with speaker related resource`；只开通 2.0 的账号调 1.0 报 `45000030 not granted`（403）。本计划默认音色 `zh_female_vv_uranus_bigtts`（2.0 女声，已实测通过）
- 响应为**逐行 JSON 帧**（chunked）：
  - 音频帧 `{"code":0,"message":"","data":"<base64 音频分片>"}`（拼接全部 data 即完整 mp3）
  - 字幕帧 `{"code":0,"data":null,"sentence":{"text":"原文","words":[{"word":"其","startTime":0.205,"endTime":0.315,"confidence":0.85},...]}}` —— **字粒度、单位秒、基于原文**（TTS2.0 特性；多次返回 TTSSubtitle）
  - 结束帧 `{"code":20000000,"message":"ok","data":null,"usage":{"text_words":10}}`
  - 错误帧 `code` 非 0 且非 20000000，带 `message`
- **V1 接口（/api/v1/tts）已被官方标"不推荐"且不支持 TTS 2.0 音色，不要用**
- 文本长度：V1 限制 1024 字节；分段后单句远低于此，代码里留 3000B 防御上限

### 关键设计取舍

| 决策 | 选择 | 理由 |
|---|---|---|
| 新形象创建路径 | 全部由 env 指定的"创建 provider"承担；生产配 `volcengine-lipsync` | HeyGen 槽位制是扩张瓶颈，对口型无训练无槽位 |
| 老 HeyGen 形象 | 保留可渲染（按 profile.provider 解析 provider） | 用户资产不废弃 |
| 素材传递给 MediaKit | R2 presigned GET URL（2h 过期），不用 mediakit:// file_id | file_id 30 天过期要维护重传状态机；presign 无状态。worker 本就从 R2 读写 |
| 素材 category | 新增 `lipsync_footage`（独立闸门 10s–3min/≤200MB）；旧 `avatar_footage`（30s–5min/≤30MB）保留且可被对口型复用 | 闸门随 category 走，上传链路无需知道当前 provider 配置 |
| 时长权威数据源 | TTS 音频用 ffprobe 实测；成片段用 MediaKit `result.duration` | 分段时间线/字幕全靠 durationSec 精确，估定会音画漂移 |
| 声音复刻 onboarding | **不在本计划**（providerVoiceId 字段已就位，复刻音色训好后写 profile 即可） | 独立子系统（音色训练 HTTP 6561/2534906 + 授权协议），后续单独计划 |
| 失败重试 | 依赖 BullMQ 现有 attempts=3 指数退避，不做 NonRetryable 分流 | 与 HeyGen 路径现状一致；MediaKit 失败是否计费列为生产观察项 |

---

## Task 0: 前置开通与 TTS 冒烟（用户动作 + 探针验证）

**Files:**
- 已有: `scripts/probe-doubao-tts.mjs`（本会话已写好）、`scripts/probe-lipsync.mjs`

**目的：** 拿到豆包语音合成的 API Key 并实证字级时间戳链路。这是后续所有任务的硬前置（Task 4/5 的单测不依赖真 Key，但 Task 13 生产冒烟依赖）。

- [ ] **Step 1: 用户开通豆包语音合成服务（5 分钟人工操作）**

1. 打开火山引擎语音技术控制台：https://console.volcengine.com/speech/service
2. 开通「豆包语音合成大模型」服务（选 **语音合成2.0字符版**，按量后付费即可，无需资源包）
3. 进入「API Key 管理」（文档 6561/1816214）创建一个 API Key
4. 把 Key 写入本地 `C:\Users\Administrator\Desktop\API-TTS.txt`（单行，**不要**写进 API.txt，那个是 MediaKit 的）

> 注意：语音合成 2.0 按字符计费（量级：几百字 ≈ 几分钱），冒烟测试成本可忽略。

- [ ] **Step 2: 跑 TTS 探针验证**

```bash
MEDIKIT_KEY_FILE="C:/Users/Administrator/Desktop/API-TTS.txt" node scripts/probe-doubao-tts.mjs
```

预期输出（每行都要出现）：
- `HTTP 200`
- `结束帧：usage=...`
- `字级时间轴（秒）：首词 ...`
- `✓ 全链路通过`

若 401/403：Key 不对或服务未开通，回到 Step 1。若 `未收到任何字幕帧`：确认服务版本是 2.0（`X-Api-Resource-Id: seed-tts-2.0`）。

- [ ] **Step 3: 试听产物 + 提交两个探针脚本**

打开 `D:\下载\tts-probe.mp3` 试听确认是清晰的中文促销口播。然后：

```bash
git add scripts/probe-lipsync.mjs scripts/probe-doubao-tts.mjs
git commit -m "chore(scripts): 火山对口型与豆包TTS探针脚本（供应商实测工具，不含密钥）

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

（探针脚本只读密钥文件、绝不打印内容，安全入库。）

---

## Task 1: env 访问器 + 类型扩展

**Files:**
- Modify: `lib/env.ts`（文件尾部追加）
- Modify: `lib/types.ts:5,7`
- Test: `tests/providers-factory.test.ts`（新建，Task 6 续用）

- [ ] **Step 1: 写失败测试**

新建 `tests/providers-factory.test.ts`：

```ts
import { describe, expect, it, afterEach, vi } from "vitest";
import { hasLipSyncProvider } from "@/lib/env";

describe("lipsync env accessors", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("hasLipSyncProvider requires both MEDIKIT_API_KEY and DOUBAO_TTS_API_KEY", () => {
    vi.stubEnv("MEDIKIT_API_KEY", "mk_key");
    vi.stubEnv("DOUBAO_TTS_API_KEY", "tts_key");
    expect(hasLipSyncProvider()).toBe(true);

    vi.stubEnv("DOUBAO_TTS_API_KEY", "");
    expect(hasLipSyncProvider()).toBe(false);
  });

  it("hasLipSyncProvider is false when both unset", () => {
    vi.stubEnv("MEDIKIT_API_KEY", "");
    vi.stubEnv("DOUBAO_TTS_API_KEY", "");
    expect(hasLipSyncProvider()).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/providers-factory.test.ts`
Expected: FAIL — `hasLipSyncProvider is not a function` / 导出不存在

- [ ] **Step 3: 实现 env 访问器**

`lib/env.ts` 文件尾部（Sentry 段之后）追加：

```ts
// ── 火山引擎对口型（MediaKit + 豆包 TTS）────────────────────────────────────
// 对口型供应商双 Key：MediaKit 管视频改口型任务，豆包语音管配音合成。
// 2026-09-16 实测：两个产品线 Key 不通用（MediaKit Key 调语音服务 401）。

export function getMediakitApiKey(): string | undefined {
  return process.env.MEDIKIT_API_KEY?.trim() || undefined;
}

export function getMediakitBaseUrl(): string {
  return process.env.MEDIKIT_BASE_URL?.trim() || "https://mediakit.cn-beijing.volces.com";
}

export function getMediakitPollIntervalMs(): number {
  const raw = Number(process.env.MEDIKIT_POLL_INTERVAL_MS?.trim());
  return Number.isFinite(raw) && raw > 0 ? raw : 15_000;
}

export function getMediakitPollTimeoutMs(): number {
  const raw = Number(process.env.MEDIKIT_POLL_TIMEOUT_MS?.trim());
  return Number.isFinite(raw) && raw > 0 ? raw : 40 * 60_000;
}

export function getDoubaoTtsApiKey(): string | undefined {
  return process.env.DOUBAO_TTS_API_KEY?.trim() || undefined;
}

/** 豆包 TTS 2.0 音色（发音人 id）。后续声音复刻上线后按形象写 providerVoiceId 覆盖。 */
export function getDoubaoTtsVoice(): string {
  return process.env.DOUBAO_TTS_VOICE?.trim() || "zh_female_vv_uranus_bigtts";
}

/** 计费/模型资源位：seed-tts-2.0（标准音色）；声音复刻上线后改 seed-icl-2.0。 */
export function getDoubaoTtsResourceId(): string {
  return process.env.DOUBAO_TTS_RESOURCE_ID?.trim() || "seed-tts-2.0";
}

export function hasLipSyncProvider(): boolean {
  return Boolean(getMediakitApiKey() && getDoubaoTtsApiKey());
}
```

- [ ] **Step 4: 类型扩展**

`lib/types.ts:5` 改：

```ts
export type AssetCategory = "material" | "avatar_footage" | "lipsync_footage";
```

`lib/types.ts:7` 改：

```ts
export type AvatarProviderName = "heygen" | "volcengine-lipsync" | "d-id" | "tavus" | "synthesia" | "mock-avatar";
```

`lib/types.ts:76`（Asset.category 注释）改：

```ts
  /** material=素材库 b-roll；avatar_footage=HeyGen 分身训练人像视频；lipsync_footage=对口型出镜底板视频。两者都永不进渲染时间线。 */
  category: AssetCategory;
```

`lib/types.ts:103`（AvatarProfile.providerGroupId 注释）改：

```ts
  /** HeyGen avatar group id（digital_twin 创建时返回；授权/训练状态轮询的句柄）。对口型形象为 `lipsync:{footageStorageKey}`（本地句柄，无远端资源）。 */
  providerGroupId?: string;
```

- [ ] **Step 5: 跑测试 + typecheck**

Run: `npx vitest run tests/providers-factory.test.ts && npm run typecheck`
Expected: 2 passed；typecheck 无错

- [ ] **Step 6: Commit**

```bash
git add lib/env.ts lib/types.ts tests/providers-factory.test.ts
git commit -m "feat(avatar): 对口型供应商 env 访问器与类型扩展（volcengine-lipsync / lipsync_footage）

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 2: 对口型素材闸门（lib/avatar-footage.ts）

**Files:**
- Modify: `lib/avatar-footage.ts`
- Test: `tests/avatar-footage.test.ts`

**约束来源：** MediaKit 官方上限视频 ≤30min/≤5GB——远宽于 HeyGen。应用侧收紧到 10s–3min/≤200MB：对口型素材只是"人脸底板"（画面循环使用），3 分钟绰绰有余；200MB 与全局上传上限 `MAX_UPLOAD_BYTES` 对齐。时长下限 10s：太短镜像循环穿帮明显。

- [ ] **Step 1: 写失败测试（追加到 tests/avatar-footage.test.ts 尾部）**

先看一眼现有文件的 describe 结构，把下面用例加进合适的 describe（或新建 `describe("lipsync footage gates", ...)`）：

```ts
  it("validateLipSyncFootageSize rejects over 200MiB with a user-facing message", () => {
    expect(validateLipSyncFootageSize(201 * 1024 * 1024)).toMatch(/200MB/);
    expect(validateLipSyncFootageSize(200 * 1024 * 1024)).toBeNull();
  });

  it("validateLipSyncFootageDuration enforces 10s–3min and passes unreadable metadata through", () => {
    expect(validateLipSyncFootageDuration(0)).toBeNull(); // 读不出元数据放行，权威校验在 provider
    expect(validateLipSyncFootageDuration(5)).toMatch(/10 秒/);
    expect(validateLipSyncFootageDuration(10)).toBeNull();
    expect(validateLipSyncFootageDuration(180)).toBeNull();
    expect(validateLipSyncFootageDuration(181)).toMatch(/3 分钟/);
  });
```

import 行追加 `validateLipSyncFootageSize, validateLipSyncFootageDuration`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/avatar-footage.test.ts`
Expected: FAIL — 两个函数未导出

- [ ] **Step 3: 实现**

`lib/avatar-footage.ts` 尾部追加：

```ts
// ── 对口型出镜底板素材约束（火山 MediaKit，2026-09-16 探针实测后确立）──────────
//
// 与 HeyGen 训练素材的差异：对口型不做训练/克隆，素材是"人脸底板"——成片直接
// 复用原视频像素、只改嘴部。因此：
//  - 时长要求大幅降低（10s 即可，画面不够时 MediaKit 镜像循环）；
//  - 大小上限大幅放宽（MediaKit 支持 ≤5GB，应用侧取 200MB 与全局上传上限对齐）。
// 内容约束（单人真人、水平 ±45°/俯仰 ±15°、非 HDR）无法在入口机检，
// 由 MediaKit 任务失败时的错误信息透出，UI 引导重拍。

/** 对口型底板最短时长（秒）：太短镜像循环穿帮明显。 */
export const LIPSYNC_MIN_FOOTAGE_DURATION_SEC = 10;
/** 对口型底板最长时长（秒）：底板素材 3 分钟足够，更长只是浪费每次任务的拉取带宽。 */
export const LIPSYNC_MAX_FOOTAGE_DURATION_SEC = 3 * 60;
/** 对口型底板大小上限：200MiB（与全局 MAX_UPLOAD_BYTES 对齐）。 */
export const LIPSYNC_MAX_FOOTAGE_BYTES = 200 * 1024 * 1024;

/** 大小校验：超限返回用户可读的中文提示，否则 null。 */
export function validateLipSyncFootageSize(sizeBytes: number): string | null {
  if (sizeBytes > LIPSYNC_MAX_FOOTAGE_BYTES) {
    const mb = Math.round(sizeBytes / 1024 / 1024);
    return `视频文件过大（约 ${mb}MB）：出镜底板上限 200MB。请剪辑到 3 分钟以内，或在手机相机设置里把录像分辨率调低后重拍。`;
  }
  return null;
}

/**
 * 时长校验：超出 10s–3min 返回中文提示，否则 null。
 * durationSec <= 0 表示前端读不出元数据——放行，由 MediaKit 做权威校验。
 */
export function validateLipSyncFootageDuration(durationSec: number): string | null {
  if (durationSec <= 0) {
    return null;
  }
  if (durationSec < LIPSYNC_MIN_FOOTAGE_DURATION_SEC) {
    return `视频太短（${Math.round(durationSec)} 秒）：出镜底板需要 10 秒–3 分钟（建议 30 秒以上更自然），请重新拍摄。`;
  }
  if (durationSec > LIPSYNC_MAX_FOOTAGE_DURATION_SEC) {
    const min = Math.floor(durationSec / 60);
    const sec = Math.round(durationSec % 60);
    return `视频太长（${min} 分 ${sec} 秒）：出镜底板最长 3 分钟，请剪辑后再上传。`;
  }
  return null;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/avatar-footage.test.ts`
Expected: PASS（含既有 HeyGen 闸门用例，未动）

- [ ] **Step 5: Commit**

```bash
git add lib/avatar-footage.ts tests/avatar-footage.test.ts
git commit -m "feat(avatar): 对口型底板素材闸门（10s-3min/≤200MB，独立于 HeyGen 训练素材）

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 3: 上传链路放行 `lipsync_footage` category

**Files:**
- Modify: `lib/schemas.ts:53`
- Modify: `app/api/assets/upload-intent/route.ts:24-27`
- Modify: `lib/services/assets.ts`（UploadIntentInput.category 类型 + UploadIntent.category 类型 + 注释）
- Modify: `app/api/assets/confirm/route.ts:64-69`（仅注释，逻辑已兼容）
- Test: `tests/schemas.test.ts`、`tests/api/upload-intent.test.ts`、`tests/create-upload-intent.test.ts`

**逻辑要点：** confirm 路由已有两道大小闸（全局 200MB 在前、`avatar_footage` 专属 30MB 在后）——`lipsync_footage` 天然只受全局 200MB 约束，**无需新闸**。upload-intent 的 `createUploadIntent` 同理（全局 MAX_UPLOAD_BYTES 检查在前）。本任务只是把新 category 透传放行 + 类型 + 注释。

- [ ] **Step 1: 写失败测试**

`tests/schemas.test.ts` 找到 confirmAssetUploadSchema 相关 describe，追加：

```ts
  it("confirmAssetUploadSchema accepts category=lipsync_footage", () => {
    const parsed = confirmAssetUploadSchema.safeParse({
      assetId: "asset_1",
      storeId: "store_1",
      storageKey: "stores/store_1/assets/asset_1-a.mp4",
      originalFilename: "a.mp4",
      mimeType: "video/mp4",
      type: "video",
      sizeBytes: 1000,
      category: "lipsync_footage",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.category).toBe("lipsync_footage");
  });
```

`tests/api/upload-intent.test.ts` 尾部追加（照抄同文件 avatar_footage 用例的形状）：

```ts
  it("passes category=lipsync_footage through to the service", async () => {
    vi.spyOn(env, "hasObjectStorage").mockReturnValue(true);
    const spy = vi.spyOn(assetsService, "createUploadIntent").mockResolvedValue({
      assetId: "asset_1",
      storageKey: "stores/store_1/assets/asset_1-demo.mp4",
      uploadUrl: "https://signed.example/upload",
      headers: { "Content-Type": "video/mp4" },
      maxSizeBytes: 200 * 1024 * 1024,
      expiresInSeconds: 900,
      category: "lipsync_footage"
    });

    const response = await POST(
      new Request("http://localhost/api/assets/upload-intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storeId: "store_1",
          filename: "demo.mp4",
          contentType: "video/mp4",
          sizeBytes: 1000,
          category: "lipsync_footage"
        })
      })
    );

    expect(response.status).toBe(201);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ category: "lipsync_footage" }));
  });
```

`tests/create-upload-intent.test.ts` 尾部追加：

```ts
describe("createUploadIntent lipsync_footage size cap", () => {
  const base = { ownerId: "owner_1", storeId: "store_1", filename: "me.mp4", contentType: "video/mp4" };

  it("does not apply the HeyGen 30MB cap to lipsync_footage (only the global 200MB cap)", async () => {
    const intent = await createUploadIntent({ ...base, sizeBytes: 150 * 1024 * 1024, category: "lipsync_footage" });
    expect(intent.category).toBe("lipsync_footage");
  });

  it("rejects lipsync_footage over the global 200MB cap", async () => {
    await expect(
      createUploadIntent({ ...base, sizeBytes: 201 * 1024 * 1024, category: "lipsync_footage" }),
    ).rejects.toThrow(UploadValidationError);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/schemas.test.ts tests/api/upload-intent.test.ts tests/create-upload-intent.test.ts`
Expected: FAIL — lipsync_footage 被 400/类型错误

- [ ] **Step 3: 实现**

`lib/schemas.ts:53` 改：

```ts
  category: z.enum(["material", "avatar_footage", "lipsync_footage"]).default("material")
```

`app/api/assets/upload-intent/route.ts:24-27` 改：

```ts
  // category 校验后透传：前端 confirm 时回传同一值落库（见 assets/confirm）。
  const category = body.category === undefined ? "material" : body.category;
  if (category !== "material" && category !== "avatar_footage" && category !== "lipsync_footage") {
    return jsonError("category must be material, avatar_footage or lipsync_footage", 400);
  }
```

`lib/services/assets.ts` 三处改：

```ts
interface UploadIntentInput {
  ownerId: string;
  storeId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  /** material（默认）| avatar_footage（HeyGen 训练素材，30MB 闸）| lipsync_footage（对口型底板，仅全局 200MB 闸）。人像视频走同一存储链路与 MIME 校验。 */
  category?: "material" | "avatar_footage" | "lipsync_footage";
}
```

```ts
export interface UploadIntent {
  assetId: string;
  storageKey: string;
  uploadUrl: string;
  headers: Record<string, string>;
  maxSizeBytes: number;
  expiresInSeconds: number;
  category: "material" | "avatar_footage" | "lipsync_footage";
}
```

`createUploadIntent` 里 30MB 闸门注释更新（逻辑不动——`input.category === "avatar_footage"` 条件天然不含 lipsync_footage）：

```ts
  // 分身训练素材走更严的 30MB 上限：HeyGen /v3/assets 直传硬上限 32MB
  // （2026-09-05 生产实测 89.3MB 被 400 拒）。在上传入口拦死，避免用户
  // 传完大文件后创建分身时才炸。时长维度只能由前端读元数据拦截，服务端以大小为准。
  // lipsync_footage（对口型底板）不受此闸——MediaKit 无 32MB 限制，全局 200MB 即可。
  if (input.category === "avatar_footage" && input.sizeBytes > MAX_FOOTAGE_BYTES) {
```

`app/api/assets/confirm/route.ts:64-69` 注释更新（逻辑不动）：

```ts
  // 分身训练素材 30MB 复核（以 HeadObject 的真实大小为准，防伪造声明绕过
  // upload-intent 闸门）。超限对象直接删除——与 MIME 不符同处理，不占存储。
  // lipsync_footage 不受 30MB 约束（对口型无 HeyGen 32MB 硬上限），上方全局
  // MAX_UPLOAD_BYTES（200MB）已覆盖。
  if (input.category === "avatar_footage" && sizeBytes > MAX_FOOTAGE_BYTES) {
```

- [ ] **Step 4: 跑测试确认通过 + typecheck**

Run: `npx vitest run tests/schemas.test.ts tests/api/upload-intent.test.ts tests/create-upload-intent.test.ts tests/api/assets-confirm.test.ts && npm run typecheck`
Expected: 全 PASS；typecheck 无错

- [ ] **Step 5: Commit**

```bash
git add lib/schemas.ts app/api/assets/upload-intent/route.ts lib/services/assets.ts app/api/assets/confirm/route.ts tests/schemas.test.ts tests/api/upload-intent.test.ts tests/create-upload-intent.test.ts
git commit -m "feat(assets): 上传链路放行 lipsync_footage category（仅全局 200MB 闸）

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 4: 豆包 TTS 客户端（lib/services/doubao-tts.ts）

**Files:**
- Create: `lib/services/doubao-tts.ts`
- Test: `tests/doubao-tts.test.ts`

**职责：** 调豆包 TTS V3 HTTP Chunked 单向流式接口，把 chunked JSON 帧流解析成「完整 mp3 字节 + 字级时间轴」，音频持久化到 R2，时长用 ffprobe 实测（**不用字幕末词时间冒充时长**——mp3 有 ~100ms 句首静音，字幕只覆盖有声部分）。只被 worker 侧调用（provider 内部），web 路由不直接碰。

- [ ] **Step 1: 写失败测试**

新建 `tests/doubao-tts.test.ts`：

```ts
import { describe, expect, it, vi, afterEach } from "vitest";
import { synthesizeDoubaoSpeech } from "@/lib/services/doubao-tts";

/** 构造 V3 chunked 响应体：音频帧 + 字幕帧 + 结束帧，逐行 JSON。 */
function chunkedBody(frames: object[]): string {
  return frames.map((f) => JSON.stringify(f)).join("\n");
}

function okResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
}

const audioFrame = (text: string) => ({ code: 0, message: "", data: Buffer.from(text).toString("base64") });
const subtitleFrame = {
  code: 0,
  data: null,
  sentence: {
    text: "大家好",
    words: [
      { word: "大", startTime: 0.0, endTime: 0.2, confidence: 0.9 },
      { word: "家", startTime: 0.2, endTime: 0.4, confidence: 0.9 },
      { word: "好", startTime: 0.4, endTime: 0.65, confidence: 0.9 },
    ],
  },
};
const endFrame = { code: 20000000, message: "ok", data: null, usage: { text_words: 3 } };

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    fetchImpl: vi.fn(async () => okResponse(chunkedBody([audioFrame("fake-mp3-bytes"), subtitleFrame, endFrame]))),
    probeDuration: vi.fn(async () => 0.72),
    putObject: vi.fn(async () => undefined),
    makeTmpDir: vi.fn(() => "C:/fake-tmp"),
    removeDir: vi.fn(),
    writeFileFn: vi.fn(async () => undefined),
    apiKey: "test-tts-key",
    ...overrides,
  };
}

describe("synthesizeDoubaoSpeech", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("posts to the V3 unidirectional endpoint with subtitle enabled and assembles audio + word timeline", async () => {
    const deps = makeDeps();
    const result = await synthesizeDoubaoSpeech({ text: "大家好", voice: "voice_x" }, deps);

    const [url, init] = (deps.fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://openspeech.bytedance.com/api/v3/tts/unidirectional");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Api-Key"]).toBe("test-tts-key");
    expect(headers["X-Api-Resource-Id"]).toBe("seed-tts-2.0");
    expect(headers["X-Api-Request-Id"]).toBeTruthy();
    const body = JSON.parse(String(init.body));
    expect(body.req_params.text).toBe("大家好");
    expect(body.req_params.speaker).toBe("voice_x");
    expect(body.req_params.audio_params).toMatchObject({ format: "mp3", enable_subtitle: true });

    // 音频拼装 → R2；时长来自 ffprobe 实测；字幕归一化为秒级 WordTimestamp。
    expect(deps.putObject).toHaveBeenCalledWith(
      expect.stringMatching(/^voices\/tts_.+\.mp3$/),
      new Uint8Array(Buffer.from("fake-mp3-bytes")),
      "audio/mpeg",
    );
    expect(result.durationSeconds).toBe(0.72);
    expect(result.words).toEqual([
      { word: "大", startSec: 0.0, endSec: 0.2 },
      { word: "家", startSec: 0.2, endSec: 0.4 },
      { word: "好", startSec: 0.4, endSec: 0.65 },
    ]);
    expect(result.audioStorageKey).toMatch(/^voices\//);
  });

  it("falls back to the env default voice when none is passed", async () => {
    vi.stubEnv("DOUBAO_TTS_VOICE", "zh_female_vv_uranus_bigtts");
    const deps = makeDeps();
    await synthesizeDoubaoSpeech({ text: "大家好" }, deps);
    const [, init] = (deps.fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).req_params.speaker).toBe("zh_female_vv_uranus_bigtts");
  });

  it("throws with the provider message on an error frame", async () => {
    const deps = makeDeps({
      fetchImpl: vi.fn(async () =>
        okResponse(chunkedBody([{ code: 3001, message: "speaker not found" }]))),
    });
    await expect(synthesizeDoubaoSpeech({ text: "大家好" }, deps)).rejects.toThrow(/3001.*speaker not found/);
  });

  it("throws on HTTP non-2xx with a truncated body excerpt", async () => {
    const deps = makeDeps({
      fetchImpl: vi.fn(async () => new Response("Unauthorized", { status: 401 })),
    });
    await expect(synthesizeDoubaoSpeech({ text: "大家好" }, deps)).rejects.toThrow(/401/);
  });

  it("throws when the stream ends without the terminal frame (audio may be truncated)", async () => {
    const deps = makeDeps({
      fetchImpl: vi.fn(async () => okResponse(chunkedBody([audioFrame("partial")]))),
    });
    await expect(synthesizeDoubaoSpeech({ text: "大家好" }, deps)).rejects.toThrow(/结束帧/);
  });

  it("throws when no audio frames are present", async () => {
    const deps = makeDeps({
      fetchImpl: vi.fn(async () => okResponse(chunkedBody([subtitleFrame, endFrame]))),
    });
    await expect(synthesizeDoubaoSpeech({ text: "大家好" }, deps)).rejects.toThrow(/无音频/);
  });

  it("falls back to the last word timestamp when ffprobe cannot measure duration", async () => {
    const deps = makeDeps({ probeDuration: vi.fn(async () => 0) });
    const result = await synthesizeDoubaoSpeech({ text: "大家好" }, deps);
    expect(result.durationSeconds).toBe(0.65); // 字幕末词 endSec
  });

  it("rejects over-long text before spending an API call", async () => {
    const deps = makeDeps();
    await expect(synthesizeDoubaoSpeech({ text: "长".repeat(1200) }, deps)).rejects.toThrow(/超长/);
    expect(deps.fetchImpl).not.toHaveBeenCalled();
  });

  it("throws when DOUBAO_TTS_API_KEY is not configured", async () => {
    vi.stubEnv("DOUBAO_TTS_API_KEY", "");
    await expect(synthesizeDoubaoSpeech({ text: "大家好" })).rejects.toThrow(/DOUBAO_TTS_API_KEY/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/doubao-tts.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

新建 `lib/services/doubao-tts.ts`：

```ts
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDoubaoTtsApiKey, getDoubaoTtsResourceId, getDoubaoTtsVoice } from "@/lib/env";
import { createId } from "@/lib/ids";
import { SPEECH_CHARS_PER_SECOND } from "@/lib/speech-rate";
import { putObjectFromBuffer } from "@/lib/storage";
import { probeFileDuration } from "@/lib/services/ffmpeg-runner";
import type { WordTimestamp } from "@/lib/services/avatar-provider";

/**
 * 豆包语音合成大模型 2.0 —— V3 HTTP Chunked 单向流式客户端（官方文档 6561/1598757）。
 *
 * 选型说明：V1 非流式接口（/api/v1/tts）官方已标"不推荐"且不支持 TTS 2.0 音色；
 * V3 chunked 一次性输入全部文本、流式返回 JSON 帧，我们读完全流再组装——
 * 效果等同非流式，但能拿到 enable_subtitle=true 的字级时间戳（基于原文，
 * 字幕链路直接可用；V1 的 with_timestamp 是 TN 后文本，对不上原稿）。
 *
 * 只在 worker 侧使用：依赖 ffprobe 实测音频时长（mp3 句首有 ~100ms 静音，
 * 字幕末词时间不等于音频真实时长；时长是分段时间线/字幕对齐的权威数据源）。
 */

const ENDPOINT = "https://openspeech.bytedance.com/api/v3/tts/unidirectional";
const REQUEST_TIMEOUT_MS = 60_000;
/** 防御上限：V1 文档限 1024 字节；分段后单句远低于此。超长说明分段逻辑漏了，早炸。 */
const MAX_TEXT_BYTES = 3000;

export interface DoubaoTtsResult {
  audioStorageKey: string;
  durationSeconds: number;
  words: WordTimestamp[];
}

export interface DoubaoTtsDeps {
  fetchImpl: typeof fetch;
  probeDuration: (pathOrUrl: string) => Promise<number>;
  putObject: (key: string, bytes: Uint8Array, contentType: string) => Promise<unknown>;
  makeTmpDir: () => string;
  removeDir: (dir: string) => void;
  writeFileFn: (path: string, data: Buffer) => Promise<unknown>;
  /** 测试注入；缺省读 env。 */
  apiKey?: string;
  resourceId?: string;
}

// ── V3 帧形状（文档 2.3 节）──────────────────────────────────────────────────
// 音频帧 {code:0, data:"<base64>"}；字幕帧 {code:0, data:null, sentence:{...}}；
// 结束帧 {code:20000000, usage:{text_words}}；错误帧 code 为其他值。
interface V3Frame {
  code?: number;
  message?: string;
  data?: string | null;
  sentence?: {
    text?: string;
    words?: { word?: string; startTime?: number; endTime?: number }[];
  };
}

export async function synthesizeDoubaoSpeech(
  input: { text: string; voice?: string },
  deps?: Partial<DoubaoTtsDeps>,
): Promise<DoubaoTtsResult> {
  const apiKey = deps?.apiKey ?? getDoubaoTtsApiKey();
  if (!apiKey) {
    throw new Error("DOUBAO_TTS_API_KEY is not configured");
  }
  const textBytes = Buffer.byteLength(input.text, "utf8");
  if (textBytes > MAX_TEXT_BYTES) {
    throw new Error(`豆包 TTS 文本超长（${textBytes}B > ${MAX_TEXT_BYTES}B）——单句不应到此量级，请检查分段逻辑`);
  }

  const fetchImpl = deps?.fetchImpl ?? fetch;
  const res = await fetchImpl(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": apiKey,
      "X-Api-Resource-Id": deps?.resourceId ?? getDoubaoTtsResourceId(),
      "X-Api-Request-Id": randomUUID(),
    },
    body: JSON.stringify({
      user: { uid: "ai-video-assistant" },
      namespace: "BidirectionalTTS",
      req_params: {
        text: input.text,
        speaker: input.voice ?? getDoubaoTtsVoice(),
        audio_params: { format: "mp3", sample_rate: 24000, enable_subtitle: true },
      },
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const raw = await res.text();
  if (!res.ok) {
    // 401/403 多为服务未开通或 Key 不属于语音产品线（2026-09-16 实测 MediaKit Key → 401）
    throw new Error(`豆包 TTS HTTP ${res.status}：${raw.slice(0, 200)}`);
  }

  const audioChunks: Buffer[] = [];
  const words: WordTimestamp[] = [];
  let sawTerminalFrame = false;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let frame: V3Frame;
    try {
      frame = JSON.parse(trimmed) as V3Frame;
    } catch {
      throw new Error(`豆包 TTS 响应含非 JSON 行（协议漂移）：${trimmed.slice(0, 200)}`);
    }
    if (frame.code === 20000000) {
      sawTerminalFrame = true;
      continue;
    }
    if (frame.code !== 0) {
      throw new Error(`豆包 TTS 合成失败 code=${String(frame.code)}：${frame.message ?? "未知错误"}`);
    }
    if (typeof frame.data === "string" && frame.data.length > 0) {
      audioChunks.push(Buffer.from(frame.data, "base64"));
    }
    if (frame.sentence?.words) {
      for (const w of frame.sentence.words) {
        if (w.word && typeof w.startTime === "number" && typeof w.endTime === "number") {
          words.push({ word: w.word, startSec: w.startTime, endSec: w.endTime });
        }
      }
    }
  }
  if (!sawTerminalFrame) {
    throw new Error("豆包 TTS 响应缺少结束帧（code=20000000）——音频可能被截断，丢弃重试");
  }
  if (audioChunks.length === 0) {
    throw new Error("豆包 TTS 返回无音频数据");
  }
  const audio = Buffer.concat(audioChunks);

  const putObject = deps?.putObject ?? putObjectFromBuffer;
  const storageKey = `voices/${createId("tts")}.mp3`;
  await putObject(storageKey, new Uint8Array(audio), "audio/mpeg");

  // 时长权威来源：ffprobe 实测（字幕末词只是兜底；再兜不住按全局语速估算）。
  const makeTmpDir = deps?.makeTmpDir ?? (() => mkdtempSync(join(tmpdir(), "tts-")));
  const removeDir = deps?.removeDir ?? ((dir: string) => rmSync(dir, { recursive: true, force: true }));
  const writeFileFn = deps?.writeFileFn ?? (async (path: string, data: Buffer) => { await writeFile(path, data); });
  const probe = deps?.probeDuration ?? probeFileDuration;
  let durationSeconds = 0;
  const dir = makeTmpDir();
  try {
    const audioPath = join(dir, "speech.mp3");
    await writeFileFn(audioPath, audio);
    durationSeconds = await probe(audioPath);
  } finally {
    removeDir(dir);
  }
  if (!(durationSeconds > 0)) {
    const lastWordEnd = words.length > 0 ? Math.max(...words.map((w) => w.endSec)) : 0;
    durationSeconds = lastWordEnd > 0 ? lastWordEnd : Array.from(input.text).length / SPEECH_CHARS_PER_SECOND;
  }

  return { audioStorageKey: storageKey, durationSeconds, words };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/doubao-tts.test.ts`
Expected: 9 passed

- [ ] **Step 5: Commit**

```bash
git add lib/services/doubao-tts.ts tests/doubao-tts.test.ts
git commit -m "feat(avatar): 豆包TTS V3客户端（chunked帧解析+字级时间戳+ffprobe实测时长）

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 5: VolcEngineLipSyncProvider（lib/services/providers/volcengine-lipsync.ts）

**Files:**
- Create: `lib/services/providers/volcengine-lipsync.ts`
- Test: `tests/volcengine-lipsync-provider.test.ts`

**职责映射（AvatarProvider 接口 → 对口型语义）：**

| 接口方法 | 对口型实现 |
|---|---|
| `createDigitalTwin` | 不调远端；`groupId = "lipsync:{footageStorageKey}"`（本地句柄），`consentUrl = ""`（无外部授权流） |
| `getDigitalTwinStatus` | 立即返回 `approved + ready`，`providerAvatarId = footageStorageKey`、`providerVoiceId = env 默认音色` |
| `generateTalkingHead` | 豆包 TTS 合成（拿字级时间戳）→ 素材+音频双 presigned URL → MediaKit lip-sync（`enable_video_loop=true`）→ 轮询 → 下载转存 R2 |
| `synthesizeSpeech` | 直通豆包 TTS（画外音段用） |
| `refreshConsent` | 抛错（对口型形象无授权概念，路由层已拦） |
| `createAvatar`（legacy 模板路径） | 抛错并指明方向（平台公共形象依赖 HeyGen 模板） |

- [ ] **Step 1: 写失败测试**

新建 `tests/volcengine-lipsync-provider.test.ts`：

```ts
import { describe, expect, it, vi, afterEach } from "vitest";
import { createVolcEngineLipSyncProvider } from "@/lib/services/providers/volcengine-lipsync";

const FOOTAGE_KEY = "stores/store_1/assets/asset_1-me.mp4";

/** MediaKit 响应帧工厂。 */
function mediakitSubmitOk(taskId = "amk-tool-lip-sync-1") {
  return new Response(JSON.stringify({ task_id: taskId }), { status: 200 });
}
function mediakitTaskRunning() {
  return new Response(JSON.stringify({ status: "running" }), { status: 200 });
}
function mediakitTaskCompleted(videoUrl = "https://mediakit.example/result.mp4", duration = 12.34) {
  return new Response(
    JSON.stringify({ status: "completed", result: { video_url: videoUrl, duration }, expires_at: 1900000000 }),
    { status: 200 },
  );
}
function mediakitTaskFailed(message = "视频中未检测到单人真人脸") {
  return new Response(
    JSON.stringify({ status: "failed", error: { code: "ContentCheckFailed", message, param: "video_url", type: "invalid" } }),
    { status: 200 },
  );
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  const fetchImpl = vi.fn(async (url: string) => {
    if (url.includes("/api/v1/tools/lip-sync")) return mediakitSubmitOk();
    if (url.includes("/api/v1/tasks/")) return mediakitTaskCompleted();
    if (url === "https://mediakit.example/result.mp4") {
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  return {
    fetchImpl,
    synthesizeSpeechFn: vi.fn(async () => ({
      audioStorageKey: "voices/tts_fake.mp3",
      durationSeconds: 12.3,
      words: [{ word: "大", startSec: 0, endSec: 0.2 }],
    })),
    presignGet: vi.fn(async (key: string) => `https://r2.example/presigned/${key}`),
    putObject: vi.fn(async () => undefined),
    pollIntervalMs: 1,
    pollTimeoutMs: 10_000,
    apiKey: "test-mediakit-key",
    ...overrides,
  };
}

describe("volcengine-lipsync provider", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("createDigitalTwin is local-only: groupId encodes the footage storageKey, consentUrl is empty", async () => {
    const provider = createVolcEngineLipSyncProvider(makeDeps());
    const result = await provider.createDigitalTwin({ name: "老刘", footageUrl: "https://r2.example/x", footageStorageKey: FOOTAGE_KEY });
    expect(result).toEqual({ groupId: `lipsync:${FOOTAGE_KEY}`, consentUrl: "" });
  });

  it("createDigitalTwin throws when footageStorageKey is missing (contract misuse)", async () => {
    const provider = createVolcEngineLipSyncProvider(makeDeps());
    await expect(provider.createDigitalTwin({ name: "老刘", footageUrl: "https://r2.example/x" })).rejects.toThrow(/footageStorageKey/);
  });

  it("getDigitalTwinStatus is immediately ready, mapping groupId back to footage storageKey + default voice", async () => {
    vi.stubEnv("DOUBAO_TTS_VOICE", "voice_default");
    const provider = createVolcEngineLipSyncProvider(makeDeps());
    const status = await provider.getDigitalTwinStatus({ groupId: `lipsync:${FOOTAGE_KEY}` });
    expect(status).toMatchObject({
      consentStatus: "approved",
      trainingStatus: "ready",
      providerAvatarId: FOOTAGE_KEY,
      providerVoiceId: "voice_default",
    });
  });

  it("getDigitalTwinStatus reports failed for a malformed groupId (defensive)", async () => {
    const provider = createVolcEngineLipSyncProvider(makeDeps());
    const status = await provider.getDigitalTwinStatus({ groupId: "garbage" });
    expect(status.trainingStatus).toBe("failed");
    expect(status.reason).toBeTruthy();
  });

  it("generateTalkingHead: TTS → presigned urls → lip-sync submit → poll → download → R2, with words + duration", async () => {
    const deps = makeDeps();
    const provider = createVolcEngineLipSyncProvider(deps);
    const onProgress = vi.fn();

    const result = await provider.generateTalkingHead(
      { providerAvatarId: FOOTAGE_KEY, providerVoiceId: "voice_a", scriptText: "大家好，本周全场八八折" },
      onProgress,
    );

    // TTS 用形象的声音
    expect(deps.synthesizeSpeechFn).toHaveBeenCalledWith({ text: "大家好，本周全场八八折", voice: "voice_a" });
    // MediaKit 提交体：双 presigned URL + 恒 enable_video_loop
    const submitCall = (deps.fetchImpl as ReturnType<typeof vi.fn>).mock.calls.find(([url]) =>
      String(url).includes("/api/v1/tools/lip-sync"),
    ) as unknown as [string, RequestInit];
    const submitBody = JSON.parse(String(submitCall[1].body));
    expect(submitBody).toEqual({
      video_url: `https://r2.example/presigned/${FOOTAGE_KEY}`,
      audio_url: "https://r2.example/presigned/voices/tts_fake.mp3",
      enable_video_loop: true,
    });
    expect((submitCall[1].headers as Record<string, string>).Authorization).toBe("Bearer test-mediakit-key");
    // 产物转存 R2 + 时长用 MediaKit 权威值 + 字级时间戳透传
    expect(deps.putObject).toHaveBeenCalledWith(
      expect.stringMatching(/^avatars\/lipsync\/amk-tool-lip-sync-1\.mp4$/),
      new Uint8Array([1, 2, 3]),
      "video/mp4",
    );
    expect(result.videoAssetId).toMatch(/^avatars\/lipsync\//);
    expect(result.durationSeconds).toBe(12.34);
    expect(result.words).toEqual([{ word: "大", startSec: 0, endSec: 0.2 }]);
    expect(onProgress).toHaveBeenCalled();
  });

  it("generateTalkingHead falls back to the TTS duration when the task result has no duration", async () => {
    const deps = makeDeps({
      fetchImpl: vi.fn(async (url: string) => {
        if (url.includes("/api/v1/tools/lip-sync")) return mediakitSubmitOk();
        if (url.includes("/api/v1/tasks/")) {
          return new Response(JSON.stringify({ status: "completed", result: { video_url: "https://mediakit.example/result.mp4" } }), { status: 200 });
        }
        return new Response(new Uint8Array([1]), { status: 200 });
      }),
    });
    const provider = createVolcEngineLipSyncProvider(deps);
    const result = await provider.generateTalkingHead({ providerAvatarId: FOOTAGE_KEY, scriptText: "测试" });
    expect(result.durationSeconds).toBe(12.3);
  });

  it("generateTalkingHead surfaces the provider error message when the task fails", async () => {
    const deps = makeDeps({
      fetchImpl: vi.fn(async (url: string) => {
        if (url.includes("/api/v1/tools/lip-sync")) return mediakitSubmitOk();
        if (url.includes("/api/v1/tasks/")) return mediakitTaskFailed();
        throw new Error("unexpected");
      }),
    });
    const provider = createVolcEngineLipSyncProvider(deps);
    await expect(
      provider.generateTalkingHead({ providerAvatarId: FOOTAGE_KEY, scriptText: "测试" }),
    ).rejects.toThrow(/对口型生成失败.*未检测到单人真人脸/);
  });

  it("generateTalkingHead keeps polling through running states and reports progress", async () => {
    let taskCalls = 0;
    const deps = makeDeps({
      fetchImpl: vi.fn(async (url: string) => {
        if (url.includes("/api/v1/tools/lip-sync")) return mediakitSubmitOk();
        if (url.includes("/api/v1/tasks/")) {
          taskCalls++;
          return taskCalls < 3 ? mediakitTaskRunning() : mediakitTaskCompleted();
        }
        return new Response(new Uint8Array([1]), { status: 200 });
      }),
    });
    const provider = createVolcEngineLipSyncProvider(deps);
    const result = await provider.generateTalkingHead({ providerAvatarId: FOOTAGE_KEY, scriptText: "测试" });
    expect(result.durationSeconds).toBe(12.34);
    expect(taskCalls).toBe(3);
  });

  it("generateTalkingHead times out with a descriptive error", async () => {
    const deps = makeDeps({
      pollTimeoutMs: 5,
      fetchImpl: vi.fn(async (url: string) => {
        if (url.includes("/api/v1/tools/lip-sync")) return mediakitSubmitOk();
        if (url.includes("/api/v1/tasks/")) return mediakitTaskRunning();
        throw new Error("unexpected");
      }),
    });
    const provider = createVolcEngineLipSyncProvider(deps);
    await expect(
      provider.generateTalkingHead({ providerAvatarId: FOOTAGE_KEY, scriptText: "测试" }),
    ).rejects.toThrow(/超时/);
  });

  it("generateTalkingHead throws when the completed task has no video_url", async () => {
    const deps = makeDeps({
      fetchImpl: vi.fn(async (url: string) => {
        if (url.includes("/api/v1/tools/lip-sync")) return mediakitSubmitOk();
        if (url.includes("/api/v1/tasks/")) {
          return new Response(JSON.stringify({ status: "completed", result: {} }), { status: 200 });
        }
        throw new Error("unexpected");
      }),
    });
    const provider = createVolcEngineLipSyncProvider(deps);
    await expect(
      provider.generateTalkingHead({ providerAvatarId: FOOTAGE_KEY, scriptText: "测试" }),
    ).rejects.toThrow(/video_url/);
  });

  it("generateTalkingHead throws on a submit-level API error envelope", async () => {
    const deps = makeDeps({
      fetchImpl: vi.fn(async () =>
        new Response(JSON.stringify({ success: false, error: { code: "InvalidParam", message: "video_url 无法下载", param: "video_url", type: "invalid" } }), { status: 200 })),
    });
    const provider = createVolcEngineLipSyncProvider(deps);
    await expect(
      provider.generateTalkingHead({ providerAvatarId: FOOTAGE_KEY, scriptText: "测试" }),
    ).rejects.toThrow(/video_url 无法下载/);
  });

  it("synthesizeSpeech delegates to doubao tts with the profile voice", async () => {
    const deps = makeDeps();
    const provider = createVolcEngineLipSyncProvider(deps);
    const result = await provider.synthesizeSpeech({ providerVoiceId: "voice_b", text: "画外音测试" });
    expect(deps.synthesizeSpeechFn).toHaveBeenCalledWith({ text: "画外音测试", voice: "voice_b" });
    expect(result.audioStorageKey).toBe("voices/tts_fake.mp3");
  });

  it("refreshConsent and legacy createAvatar throw actionable errors", async () => {
    const provider = createVolcEngineLipSyncProvider(makeDeps());
    await expect(provider.refreshConsent({ groupId: "x" })).rejects.toThrow(/无需授权/);
    await expect(provider.createAvatar({ trainingVideoAssetId: "", ownerId: "o" })).rejects.toThrow(/平台公共形象/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/volcengine-lipsync-provider.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

新建 `lib/services/providers/volcengine-lipsync.ts`：

```ts
import {
  getDoubaoTtsVoice,
  getMediakitApiKey,
  getMediakitBaseUrl,
  getMediakitPollIntervalMs,
  getMediakitPollTimeoutMs,
} from "@/lib/env";
import { createPresignedGetUrl, putObjectFromBuffer } from "@/lib/storage";
import { synthesizeDoubaoSpeech, type DoubaoTtsResult } from "@/lib/services/doubao-tts";
import type {
  AvatarProvider,
  DigitalTwinStatus,
  WordTimestamp,
} from "@/lib/services/avatar-provider";

/**
 * 火山引擎「实拍对口型」供应商（MediaKit 视频口型对齐 + 豆包 TTS 2.0 配音）。
 *
 * 与 HeyGen 分身克隆的本质差异：无训练、无槽位、无外部授权流——用户的实拍
 * 口播视频就是"人脸底板"，每次渲染把新文案配音（豆包 TTS）+ 底板视频交给
 * MediaKit 改嘴部，其余像素 100% 保真。因此：
 *  - createDigitalTwin 不调远端，groupId 只是编码 footage storageKey 的本地句柄；
 *  - getDigitalTwinStatus 立即 ready（状态机复用现有轮询端点，~10s 收敛）；
 *  - generateTalkingHead 内部串 TTS → 双 presigned URL → lip-sync 任务 → 转存 R2。
 *
 * 素材传递用 R2 presigned GET（2h 过期，任务分钟级完成，足够）而非 mediakit://
 * file_id（30 天过期，需维护重传状态机）——无状态优先。
 * 探针实证（2026-09-16，scripts/probe-lipsync.mjs）：RTF≈7、并发≥2、9:16 保持、
 * 无可见水印、enable_video_loop=true 时输出时长恒等于音频时长。
 */

const LIPSYNC_GROUP_PREFIX = "lipsync:";
/** presigned URL 有效期：覆盖任务排队+拉取，远超分钟级处理时长。 */
const PRESIGN_TTL_SECONDS = 2 * 3600;
const SUBMIT_TIMEOUT_MS = 60_000;
/** 产物下行预算：45s 成片约 20MB，10 分钟足够。 */
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

export interface LipSyncProviderDeps {
  fetchImpl: typeof fetch;
  synthesizeSpeechFn: (input: { text: string; voice?: string }) => Promise<DoubaoTtsResult>;
  presignGet: (storageKey: string, expiresInSec: number) => Promise<string>;
  putObject: (key: string, bytes: Uint8Array, contentType: string) => Promise<unknown>;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  /** 测试注入；缺省读 env。 */
  apiKey?: string;
}

// ── MediaKit 响应形状（文档 6448/2278532 + 探针实证）─────────────────────────
interface MediaKitError {
  code?: string;
  message?: string;
  param?: string;
  type?: string;
}
interface MediaKitSubmitResponse {
  task_id?: string;
  success?: boolean;
  error?: MediaKitError;
}
interface MediaKitTaskResponse {
  status?: "queued" | "running" | "completed" | "failed" | string;
  success?: boolean;
  error?: MediaKitError;
  result?: { video_url?: string; duration?: number };
  expires_at?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createVolcEngineLipSyncProvider(deps?: Partial<LipSyncProviderDeps>): AvatarProvider {
  const fetchImpl = deps?.fetchImpl ?? fetch;
  const synthesize = deps?.synthesizeSpeechFn ?? synthesizeDoubaoSpeech;
  const presignGet = deps?.presignGet ?? createPresignedGetUrl;
  const putObject = deps?.putObject ?? putObjectFromBuffer;
  const pollIntervalMs = deps?.pollIntervalMs ?? getMediakitPollIntervalMs();
  const pollTimeoutMs = deps?.pollTimeoutMs ?? getMediakitPollTimeoutMs();

  function requireApiKey(): string {
    const apiKey = deps?.apiKey ?? getMediakitApiKey();
    if (!apiKey) {
      throw new Error("MEDIKIT_API_KEY is not configured");
    }
    return apiKey;
  }

  /** MediaKit REST 调用：非 2xx 或 success=false 一律抛错（截断原文，防失明）。 */
  async function mediakitCall<T>(method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<T> {
    const res = await fetchImpl(`${getMediakitBaseUrl()}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${requireApiKey()}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
    });
    const text = await res.text();
    let json: MediaKitSubmitResponse & MediaKitTaskResponse;
    try {
      json = JSON.parse(text) as typeof json;
    } catch {
      throw new Error(`MediaKit ${method} ${path} HTTP ${res.status} 非 JSON 响应：${text.slice(0, 300)}`);
    }
    if (!res.ok || json.success === false) {
      const err = json.error;
      const detail = err ? ` code=${err.code ?? "-"} param=${err.param ?? "-"} msg=${err.message ?? "-"}` : "";
      throw new Error(`MediaKit ${method} ${path} 失败 HTTP ${res.status}${detail}`);
    }
    return json as T;
  }

  async function downloadBytes(url: string): Promise<Uint8Array<ArrayBuffer>> {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) {
      throw new Error(`MediaKit 产物下载失败 HTTP ${res.status}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  return {
    name: "volcengine-lipsync",

    /** legacy 模板形象路径不适用于对口型（无平台公共底板可言）。 */
    async createAvatar() {
      throw new Error(
        "volcengine-lipsync 无模板公共形象：平台公共形象依赖 HeyGen 模板（HEYGEN_AVATAR_TEMPLATE_ID），请先创建自己的出镜形象",
      );
    },

    async createDigitalTwin(input) {
      if (!input.footageStorageKey) {
        throw new Error("volcengine-lipsync createDigitalTwin 需要 footageStorageKey（契约误用）");
      }
      // 不调远端：素材在我们 R2 即全部状态。groupId 编码 storageKey 供状态轮询回放。
      return { groupId: `${LIPSYNC_GROUP_PREFIX}${input.footageStorageKey}`, consentUrl: "" };
    },

    async refreshConsent() {
      throw new Error("对口型形象无需授权流程（路由层应先拦截，此为防御性抛错）");
    },

    async getDigitalTwinStatus(input): Promise<DigitalTwinStatus> {
      if (!input.groupId.startsWith(LIPSYNC_GROUP_PREFIX)) {
        // 防御：句柄只可能来自我们的 createDigitalTwin；畸形即数据异常，终态 failed 透出。
        return {
          consentStatus: "approved",
          trainingStatus: "failed",
          reason: "形象数据异常（句柄无法解析），请删除后重新创建",
        };
      }
      const storageKey = input.groupId.slice(LIPSYNC_GROUP_PREFIX.length);
      return {
        consentStatus: "approved",
        trainingStatus: "ready",
        providerAvatarId: storageKey,
        providerVoiceId: getDoubaoTtsVoice(),
      };
    },

    async generateTalkingHead(input, onProgress?) {
      // Stage 1: 文案 → 配音（字级时间戳随音频一起回来）
      const speech = await synthesize({ text: input.scriptText, voice: input.providerVoiceId });

      // Stage 2: 底板 + 音频双 presigned URL → 提交对口型任务
      const [videoUrl, audioUrl] = await Promise.all([
        presignGet(input.providerAvatarId, PRESIGN_TTL_SECONDS),
        presignGet(speech.audioStorageKey, PRESIGN_TTL_SECONDS),
      ]);
      const submitted = await mediakitCall<MediaKitSubmitResponse>("POST", "/api/v1/tools/lip-sync", {
        video_url: videoUrl,
        audio_url: audioUrl,
        // 恒 true：输出时长=音频时长（底板短则镜像循环，长则截断到音频长度）。
        enable_video_loop: true,
      });
      const taskId = submitted.task_id;
      if (!taskId) {
        throw new Error(`MediaKit 对口型提交未返回 task_id：${JSON.stringify(submitted).slice(0, 300)}`);
      }

      // Stage 3: 轮询（RTF≈6-8，15s 间隔起步；进度回调映射给 worker）
      const maxAttempts = Math.max(1, Math.ceil(pollTimeoutMs / pollIntervalMs));
      let task: MediaKitTaskResponse | undefined;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        onProgress?.(attempt + 1, maxAttempts);
        if (attempt > 0) {
          await sleep(pollIntervalMs);
        }
        task = await mediakitCall<MediaKitTaskResponse>("GET", `/api/v1/tasks/${taskId}`);
        if (task.status === "completed") break;
        if (task.status === "failed") {
          const msg = task.error?.message ?? "未知原因";
          throw new Error(`对口型生成失败：${msg}（code=${task.error?.code ?? "-"}）。如提示画面/人脸问题，请按拍摄要求重录底板视频`);
        }
      }
      if (!task || task.status !== "completed") {
        throw new Error(`MediaKit 对口型任务超时（>${Math.round(pollTimeoutMs / 60000)} 分钟未完成），task_id=${taskId}`);
      }
      const resultUrl = task.result?.video_url;
      if (!resultUrl) {
        throw new Error(`MediaKit 任务完成但无 result.video_url：${JSON.stringify(task).slice(0, 300)}`);
      }

      // Stage 4: 产物 24h 有效——立即下载转存 R2
      const bytes = await downloadBytes(resultUrl);
      const storageKey = `avatars/lipsync/${taskId}.mp4`;
      await putObject(storageKey, bytes, "video/mp4");

      return {
        videoAssetId: storageKey,
        // 时长权威来源 MediaKit result.duration；缺失兜底 TTS 音频实测时长（恒等关系见上）。
        durationSeconds: task.result?.duration ?? speech.durationSeconds,
        words: speech.words,
      };
    },

    async synthesizeSpeech(input) {
      return synthesize({ text: input.text, voice: input.providerVoiceId });
    },
  };
}
```

`lib/services/avatar-provider.ts:42` 的 `createDigitalTwin` 签名需要加 `footageStorageKey`（Task 7 做），本任务引用它前 typecheck 会红——**Task 5 与 Task 7 有编译依赖：先跑 Task 7 Step 3 的接口签名改动，或接受本任务 typecheck 暂红、到 Task 7 一起绿**。执行顺序建议：Task 5 先写 provider + 测试（vitest 跑 esbuild 不做全量 typecheck，测试能过），typecheck 留到 Task 7 收口。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/volcengine-lipsync-provider.test.ts`
Expected: 13 passed

- [ ] **Step 5: Commit**

```bash
git add lib/services/providers/volcengine-lipsync.ts tests/volcengine-lipsync-provider.test.ts
git commit -m "feat(avatar): VolcEngineLipSyncProvider——豆包TTS配音+MediaKit对口型全链路

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 6: provider 工厂扩展（providers/index.ts）+ .env.example

**Files:**
- Modify: `lib/services/providers/index.ts`
- Modify: `.env.example`
- Test: `tests/providers-factory.test.ts`（追加）

**为什么需要 `createProviderByName`：** status/consent 路由和 talking_head 处理器目前都用 `createProviderFromEnv()`（部署级唯一 provider）。生产切到 `volcengine-lipsync` 后，**老 HeyGen 形象**的状态轮询会拿对口型 provider 去查 HeyGen groupId——全坏。必须按 `profile.provider` 逐形象解析。

- [ ] **Step 1: 写失败测试（追加到 tests/providers-factory.test.ts）**

```ts
import { createProviderByName, createProviderFromEnv, AvatarProviderNotConfiguredError } from "@/lib/services/providers";

describe("provider factory", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("createProviderFromEnv returns the lipsync provider when AVATAR_PROVIDER=volcengine-lipsync and both keys are set", () => {
    vi.stubEnv("AVATAR_PROVIDER", "volcengine-lipsync");
    vi.stubEnv("MEDIKIT_API_KEY", "mk");
    vi.stubEnv("DOUBAO_TTS_API_KEY", "tts");
    expect(createProviderFromEnv().name).toBe("volcengine-lipsync");
  });

  it("createProviderFromEnv throws in production when lipsync is named but keys are missing", () => {
    vi.stubEnv("APP_MODE", "production");
    vi.stubEnv("AVATAR_PROVIDER", "volcengine-lipsync");
    vi.stubEnv("MEDIKIT_API_KEY", "");
    vi.stubEnv("DOUBAO_TTS_API_KEY", "");
    expect(() => createProviderFromEnv()).toThrow(AvatarProviderNotConfiguredError);
  });

  it("createProviderFromEnv falls back to mock in demo when lipsync keys are missing", () => {
    vi.stubEnv("APP_MODE", "demo");
    vi.stubEnv("AVATAR_PROVIDER", "volcengine-lipsync");
    vi.stubEnv("MEDIKIT_API_KEY", "");
    vi.stubEnv("DOUBAO_TTS_API_KEY", "");
    expect(createProviderFromEnv().name).toBe("mock-avatar");
  });

  it("createProviderFromEnv keeps the heygen branch unchanged", () => {
    vi.stubEnv("APP_MODE", "production");
    vi.stubEnv("AVATAR_PROVIDER", "heygen");
    vi.stubEnv("AVATAR_PROVIDER_API_KEY", "hk");
    expect(createProviderFromEnv().name).toBe("heygen");
  });

  it("createProviderByName resolves per-profile providers and falls back to env for unknown names", () => {
    vi.stubEnv("APP_MODE", "demo");
    vi.stubEnv("AVATAR_PROVIDER", "");
    expect(createProviderByName("heygen").name).toBe("heygen");
    expect(createProviderByName("volcengine-lipsync").name).toBe("volcengine-lipsync");
    expect(createProviderByName("mock-avatar").name).toBe("mock-avatar");
    // 未知/缺省（平台公共形象、老数据）→ env 创建 provider（demo 无配置 → mock）
    expect(createProviderByName(undefined).name).toBe("mock-avatar");
    expect(createProviderByName("d-id").name).toBe("mock-avatar");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/providers-factory.test.ts`
Expected: FAIL — createProviderByName 未导出 / lipsync 分支不存在

- [ ] **Step 3: 实现**

`lib/services/providers/index.ts` 全文替换为：

```ts
import { getAppMode, getAvatarProviderName, hasAvatarProvider, hasLipSyncProvider } from "@/lib/env";
import type { AvatarProvider } from "@/lib/services/avatar-provider";
import { createHeyGenProvider } from "@/lib/services/providers/heygen";
import { createMockProvider } from "@/lib/services/providers/mock";
import { createVolcEngineLipSyncProvider } from "@/lib/services/providers/volcengine-lipsync";

/**
 * production 下数字人提供商未配置时抛出。
 * 历史上缺省会静默降级 mock——mock 编造假的 consent 链接（consent.example.com），
 * 用户创建分身后跳转到一个不存在的网站，故障极难定位（2026-08-30 生产事故）。
 */
export class AvatarProviderNotConfiguredError extends Error {
  constructor() {
    super("Avatar provider not configured: set AVATAR_PROVIDER and the provider's API keys");
    this.name = "AvatarProviderNotConfiguredError";
  }
}

export const LIPSYNC_PROVIDER_NAME = "volcengine-lipsync";

/**
 * Factory: 新形象「创建 provider」——决定 POST /api/avatars 用哪家创建。
 *
 * - AVATAR_PROVIDER="volcengine-lipsync" + MEDIKIT_API_KEY + DOUBAO_TTS_API_KEY → 对口型
 * - AVATAR_PROVIDER="heygen" + AVATAR_PROVIDER_API_KEY → HeyGen 分身克隆
 * - demo/preview 未配置 → Mock（本地开发与测试用）
 * - production 未配置 → 抛 AvatarProviderNotConfiguredError（拒绝静默造假）
 */
export function createProviderFromEnv(): AvatarProvider {
  const name = (getAvatarProviderName() ?? "").toLowerCase();

  if (name === LIPSYNC_PROVIDER_NAME) {
    if (hasLipSyncProvider()) {
      return createVolcEngineLipSyncProvider();
    }
    if (getAppMode() === "production") {
      throw new AvatarProviderNotConfiguredError();
    }
    return createMockProvider();
  }

  if (hasAvatarProvider() && name === "heygen") {
    return createHeyGenProvider();
  }

  if (getAppMode() === "production") {
    throw new AvatarProviderNotConfiguredError();
  }
  return createMockProvider();
}

/**
 * 按 profile.provider 逐形象解析（渲染/轮询链路用）：老 HeyGen 形象与对口型
 * 形象混排时各走各的供应商。未知/缺省名（平台公共形象约定 id、mock 时代
 * 老数据）回退到 env 创建 provider——与历史行为一致。
 */
export function createProviderByName(name: string | undefined): AvatarProvider {
  switch ((name ?? "").toLowerCase()) {
    case "heygen":
      return createHeyGenProvider();
    case LIPSYNC_PROVIDER_NAME:
      return createVolcEngineLipSyncProvider();
    case "mock-avatar":
      return createMockProvider();
    default:
      return createProviderFromEnv();
  }
}
```

`.env.example` 在 HeyGen 段（第 50 行后）追加：

```bash
# ── 火山引擎「实拍对口型」供应商（AVATAR_PROVIDER=volcengine-lipsync 时启用）──
# 新形象默认创建路径：上传实拍口播视频 → 豆包 TTS 配音 → MediaKit 改口型。
# 注意两个 Key 分属不同产品线，各自控制台申请，不通用（2026-09-16 实测 401）。
# MediaKit API Key：火山引擎 AI MediaKit 控制台
MEDIKIT_API_KEY=""
# MEDIKIT_BASE_URL 默认 https://mediakit.cn-beijing.volces.com，跨区域才改
# MEDIKIT_POLL_INTERVAL_MS="15000"
# MEDIKIT_POLL_TIMEOUT_MS="2400000"
# 豆包语音合成 API Key：语音技术控制台「API Key 管理」（先开通豆包语音合成大模型 2.0）
DOUBAO_TTS_API_KEY=""
# TTS 2.0 音色（发音人 id，音色列表见文档 6561/1257544；注意须为 _uranus_bigtts 后缀的 2.0 音色）
# DOUBAO_TTS_VOICE="zh_female_vv_uranus_bigtts"
# 计费/模型资源位：标准音色 seed-tts-2.0；声音复刻上线后 seed-icl-2.0
# DOUBAO_TTS_RESOURCE_ID="seed-tts-2.0"
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/providers-factory.test.ts`
Expected: 8 passed（Task 1 的 2 个 + 本任务 6 个）

- [ ] **Step 5: Commit**

```bash
git add lib/services/providers/index.ts .env.example tests/providers-factory.test.ts
git commit -m "feat(avatar): provider工厂加volcengine-lipsync分支+按profile逐形象解析createProviderByName

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 7: AvatarProvider 契约扩展（words + footageStorageKey）

**Files:**
- Modify: `lib/services/avatar-provider.ts:30-40,42,135-150`
- Test: `tests/avatar-provider.test.ts`（追加）

**两处契约扩展：**
1. `generateTalkingHead` 返回加可选 `words?: WordTimestamp[]`——对口型 provider 内部必经 TTS，字级时间戳是免费副产品，随出镜段进 manifest（HeyGen 不返回，保持 undefined）。当前字幕按段对齐已精确，words 为后续逐字卡拉OK字幕预留。
2. `createDigitalTwin` 输入加可选 `footageStorageKey?: string`——对口型 provider 需要把 R2 storageKey 编码进 groupId（HeyGen 忽略此字段）。

- [ ] **Step 1: 写失败测试（追加到 tests/avatar-provider.test.ts 尾部 describe 内或新建 describe）**

```ts
describe("avatar provider contract extensions (lipsync)", () => {
  it("createDigitalTwinProfile passes footageStorageKey through to the provider", async () => {
    const seen: { footageStorageKey?: string } = {};
    const provider = createMockProvider();
    const spy = vi.spyOn(provider, "createDigitalTwin").mockImplementation(async (input) => {
      seen.footageStorageKey = input.footageStorageKey;
      return { groupId: "g1", consentUrl: "https://consent.example.com/g1" };
    });
    await createDigitalTwinProfile({
      ownerId: "user_1",
      storeId: "store_1",
      name: "老刘",
      footageAssetId: "asset_1",
      footageUrl: "https://cdn.example.com/presigned.mp4",
      footageStorageKey: "stores/store_1/assets/asset_1-me.mp4",
      consentAccepted: true,
      provider,
    });
    expect(spy).toHaveBeenCalledOnce();
    expect(seen.footageStorageKey).toBe("stores/store_1/assets/asset_1-me.mp4");
  });

  it("requestAvatarTalkingHead still works when the provider returns words (optional field)", async () => {
    const provider = createMockProvider();
    vi.spyOn(provider, "generateTalkingHead").mockImplementation(async () => ({
      videoAssetId: "avatars/vid_words.mp4",
      durationSeconds: 10,
      words: [{ word: "好", startSec: 0, endSec: 0.3 }],
    }));
    const result = await requestAvatarTalkingHead({
      provider,
      avatarProfileId: "avatar_1",
      providerAvatarId: "ext",
      scriptText: "好",
    });
    expect(result.videoAssetId).toBe("avatars/vid_words.mp4");
  });
});
```

文件头 import 调整：`import { describe, expect, it, vi } from "vitest";`（加 vi），并把 `createDigitalTwinProfile` 加进 `@/lib/services/avatar-provider` 的 import 列表。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/avatar-provider.test.ts`
Expected: FAIL — `footageStorageKey` 不在 createDigitalTwin 入参类型 / `createDigitalTwinProfile` 入参无此字段

- [ ] **Step 3: 实现**

`lib/services/avatar-provider.ts:30-40` 的 `generateTalkingHead` 签名改：

```ts
  generateTalkingHead(
    input: {
      providerAvatarId: string;
      providerVoiceId?: string;
      scriptText: string;
    },
    onProgress?: (attempt: number, maxAttempts: number) => void,
  ): Promise<{
    videoAssetId: string;
    durationSeconds: number;
    /** 字级时间轴（相对本段起点秒）：对口型 provider 由内部 TTS 免费带回；HeyGen 无此能力，保持 undefined。 */
    words?: WordTimestamp[];
  }>;
```

`lib/services/avatar-provider.ts:42` 的 `createDigitalTwin` 签名改：

```ts
  /** 创建数字形象：HeyGen=分身训练（返回 group 句柄+授权链接）；对口型=本地句柄（无远端调用）。 */
  createDigitalTwin(input: { name: string; footageUrl: string; footageStorageKey?: string }): Promise<{ groupId: string; consentUrl: string }>;
```

`createDigitalTwinProfile`（135-170 行）入参与透传改：

```ts
export async function createDigitalTwinProfile(input: {
  ownerId: string;
  storeId: string;
  name: string;
  footageAssetId: string;
  footageUrl: string;
  /** 素材在 R2 的 storageKey：对口型 provider 编码进 groupId 用；HeyGen 忽略。 */
  footageStorageKey?: string;
  consentAccepted: boolean;
  provider: AvatarProvider;
}): Promise<{ profile: AvatarProfile; consentUrl: string }> {
  if (!input.consentAccepted) {
    throw new Error("创建数字人前必须确认肖像和声音授权");
  }
  const { groupId, consentUrl } = await input.provider.createDigitalTwin({
    name: input.name,
    footageUrl: input.footageUrl,
    footageStorageKey: input.footageStorageKey,
  });
```

（函数其余部分不动。）

- [ ] **Step 4: 跑测试 + 全量 typecheck（收 Task 5 的编译依赖）**

Run: `npx vitest run tests/avatar-provider.test.ts tests/volcengine-lipsync-provider.test.ts && npm run typecheck`
Expected: 全 PASS；typecheck 无错

- [ ] **Step 5: Commit**

```bash
git add lib/services/avatar-provider.ts tests/avatar-provider.test.ts
git commit -m "feat(avatar): provider契约扩展——generateTalkingHead带回字级时间戳+createDigitalTwin透传storageKey

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 8: talking_head 处理器——按形象解析 provider + 出镜段 words 透传

**Files:**
- Modify: `lib/services/voice-track.ts:5-9`（ResolvedSpeaker 加 providerName）
- Modify: `worker/processors/talking-head.ts`
- Test: `tests/talking-head-processor.test.ts`（追加）

- [ ] **Step 1: 写失败测试（追加到 tests/talking-head-processor.test.ts 的 describe 内）**

```ts
  it("resolves the provider per avatar profile (mixed heygen + lipsync speakers)", async () => {
    const now = nowIso();
    // 两个形象：一个 heygen、一个 lipsync，分段各一句
    await getAvatarRepository().create({
      id: "av_hg", ownerId: "owner_1", storeId: "store_1", name: "克隆形象",
      provider: "heygen", providerAvatarId: "hg_look", providerVoiceId: "hg_voice",
      consentStatus: "approved", consentAcceptedAt: now, trainingStatus: "ready",
      fallbackMode: "tts_voiceover", createdAt: now, updatedAt: now,
    });
    await getAvatarRepository().create({
      id: "av_ls", ownerId: "owner_1", storeId: "store_1", name: "对口型形象",
      provider: "volcengine-lipsync",
      providerAvatarId: "stores/store_1/assets/asset_1-me.mp4", providerVoiceId: "db_voice",
      consentStatus: "approved", consentAcceptedAt: now, trainingStatus: "ready",
      fallbackMode: "tts_voiceover", createdAt: now, updatedAt: now,
    });
    const draft = await seedDraft();
    const segments: ScriptSegment[] = [
      { index: 0, text: "第一句出镜", speakerIndex: 0, onCamera: true },
      { index: 1, text: "第二句也出镜", speakerIndex: 1, onCamera: true },
    ];
    await getScriptRepository().update(draft.id, {
      segments,
      speakerAvatarIds: ["av_hg", "av_ls"],
    } as Partial<ScriptDraft>);

    const calls: { provider: string; text: string }[] = [];
    const heygenProvider: AvatarProvider = {
      ...createMockProvider(),
      name: "heygen",
      async generateTalkingHead(input) {
        calls.push({ provider: "heygen", text: input.scriptText });
        return { videoAssetId: "avatars/hg.mp4", durationSeconds: 5 };
      },
    };
    const lipsyncProvider: AvatarProvider = {
      ...createMockProvider(),
      name: "volcengine-lipsync",
      async generateTalkingHead(input) {
        calls.push({ provider: "lipsync", text: input.scriptText });
        return {
          videoAssetId: "avatars/ls.mp4", durationSeconds: 6,
          words: [{ word: "第", startSec: 0, endSec: 0.2 }],
        };
      },
    };
    const providerResolver = (name: string | undefined) =>
      name === "volcengine-lipsync" ? lipsyncProvider : heygenProvider;

    const mockJob = {
      data: {
        jobId: "job_mixed", projectId: "proj_mixed", ownerId: "owner_1",
        payload: { avatarProfileIds: ["av_hg", "av_ls"], scriptDraftId: draft.id },
        dependsOnJobIds: [],
      },
      updateProgress: vi.fn(),
    };
    let captured: VoiceTrackManifest | undefined;
    await processTalkingHead(mockJob as unknown as BullJob, {
      ...depsWith(heygenProvider),
      providerResolver,
      uploadManifest: async (_key, manifest) => { captured = manifest; },
    });

    // 各走各的 provider；对口型段的 words 进了 manifest
    expect(calls).toEqual([
      { provider: "heygen", text: "第一句出镜" },
      { provider: "lipsync", text: "第二句也出镜" },
    ]);
    expect(captured?.segments[1]?.words).toEqual([{ word: "第", startSec: 0, endSec: 0.2 }]);
    expect(captured?.segments[0]?.words).toBeUndefined();
  });
```

确认文件头部 import 含 `VoiceTrackManifest`、`ScriptSegment`、`AvatarProvider`（已有），无需新增。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/talking-head-processor.test.ts`
Expected: FAIL — deps 不认识 providerResolver / manifest 无 words

- [ ] **Step 3: 实现**

`lib/services/voice-track.ts:5-9` 改：

```ts
/** 合成用的形象解析结果（provider ids 已就绪）。 */
export interface ResolvedSpeaker {
  profileId: string;
  providerAvatarId: string;
  providerVoiceId?: string;
  /** profile.provider 原样带出；平台公共形象/老数据为 undefined（→ env 创建 provider）。 */
  providerName?: string;
}
```

`worker/processors/talking-head.ts` 修改点（共 6 处）：

① `TalkingHeadDeps` 加字段：

```ts
export interface TalkingHeadDeps {
  avatarRepository: AvatarRepository;
  scriptRepository: ScriptRepository;
  renderRepository: RenderRepository;
  provider: AvatarProvider;
  /** 按 profile.provider 逐形象解析（HeyGen 老形象与对口型形象可混排）。缺省=单 provider（旧行为/测试）。 */
  providerResolver?: (providerName: string | undefined) => AvatarProvider;
  /** manifest JSON 上传（默认 R2）；测试注入捕获。 */
  uploadManifest: (key: string, manifest: VoiceTrackManifest) => Promise<void>;
}
```

② 入口 `talkingHeadProcessor` 的 deps 加 `providerResolver: createProviderByName`。import 精确改动——

现状（第 4 行）：

```ts
import { createProviderFromEnv, requestAvatarTalkingHead } from "@/lib/services/avatar-provider";
```

改为两行：

```ts
import { requestAvatarTalkingHead } from "@/lib/services/avatar-provider";
import { createProviderByName, createProviderFromEnv } from "@/lib/services/providers";
```

（`createProviderByName` 定义在 providers/index.ts，avatar-provider.ts 没 re-export 它；`createProviderFromEnv` 两边都有，统一从 providers 拿。）

deps 改：

```ts
export const talkingHeadProcessor: ProcessorFn = (job) =>
  processTalkingHead(job, {
    avatarRepository: getAvatarRepository(),
    scriptRepository: getScriptRepository(),
    renderRepository: getRenderRepository(),
    provider: createProviderFromEnv(),
    providerResolver: createProviderByName,
    uploadManifest: defaultUploadManifest
  });
```

③ `resolveSpeakers`：两处 push 加 providerName——

平台形象分支（两处 push 都加 `providerName: undefined` 可省略不写，对象字面量不含该键即可）：

```ts
      if (envIds) {
        speakers.push({ profileId: id, ...envIds });
        continue;
      }
```

真形象分支改：

```ts
    speakers.push({
      profileId: id,
      providerAvatarId: avatar.providerAvatarId,
      providerVoiceId: avatar.providerVoiceId,
      providerName: avatar.provider,
    });
```

④ `processTalkingHead` 内加本地助手（放在 speakers 解析之后）：

```ts
  const providerFor = (speaker: ResolvedSpeaker): AvatarProvider =>
    deps.providerResolver ? deps.providerResolver(speaker.providerName) : deps.provider;
```

⑤ legacy 路径改用 `providerFor(speaker)`：

```ts
  if (payload.forceLegacy || segments.length === 0) {
    const speaker = speakers[0] as ResolvedSpeaker;
    const result = await requestAvatarTalkingHead({
      provider: providerFor(speaker),
      avatarProfileId: speaker.profileId,
      ...
```

⑥ 分段循环：onCamera 分支改用 per-speaker provider 并透传 words；画外音分支同理：

```ts
  for (let i = 0; i < plan.length; i++) {
    const { segment, speaker } = plan[i]!;
    const speakerProvider = providerFor(speaker);
    if (segment.onCamera) {
      // 出镜段：数字人视频（音视频一体）。对口型 provider 由内部 TTS 带回字级时间戳。
      const result = await speakerProvider.generateTalkingHead({
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
        words: result.words,
      });
    } else {
      // 画外音段：克隆声音 TTS（含词级时间轴）；失败重试 1 次 → 降级数字人视频（spec §6.5）
      trackSegments.push(await synthesizeOffCameraSegment(segment, speaker, speakerProvider));
    }
    void job.updateProgress(5 + Math.round(((i + 1) / plan.length) * 80));
  }
```

`voice-track.ts:22-23` 的 `words` 注释更新：

```ts
  /** TTS 词级时间轴（相对本段起点的秒）；HeyGen 出镜段没有（其视频不返回），对口型出镜段有。 */
  words?: WordTimestamp[];
```

- [ ] **Step 4: 跑测试确认通过（含全部既有用例回归）**

Run: `npx vitest run tests/talking-head-processor.test.ts tests/voice-track.test.ts`
Expected: 全 PASS（旧用例无 resolver → 走 deps.provider，行为不变）

- [ ] **Step 5: Commit**

```bash
git add lib/services/voice-track.ts worker/processors/talking-head.ts tests/talking-head-processor.test.ts
git commit -m "feat(avatar): talking_head按profile.provider逐形象解析provider，出镜段透传字级时间戳

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 9: avatars 三路由——创建分流 + 按 profile 轮询 + consent 防御

**Files:**
- Modify: `app/api/avatars/route.ts`（POST 创建）
- Modify: `app/api/avatars/[id]/status/route.ts`（轮询按 profile.provider）
- Modify: `app/api/avatars/[id]/consent/route.ts`（对口型形象明确拒绝 + 按 profile.provider）
- Test: `tests/api/avatars-create.test.ts`、`tests/api/avatars-status.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/api/avatars-create.test.ts`——vi.mock 的 factoryMode 联合类型加 `"lipsync"`，工厂加分支：

```ts
const { factoryMode } = vi.hoisted(() => ({
  factoryMode: { value: "mock" as "mock" | "unconfigured" | "lipsync" },
}));
vi.mock("@/lib/services/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/services/providers")>();
  return {
    ...actual,
    createProviderFromEnv: () => {
      if (factoryMode.value === "unconfigured") {
        throw new actual.AvatarProviderNotConfiguredError();
      }
      if (factoryMode.value === "lipsync") {
        return {
          ...createMockProvider(),
          name: "volcengine-lipsync",
          async createDigitalTwin(input: { name: string; footageUrl: string; footageStorageKey?: string }) {
            return { groupId: `lipsync:${input.footageStorageKey ?? ""}`, consentUrl: "" };
          },
        };
      }
      return createMockProvider();
    },
  };
});
```

describe 内追加用例：

```ts
  it("lipsync mode: creates an instantly-polling avatar with empty consentUrl from lipsync_footage", async () => {
    factoryMode.value = "lipsync";
    const now = nowIso();
    await getAssetRepository().create({
      id: "asset_ls_1", ownerId: "demo_user", storeId: "store_1", type: "video",
      originalFilename: "board.mp4", storageKey: "stores/store_1/assets/asset_ls_1-board.mp4",
      mimeType: "video/mp4", sizeBytes: 50 * 1024 * 1024, tags: [], businessTags: [],
      status: "ready", category: "lipsync_footage", createdAt: now,
    });
    const res = await post({ storeId: "store_1", footageAssetId: "asset_ls_1", name: "老刘", consentAccepted: true });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.consentUrl).toBe("");
    expect(json.avatar).toMatchObject({
      provider: "volcengine-lipsync",
      providerGroupId: "lipsync:stores/store_1/assets/asset_ls_1-board.mp4",
      consentStatus: "awaiting_user",
      trainingStatus: "pending",
    });
  });

  it("lipsync mode: accepts legacy avatar_footage assets as lip-sync base footage", async () => {
    factoryMode.value = "lipsync";
    const res = await post({ storeId: "store_1", footageAssetId: "asset_footage_1", name: "老刘", consentAccepted: true });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.avatar.provider).toBe("volcengine-lipsync");
  });

  it("lipsync mode: rejects footage over 200MB at creation time", async () => {
    factoryMode.value = "lipsync";
    const now = nowIso();
    await getAssetRepository().create({
      id: "asset_huge", ownerId: "demo_user", storeId: "store_1", type: "video",
      originalFilename: "huge.mp4", storageKey: "stores/store_1/assets/asset_huge-h.mp4",
      mimeType: "video/mp4", sizeBytes: 201 * 1024 * 1024, tags: [], businessTags: [],
      status: "ready", category: "lipsync_footage", createdAt: now,
    });
    const res = await post({ storeId: "store_1", footageAssetId: "asset_huge", name: "老刘", consentAccepted: true });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("200MB");
  });

  it("heygen (mock) mode: rejects lipsync_footage category (creation provider mismatch)", async () => {
    const now = nowIso();
    await getAssetRepository().create({
      id: "asset_ls_2", ownerId: "demo_user", storeId: "store_1", type: "video",
      originalFilename: "board.mp4", storageKey: "stores/store_1/assets/asset_ls_2-board.mp4",
      mimeType: "video/mp4", sizeBytes: 1024, tags: [], businessTags: [],
      status: "ready", category: "lipsync_footage", createdAt: now,
    });
    const res = await post({ storeId: "store_1", footageAssetId: "asset_ls_2", name: "老刘", consentAccepted: true });
    expect(res.status).toBe(404);
  });
```

`tests/api/avatars-status.test.ts`——vi.mock 工厂加 `createProviderByName`（两路由都切到它），其余不动：

```ts
vi.mock("@/lib/services/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/services/providers")>();
  const resolve = () => {
    if (factoryMode.value === "unconfigured") {
      throw new actual.AvatarProviderNotConfiguredError();
    }
    return providerRef.current;
  };
  return {
    ...actual,
    createProviderFromEnv: resolve,
    createProviderByName: resolve,
  };
});
```

追加用例（两个 describe 各一）：

```ts
  it("resolves the provider from the profile (lipsync avatar polls via its own provider)", async () => {
    providerRef.current = createMockProvider({
      twinStatusSequence: [{
        consentStatus: "approved", trainingStatus: "ready",
        providerAvatarId: "stores/store_1/assets/asset_1-me.mp4", providerVoiceId: "db_voice",
      }],
    });
    await getAvatarRepository().create(seedAvatar({
      provider: "volcengine-lipsync",
      providerGroupId: "lipsync:stores/store_1/assets/asset_1-me.mp4",
    }));
    const res = await getStatus("avatar_1");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.avatar).toMatchObject({
      trainingStatus: "ready",
      providerAvatarId: "stores/store_1/assets/asset_1-me.mp4",
      providerVoiceId: "db_voice",
    });
  });
```

```ts
  it("400s consent re-issue for a lipsync avatar (no consent concept)", async () => {
    await getAvatarRepository().create(seedAvatar({
      provider: "volcengine-lipsync",
      providerGroupId: "lipsync:stores/store_1/assets/asset_1-me.mp4",
      consentStatus: "awaiting_user", trainingStatus: "pending",
    }));
    const res = await postConsent("avatar_1");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("无需授权");
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/api/avatars-create.test.ts tests/api/avatars-status.test.ts`
Expected: FAIL — 路由未分流 / consent 未拦截

- [ ] **Step 3: 实现**

`app/api/avatars/route.ts` POST 主体改（footage 校验段 + provider 段，62-92 行区域）：

```ts
  // IDOR：人像素材必须属于本人、且确为人像视频（防拿 b-roll 素材建形象）。
  const footage = await getAssetRepository().findById(String(body.footageAssetId));
  if (!footage || footage.ownerId !== ownerId || footage.type !== "video") {
    return jsonError("Footage asset not found", 404);
  }
  const store = await getStoreRepository().findById(String(body.storeId));
  if (!store || store.ownerId !== ownerId) {
    return jsonError("Store not found", 404);
  }

  try {
    // 创建 provider 由部署配置决定（新形象走哪条生产线）；老 HeyGen 形象渲染不受影响。
    const provider = createProviderFromEnv();
    const isLipSync = provider.name === "volcengine-lipsync";

    // category 与创建 provider 必须匹配：对口型接受 lipsync_footage + 旧 avatar_footage
    // （≤30MB/30s-5min 的旧素材天然满足对口型闸门，可直接当底板复用）；
    // HeyGen 只收 avatar_footage（lipsync_footage 可能超其 32MB 硬上限）。
    const allowedCategories = isLipSync ? ["avatar_footage", "lipsync_footage"] : ["avatar_footage"];
    if (!allowedCategories.includes(footage.category)) {
      return jsonError("Footage asset not found", 404);
    }
    // 创建时大小兜底闸（防 upload-intent/confirm 上线前的旧素材超限）。
    if (!isLipSync && footage.sizeBytes > MAX_FOOTAGE_BYTES) {
      return jsonError("训练视频超过 30MB 上限，请重新上传 30 秒–5 分钟、30MB 以内的人像视频", 400);
    }
    if (isLipSync && footage.sizeBytes > LIPSYNC_MAX_FOOTAGE_BYTES) {
      return jsonError("出镜底板视频超过 200MB 上限，请剪辑到 3 分钟以内再上传", 400);
    }

    // presigned GET 供 provider 拉取训练视频（900s 默认过期，创建时立即拉取；
    // 对口型 provider 忽略此 URL，直接用 footageStorageKey）。
    const footageUrl = await createPresignedGetUrl(footage.storageKey);
    const { profile, consentUrl } = await createDigitalTwinProfile({
      ownerId,
      storeId: store.id,
      name,
      footageAssetId: footage.id,
      footageUrl,
      footageStorageKey: footage.storageKey,
      consentAccepted: true,
      provider,
    });
    const saved = await getAvatarRepository().create(profile);
    return jsonOk({ avatar: saved, consentUrl }, 201);
  } catch (error) {
    // production 未配置数字人提供商：明确 503，绝不静默造假授权链接。
    if (error instanceof AvatarProviderNotConfiguredError) {
      return jsonError("数字人服务未配置，请联系管理员", 503);
    }
    // provider/presign 错误可能含内部细节——日志留全文，客户端只收通用文案（§8）。
    console.error("[avatars] digital twin creation failed:", error);
    return jsonError("Avatar creation failed", 502);
  }
```

import 行更新：

```ts
import { MAX_FOOTAGE_BYTES, LIPSYNC_MAX_FOOTAGE_BYTES } from "@/lib/avatar-footage";
```

`app/api/avatars/[id]/status/route.ts:41` 改：

```ts
    status = await createProviderByName(avatar.provider).getDigitalTwinStatus({ groupId: avatar.providerGroupId });
```

import 更新：`createProviderFromEnv` → `createProviderByName`（AvatarProviderNotConfiguredError 保留）。

`app/api/avatars/[id]/consent/route.ts`：在 providerGroupId 检查后、状态机检查前加防御 + 轮询改按 profile 解析：

```ts
  if (!avatar.providerGroupId) {
    return jsonError("Avatar has no provider group", 400);
  }
  // 对口型形象无授权概念（创建即就绪）：明确 400，不给 HeyGen 语义的状态机添乱。
  if (avatar.provider === "volcengine-lipsync") {
    return jsonError("对口型形象无需授权，创建后会自动就绪", 400);
  }
```

`refreshConsent` 调用改：

```ts
    const { consentUrl } = await createProviderByName(avatar.provider).refreshConsent({ groupId: avatar.providerGroupId });
```

import 同步更新。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/api/avatars-create.test.ts tests/api/avatars-status.test.ts`
Expected: 全 PASS（既有 HeyGen/mock 用例不受影响——mock provider name 是 "mock-avatar"，走 legacy 分支）

- [ ] **Step 5: Commit**

```bash
git add app/api/avatars/route.ts "app/api/avatars/[id]/status/route.ts" "app/api/avatars/[id]/consent/route.ts" tests/api/avatars-create.test.ts tests/api/avatars-status.test.ts
git commit -m "feat(avatar): 创建按部署provider分流（对口型免授权即建即就绪），轮询/重发按profile解析provider

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 10: dashboard UI——对口型创建流

**Files:**
- Modify: `components/dashboard.tsx`（分身卡片区 + 上传/创建/轮询逻辑）
- Test: `tests/dashboard.test.tsx`（4 处断言更新 + 1 新增）

**UI 语义变化：** 新建形象全部走对口型（UI 不再提供 HeyGen 克隆入口）；无授权弹窗；上传即底板。老 HeyGen 形象的授权按钮/状态文案保持不变。

- [ ] **Step 1: 先改测试（失败先行）**

`tests/dashboard.test.tsx` 4 处既有断言更新 + 1 个新用例：

① 第 92 行 consent 文案断言改：

```ts
    expect(screen.getByText("我是视频中的本人（或已获其授权），同意用这段视频生成 AI 配音口播视频")).toBeInTheDocument();
```

② 上传流用例（~742-746 行）断言改：

```ts
      await within(screen.getByRole("status")).findByText("人像视频已上传。填写形象名字并确认授权后，创建你的出镜形象。")
    // footage 上传链路带 category=lipsync_footage，且不做素材 AI 分析。
    expect(fetchedBodies["POST /api/assets/upload-intent"]).toMatchObject({ category: "lipsync_footage" });
    expect(fetchedBodies["POST /api/assets/confirm"]).toMatchObject({ category: "lipsync_footage" });
```

③ 30MB 闸门用例（~812-839 行）改为 200MB 闸门：上传文件 mock 大小改 `201 * 1024 * 1024`，文案断言改 `/200MB/`。用例标题改 `"blocks lipsync footage over 200MB before any upload request"`。

④ 新增用例（放在创建失败用例附近；popup stub 用同文件统一 pattern `vi.spyOn(window, "open")`）：

```tsx
  it("lipsync avatar creation: empty consentUrl closes the placeholder popup and shows a ready-soon message", async () => {
    const user = userEvent.setup();
    const popup = { location: { href: "" }, close: vi.fn() };
    vi.spyOn(window, "open").mockImplementation(() => popup as unknown as Window);
    const savedStore = {
      id: "store_ls", ownerId: "demo_user", name: "对口型店", industry: "餐饮",
      mainProducts: ["牛肉面"], targetCustomers: ["上班族"], sellingPoints: ["现熬"],
      promotions: [], brandTone: "亲切", forbiddenWords: [],
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const footage = {
      id: "asset_ls", ownerId: "demo_user", storeId: "store_ls", type: "video",
      originalFilename: "me.mp4", storageKey: "stores/store_ls/assets/asset_ls-me.mp4",
      mimeType: "video/mp4", sizeBytes: 3000, tags: [], businessTags: [],
      status: "uploaded", category: "lipsync_footage", createdAt: "2026-01-01T00:00:00.000Z",
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url === "/api/avatars" && method === "POST") {
        return {
          ok: true, status: 201,
          json: async () => ({
            avatar: {
              id: "avatar_ls_1", ownerId: "demo_user", storeId: "store_ls", name: "老刘",
              provider: "volcengine-lipsync",
              providerGroupId: "lipsync:stores/store_ls/assets/asset_ls-me.mp4",
              consentStatus: "awaiting_user", trainingStatus: "pending",
              consentAcceptedAt: "2026-01-01T00:00:00.000Z", fallbackMode: "tts_voiceover",
              createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
            },
            consentUrl: "",
          }),
        };
      }
      return {
        ok: true,
        json: async () => {
          if (url === "/api/store-profiles") return { stores: [savedStore] };
          if (url === "/api/assets") return { assets: [footage] };
          if (url === "/api/asset-analyses") return { analyses: [] };
          if (url === "/api/avatars") return { avatars: [] };
          if (url === "/api/jobs") return { jobs: [] };
          if (url === "/api/script-drafts") return { scripts: [] };
          return {};
        },
      };
    }));

    renderDashboard();
    await user.click(await screen.findByLabelText("选择人像视频 me.mp4"));
    await user.type(screen.getByLabelText("形象名字"), "老刘");
    await user.click(screen.getByRole("checkbox", { name: /我是视频中的本人/ }));
    await user.click(screen.getByRole("button", { name: "创建出镜形象" }));

    expect(await within(screen.getByRole("status")).findByText(/无需授权/)).toBeInTheDocument();
    expect(popup.close).toHaveBeenCalled();
    expect(popup.location.href).toBe("");
    // 对口型形象永不出现授权按钮
    expect(screen.queryByRole("button", { name: "去完成授权" })).not.toBeInTheDocument();
  });
```

（renderDashboard/within/userEvent 等同文件已有助手，照用；此用例形状与同文件"创建失败"用例一致。）

⑤ 状态文案/按钮的 provider 条件：同文件 848 行起的"去完成授权"用例种的 avatar 是 mock provider（无 provider 字段或 "mock-avatar"）→ 不受新条件影响，**不用改**。

⑥ **按钮改名联动（必须一起改，否则既有用例全红）：**
- 第 1109 行创建失败用例里 `getByRole("button", { name: "创建 AI 分身" })` → `"创建出镜形象"`
- 同用例第 1112 行失败提示正则 `/创建 AI 分身失败/` → `/创建出镜形象失败/`（UI 侧错误提示同步改名，见实现 ⑩）
- 其余出现 `创建 AI 分身` 的用例（如有）一并改名：`grep -n "创建 AI 分身" tests/dashboard.test.tsx` 全量替换

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/dashboard.test.tsx`
Expected: FAIL（文案/category/200MB/空 consentUrl 分支都不存在）

- [ ] **Step 3: 实现（dashboard.tsx 精确改动点）**

① import 行（37 行）改：

```ts
import { validateLipSyncFootageDuration, validateLipSyncFootageSize } from "@/lib/avatar-footage";
```

② `handleFootageUpload`（853-907 行）：闸门函数与 category 改——

```ts
    // 上传前闸门（对口型底板：10s-3min/≤200MB）——超限直接拒传，不浪费用户流量。
    // 时长读不出（0）时放行，由 MediaKit 在生成时做权威校验并经任务失败回报原因。
    const sizeError = validateLipSyncFootageSize(file.size);
    if (sizeError) {
      setMessage(sizeError);
      return;
    }
    const durationError = validateLipSyncFootageDuration(await probeVideoDurationSec(file));
```

两处 `category: "avatar_footage"` 改 `"lipsync_footage"`；成功提示改：

```ts
      setMessage("人像视频已上传。填写形象名字并确认授权后，创建你的出镜形象。");
```

③ `handleCreateAvatar`（934-949 行）成功分支改：

```ts
      const { avatar: profile, consentUrl } = await createAvatarApi({
        storeId: store.id,
        footageAssetId: selectedFootageId,
        name: avatarName.trim(),
        consentAccepted: true
      });
      setLocalAvatar(profile);
      await queryClient.invalidateQueries({ queryKey: ["avatars"] });
      if (!consentUrl) {
        // 对口型形象：无外部授权流，首轮状态轮询（~10s）即就绪。
        popup?.close();
        setMessage("形象已创建：对口型模式无需授权，10 秒内自动就绪，可稍等片刻后用于成片。");
      } else if (popup) {
        // HeyGen webcam 授权：占位窗跳真授权页（24h 有效）。
        popup.location.href = consentUrl;
        setMessage("已创建分身任务：请在新窗口完成真人授权（念一段授权词），完成后回到这里自动刷新状态。");
      } else {
        setMessage("分身已创建，但授权弹窗被浏览器拦截：请点下方分身卡片的「去完成授权」。");
      }
```

④ 卡片头部文案（1431-1432 行）改：

```tsx
              <h2>AI 分身</h2>
              <p>上传一段你本人讲话的视频，AI 保留你的形象、声音口型和现场环境，只把话术换成新文案——不用反复出镜，天天都能发"真人"口播</p>
```

⑤ 拍摄要求 hint（1452 行）改：

```tsx
            <p className="resultHint">拍摄要求：时长 10 秒–3 分钟（建议 30 秒以上更自然）、文件不超过 200MB、正脸面对镜头、只有一个人出镜、光线充足、无背景音乐。这段视频就是你的"出镜底板"：AI 只改口型和声音，衣服、背景、动作全部保持原样。</p>
```

⑥ 空池文案（1470 行）改：

```tsx
                <span>还没有人像视频。上传一段你本人讲话的视频，就能生成任意文案的出镜口播。</span>
```

⑦ 分身列表状态徽章（1493-1497 行）改（加 provider 标签 + 对口型"就绪中"）：

```tsx
                    {a.name || "未命名形象"}
                    {a.provider === "volcengine-lipsync" ? "（实拍对口型）" : ""}·
                    {a.trainingStatus === "ready" ? "已就绪"
                      : a.trainingStatus === "failed" ? `失败${a.statusReason ? `：${a.statusReason}` : ""}`
                      : a.provider === "volcengine-lipsync" ? "就绪中"
                      : a.consentStatus === "awaiting_user" ? "待真人授权"
                      : "训练中"}
```

⑧ 授权按钮条件（1499/1508 行）加 provider 守卫：

```tsx
                  {a.consentStatus === "awaiting_user" && a.provider !== "volcengine-lipsync" ? (
```

```tsx
                  {a.trainingStatus === "failed" && a.provider !== "volcengine-lipsync" ? (
```

⑨ consent 勾选框文案（1543 行）改：

```tsx
            <span>我是视频中的本人（或已获其授权），同意用这段视频生成 AI 配音口播视频</span>
```

⑩ 创建按钮文案（1553 行）与失败提示统一改名：

```tsx
            创建出镜形象
```

`handleCreateAvatar` 失败提示（953 行）同步改：

```ts
      setMessage(`创建出镜形象失败：${detail}`);
```

**改名联动已在 Step 1 ⑥ 覆盖测试侧**——UI 与测试必须同 commit 改完，否则既有用例红。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/dashboard.test.tsx`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add components/dashboard.tsx tests/dashboard.test.tsx
git commit -m "feat(avatar): 新建形象全面切换实拍对口型——免授权即建即就绪，UI文案与闸门同步

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 11: 成本预估——对口型 ¥ 计价（cost-estimate + script-confirm）

**Files:**
- Modify: `lib/cost-estimate.ts`
- Modify: `components/script-confirm.tsx:78-85,147-152`
- Test: `tests/cost-estimate.test.ts`

- [ ] **Step 1: 写失败测试（追加到 tests/cost-estimate.test.ts）**

```ts
  it("lipsync pricing: on-camera seconds billed at ¥1/min, off-camera TTS negligible", () => {
    const segments: ScriptSegment[] = [
      { index: 0, text: "大家好本周全场八八折", speakerIndex: 0, onCamera: true },   // 10 字 ≈ 2.2s
      { index: 1, text: "地址在建设路二十八号", speakerIndex: 0, onCamera: false },  // 10 字 ≈ 2.2s
    ];
    const est = estimateRenderCost(segments, 1, "lipsync");
    expect(est.onCameraSec).toBeGreaterThan(2);
    expect(est.totalCny).toBeCloseTo(est.onCameraSec / 60, 5);
    expect(est.totalUsd).toBe(0);
  });

  it("heygen pricing remains the default and unchanged", () => {
    const segments: ScriptSegment[] = [
      { index: 0, text: "大家好本周全场八八折", speakerIndex: 0, onCamera: true },
    ];
    const est = estimateRenderCost(segments, 1);
    expect(est.totalUsd).toBeGreaterThan(0);
    expect(est.totalCny).toBe(0);
  });
```

（若该文件 import 结构不同，按现状对齐；`ScriptSegment` 类型从 `@/lib/types` 引入。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/cost-estimate.test.ts`
Expected: FAIL — 第三参数/字段不存在

- [ ] **Step 3: 实现**

`lib/cost-estimate.ts` 全文替换为：

```ts
import type { ScriptSegment } from "@/lib/types";
import { estimateSegmentSeconds } from "@/lib/services/scene-derive";

/** HeyGen 定价（spec §2）：数字人视频 $0.0667/s；克隆声音 TTS ≈ $0.000333/s。 */
export const AVATAR_VIDEO_USD_PER_SEC = 0.0667;
export const CLONED_TTS_USD_PER_SEC = 0.000333;
/** 火山 MediaKit 对口型定价（2026-09 官网）：¥1/分钟按输出时长。豆包 TTS 字符费量级为几分钱/条，预估忽略。 */
export const LIPSYNC_VIDEO_CNY_PER_SEC = 1 / 60;

export interface RenderCostEstimate {
  onCameraSec: number;
  voiceoverSec: number;
  videoUsd: number;
  ttsUsd: number;
  totalUsd: number;
  /** 对口型计价（¥）：仅 pricing="lipsync" 时非零。 */
  totalCny: number;
}

/**
 * 确认卡片预估成本（spec §6.4）：按段字数 / 4.5 字每秒估算时长。
 * pricing="heygen"（默认）：出镜段计视频价、画外音段计 TTS 价（$）。
 * pricing="lipsync"：出镜段按 MediaKit ¥1/分钟；画外音段只有 TTS 字符费（微量，不计）。
 * 混合选择（老 HeyGen + 新对口型）按 heygen 估——保守高估，且无法预知段级说话人分配。
 * 未选形象 = 纯素材成片，零数字人成本。
 */
export function estimateRenderCost(
  segments: ScriptSegment[] | undefined,
  avatarCount = 1,
  pricing: "heygen" | "lipsync" = "heygen",
): RenderCostEstimate {
  if (avatarCount <= 0) {
    return { onCameraSec: 0, voiceoverSec: 0, videoUsd: 0, ttsUsd: 0, totalUsd: 0, totalCny: 0 };
  }
  let onCameraSec = 0;
  let voiceoverSec = 0;
  for (const seg of segments ?? []) {
    const sec = estimateSegmentSeconds(seg.text);
    if (seg.onCamera) onCameraSec += sec;
    else voiceoverSec += sec;
  }
  if (pricing === "lipsync") {
    const totalCny = onCameraSec * LIPSYNC_VIDEO_CNY_PER_SEC;
    return { onCameraSec, voiceoverSec, videoUsd: 0, ttsUsd: 0, totalUsd: 0, totalCny };
  }
  const videoUsd = onCameraSec * AVATAR_VIDEO_USD_PER_SEC;
  const ttsUsd = voiceoverSec * CLONED_TTS_USD_PER_SEC;
  return { onCameraSec, voiceoverSec, videoUsd, ttsUsd, totalUsd: videoUsd + ttsUsd, totalCny: 0 };
}
```

`components/script-confirm.tsx:80-85` 改：

```tsx
  // 数字人成本预估（spec §6.4）：跟随编辑中的口播稿实时重切 segments
  // （prev 命中保留出镜标记，与服务端 PATCH 重切同源）。计价币种随所选形象的
  // provider：全对口型 → ¥（MediaKit ¥1/分钟）；含 HeyGen → $（保守高估）。
  const selectedAvatars = avatars.filter((a) => avatarIds.includes(a.id));
  const pricing =
    selectedAvatars.length > 0 && selectedAvatars.every((a) => a.provider === "volcengine-lipsync")
      ? ("lipsync" as const)
      : ("heygen" as const);
  const costEstimate = useMemo(
    () => estimateRenderCost(deriveSegmentsFromVoiceover(voiceover, { prev: draft.segments }), avatarIds.length, pricing),
    [voiceover, draft.segments, avatarIds.length, pricing],
  );
```

147-152 行展示改：

```tsx
      {avatarIds.length > 0 ? (
        <p className="costHint" aria-label="成本预估">
          {pricing === "lipsync"
            ? `预计数字人成本约 ¥${costEstimate.totalCny.toFixed(2)}（对口型 ¥1/分钟 · 出镜 ${costEstimate.onCameraSec}s + 画外音 ${costEstimate.voiceoverSec}s · 消耗 1 次生成配额）`
            : `预计数字人成本约 $${costEstimate.totalUsd.toFixed(2)}（出镜 ${costEstimate.onCameraSec}s + 画外音 ${costEstimate.voiceoverSec}s · 消耗 1 次生成配额）`}
        </p>
      ) : null}
```

- [ ] **Step 4: 跑测试确认通过 + 相关组件测试回归**

Run: `npx vitest run tests/cost-estimate.test.ts tests/dashboard.test.tsx && npm run typecheck`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add lib/cost-estimate.ts components/script-confirm.tsx tests/cost-estimate.test.ts
git commit -m "feat(avatar): 成本预估支持对口型¥计价（全选对口型形象时按¥1/分钟显示）

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 12: 全量回归 + push 部署

- [ ] **Step 1: 全量本地验证（CI 同款）**

```bash
npm test && npm run typecheck && npm run lint && npx prisma validate && npm run build
```

Expected：全绿。**任何一项红都不许进下一步**——红了就回对应任务修。

- [ ] **Step 2: 安全自查（CLAUDE.md 清单过一遍）**

- [ ] 新 env 访问器只 trim 不 log；密钥不出现在任何响应/日志（grep 一遍新代码里的 `console.` 确认无密钥变量）
- [ ] `app/api/avatars/route.ts` 仍走 `getOwnerId()`，footage 属主校验在前
- [ ] presigned URL 900s/2h 短时效；产物 storageKey 用 provider task_id（不透明、不可猜）
- [ ] 新测试不含真实密钥

```bash
grep -rn "MEDIKIT_API_KEY\|DOUBAO_TTS_API_KEY" lib/ app/ worker/ | grep -v "process.env" || echo "OK: 密钥只经 env 访问器"
```

- [ ] **Step 3: Commit + push（main 直推，Zeabur 自动部署）**

```bash
git push origin main
```

---

## Task 13: Zeabur 生产配置 + 生产冒烟（用户配合）

- [ ] **Step 1: 配 Zeabur 环境变量（web 与 worker 两个服务都要配）**

| 变量 | 值 | 说明 |
|---|---|---|
| `AVATAR_PROVIDER` | `volcengine-lipsync` | 新形象创建切到对口型 |
| `MEDIKIT_API_KEY` | （API.txt 里那个） | MediaKit 对口型任务 |
| `DOUBAO_TTS_API_KEY` | （Task 0 新申请的） | 豆包语音合成 |
| `DOUBAO_TTS_VOICE` | `zh_female_vv_uranus_bigtts`（可先不配用默认；必须 2.0 音色） | 默认音色 |
| `HEYGEN_*` | 保留不动 | 老 HeyGen 形象仍可按 profile 渲染 |

> 注意：worker 服务是轮询/下载/转存的实际执行者，**必须**有这三个新变量；web 服务创建形象时只需要 AVATAR_PROVIDER + 校验逻辑（不直接调火山），但保持两端一致最省心。

- [ ] **Step 2: 生产冒烟（用户操作，~15 分钟）**

1. 打开生产站 → AI 分身区上传一段本人 30s 左右口播（可用 `video_20260905_113016.mp4` 同款）
2. 起名创建 → **不出现授权弹窗**、提示"无需授权"，约 10s 后卡片变"已就绪（实拍对口型）"
3. 走一条完整成片（选该形象 + 一段 45s 促销文案）→ 等待 talking_head + video_render
4. 验收：口型与新文案同步、画质可接受、字幕对齐、无水印
5. 观察项（Zeabur 日志 + 火山控制台账单）：MediaKit 计费时长是否与成片出镜时长一致；若中途有失败任务，确认失败是否计费（影响后续是否做 NonRetryable 分流）

- [ ] **Step 3: 冒烟过关后收尾**

- 记忆更新：`video-pipeline-overhaul-roadmap.md` 追加"2026-09-XX 对口型正式接入上线"条目
- 后续计划候选（另立项）：豆包声音复刻 onboarding（音色训练 HTTP 6561/2534906 + 授权协议）、MuseTalk 自托管免费档、阿里百炼/Vidu 兜底 provider

---

## 自检记录（计划作者自查，执行者跳过）

- **spec 覆盖：** 对口型创建（Task 9/10）、渲染（Task 5/8）、TTS 字级时间戳（Task 4/7/8）、闸门（Task 2/3/9）、混合 provider（Task 6/8/9）、成本显示（Task 11）、生产闭环（Task 0/13）✓
- **无占位符：** 所有代码块为完整可落盘内容；外部契约均标注文档来源/探针实证 ✓
- **类型一致性：** `createProviderByName`（Task 6 定义 → Task 8/9 消费）；`footageStorageKey`（Task 7 契约 → Task 5 实现 + Task 9 路由传入）；`words`（Task 7 契约 → Task 5 实现 → Task 8 透传）；`LIPSYNC_*` 常量（Task 2 定义 → Task 9/10 消费）；`providerResolver`（Task 8 定义）✓
- **已知编译依赖：** Task 5 引用 Task 7 的 `footageStorageKey`/`words` 契约——vitest（esbuild）不管类型能跑通，typecheck 在 Task 7 Step 4 收口 ✓
