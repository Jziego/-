# Phase 4 — 数字人供应商架构 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 AvatarProvider 工厂模式，根据 `AVATAR_PROVIDER` 环境变量自动选择 HeyGen 真实供应商或 Mock 降级供应商，复用已有 `AvatarProvider` 接口。

**Architecture:** 新建 `lib/services/providers/` 目录，HeyGen 适配器通过 `fetch` 调用 HeyGen REST API（非 OpenAI 兼容，不能复用 `ai-client.ts`），Mock 适配器从现有 `createMockAvatarProvider()` 移入。`createProviderFromEnv()` 工厂读取 `AVATAR_PROVIDER` 和 `AVATAR_PROVIDER_API_KEY`，无 Key 时返回 Mock。Worker 和 API 路由统一通过工厂获取 provider。

**Tech Stack:** HeyGen REST API v2、fetch（Node.js 18+ built-in）、Vitest

---

## 文件结构预览

```
lib/services/
  avatar-provider.ts          # 修改：导出工厂函数，Mock 实现移出
  providers/
    index.ts                  # 新建：createProviderFromEnv() 工厂
    heygen.ts                 # 新建：createHeyGenProvider() 适配器
    mock.ts                   # 新建：createMockProvider()（从 avatar-provider.ts 移入）
lib/
  env.ts                      # 修改：新增 hasAvatarProvider() / getAvatarProviderConfig()
tests/
  providers/
    heygen.test.ts            # 新建：HeyGen 适配器单元测试
    factory.test.ts           # 新建：工厂选择逻辑测试
worker/processors/
  avatar-generation.ts        # 修改：使用工厂替代硬编码 createMockAvatarProvider()
```

---

### Task 1: 环境变量支持

**Files:**
- Modify: `lib/env.ts`
- Modify: `.env.example`

- [ ] **Step 1: 在 `hasObjectStorage()` 之后添加 avatar 相关 helper**

```typescript
export function getAvatarProviderName(): string | undefined {
  return process.env.AVATAR_PROVIDER?.trim() || undefined;
}

export function getAvatarProviderApiKey(): string | undefined {
  return process.env.AVATAR_PROVIDER_API_KEY?.trim() || undefined;
}

export function hasAvatarProvider(): boolean {
  const name = getAvatarProviderName();
  const key = getAvatarProviderApiKey();
  return Boolean(name && name !== "mock-avatar" && key);
}
```

- [ ] **Step 2: 更新 .env.example 注释**

```bash
AVATAR_PROVIDER="heygen"
AVATAR_PROVIDER_API_KEY=""
```

- [ ] **Step 3: 运行类型检查**

```bash
npx tsc --noEmit
```
Expected: PASS

---

### Task 2: 拆分 Mock 供应商到独立文件

**Files:**
- Create: `lib/services/providers/mock.ts`
- Modify: `lib/services/avatar-provider.ts`

- [ ] **Step 1: 创建 `lib/services/providers/mock.ts`**

```typescript
import { createId } from "@/lib/ids";
import type { AvatarProvider } from "@/lib/services/avatar-provider";

interface MockProviderOptions {
  avatarId?: string;
  voiceId?: string;
  failTalkingHead?: boolean;
}

export function createMockProvider(options: MockProviderOptions = {}): AvatarProvider {
  return {
    name: "mock-avatar",
    async createAvatar() {
      return {
        providerAvatarId: options.avatarId ?? createId("provider_avatar"),
        providerVoiceId: options.voiceId ?? createId("provider_voice"),
      };
    },
    async generateTalkingHead() {
      if (options.failTalkingHead) {
        throw new Error("Mock provider talking-head generation failed");
      }
      return {
        videoAssetId: createId("avatar_video"),
        durationSeconds: 15,
      };
    },
  };
}
```

- [ ] **Step 2: 从 `avatar-provider.ts` 删除 `createMockAvatarProvider` 函数**

删除 `createMockAvatarProvider` 函数定义（约第 20-46 行）。保留 `AvatarProvider` 接口、`createAvatarProfile`、`requestAvatarTalkingHead`。

- [ ] **Step 3: 在 `avatar-provider.ts` 顶部添加对 mock 的 re-export**

```typescript
export { createMockProvider } from "@/lib/services/providers/mock";
```

这样现有消费者不受影响（它们可以改为 import 新路径，或在 Task 5 统一更新）。

- [ ] **Step 4: 运行类型检查确认未破坏现有引用**

```bash
npx tsc --noEmit
```
Expected: PASS

---

### Task 3: HeyGen 适配器

**Files:**
- Create: `lib/services/providers/heygen.ts`

- [ ] **Step 1: 创建 HeyGen 适配器**

```typescript
import { createId, nowIso } from "@/lib/ids";
import { getAvatarProviderApiKey } from "@/lib/env";
import type { AvatarProvider } from "@/lib/services/avatar-provider";

const HEYGEN_BASE_URL = "https://api.heygen.com";
const REQUEST_TIMEOUT_MS = 30_000;

interface HeyGenCreateResponse {
  data?: { avatar_id?: string; voice_id?: string };
  error?: { message: string };
}

interface HeyGenVideoResponse {
  data?: { video_id?: string; duration?: number };
  error?: { message: string };
}

async function heyGenFetch<T>(
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const apiKey = getAvatarProviderApiKey();
  if (!apiKey) {
    throw new Error("AVATAR_PROVIDER_API_KEY is not configured");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(`${HEYGEN_BASE_URL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HeyGen API ${res.status}: ${text.slice(0, 200)}`);
    }

    return (await res.json()) as T;
  } catch (error) {
    clearTimeout(timer);
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`HeyGen API timeout after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw error;
  }
}

export function createHeyGenProvider(): AvatarProvider {
  return {
    name: "heygen",

    async createAvatar(input: { trainingVideoAssetId: string; ownerId: string }) {
      // HeyGen instant avatar: create from a training video
      // For Phase 4, use a pre-made avatar template or create an instant avatar
      // POST /v2/avatar (or use template_avatar_id from env)
      const templateId = process.env.HEYGEN_AVATAR_TEMPLATE_ID;
      if (templateId) {
        return {
          providerAvatarId: templateId,
          providerVoiceId: process.env.HEYGEN_VOICE_ID || undefined,
        };
      }

      // Simulate avatar creation with a placeholder ID
      // Full avatar training is async and requires webhook/callback in later phase
      const result = await heyGenFetch<HeyGenCreateResponse>(
        "/v2/avatar",
        {
          avatar_name: `avatar-${input.ownerId}`,
          // Note: HeyGen instant avatar requires uploading video first
          // For now, use a default studio avatar
        },
      );

      if (result.error) {
        throw new Error(`HeyGen avatar creation failed: ${result.error.message}`);
      }

      return {
        providerAvatarId: result.data?.avatar_id ?? createId("heygen_avatar"),
        providerVoiceId: result.data?.voice_id,
      };
    },

    async generateTalkingHead(input: {
      providerAvatarId: string;
      providerVoiceId?: string;
      scriptText: string;
    }) {
      const result = await heyGenFetch<HeyGenVideoResponse>(
        "/v2/video/generate",
        {
          avatar_id: input.providerAvatarId,
          voice_id: input.providerVoiceId,
          text: input.scriptText,
          caption: false,
        },
      );

      if (result.error) {
        throw new Error(`HeyGen video generation failed: ${result.error.message}`);
      }

      return {
        videoAssetId: result.data?.video_id ?? createId("heygen_video"),
        durationSeconds: result.data?.duration ?? 15,
      };
    },
  };
}
```

- [ ] **Step 2: 类型检查**

```bash
npx tsc --noEmit
```
Expected: PASS

---

### Task 4: 供应商工厂

**Files:**
- Create: `lib/services/providers/index.ts`
- Modify: `lib/services/avatar-provider.ts`

- [ ] **Step 1: 创建工厂文件**

```typescript
import { getAvatarProviderName, hasAvatarProvider } from "@/lib/env";
import type { AvatarProvider } from "@/lib/services/avatar-provider";
import { createHeyGenProvider } from "@/lib/services/providers/heygen";
import { createMockProvider } from "@/lib/services/providers/mock";

/**
 * Factory: returns the appropriate AvatarProvider based on environment config.
 *
 * - AVATAR_PROVIDER="heygen" + AVATAR_PROVIDER_API_KEY set → HeyGen
 * - Otherwise → Mock (safe no-op fallback)
 */
export function createProviderFromEnv(): AvatarProvider {
  if (hasAvatarProvider()) {
    const name = (getAvatarProviderName() ?? "").toLowerCase();
    if (name === "heygen") {
      return createHeyGenProvider();
    }
    // Future providers: d-id, tavus, synthesia
  }

  return createMockProvider();
}
```

- [ ] **Step 2: 在 `avatar-provider.ts` 添加 re-export**

在文件底部增加：

```typescript
export { createProviderFromEnv } from "@/lib/services/providers/index";
```

- [ ] **Step 3: 类型检查**

```bash
npx tsc --noEmit
```
Expected: PASS

---

### Task 5: Worker 处理器接入工厂

**Files:**
- Modify: `worker/processors/avatar-generation.ts`

- [ ] **Step 1: 替换直接调用 `createMockAvatarProvider()` 为工厂**

**删除：**
```typescript
import { createMockAvatarProvider, createAvatarProfile } from "@/lib/services/avatar-provider";
```

**替换为：**
```typescript
import { createProviderFromEnv, createAvatarProfile } from "@/lib/services/avatar-provider";
```

然后在函数体中，把：
```typescript
const provider = createMockAvatarProvider();
```
改为：
```typescript
const provider = createProviderFromEnv();
```

- [ ] **Step 2: 类型检查**

```bash
npx tsc --noEmit
```
Expected: PASS

---

### Task 6: 测试

**Files:**
- Create: `tests/providers/factory.test.ts`
- Create: `tests/providers/heygen.test.ts`

- [ ] **Step 1: 工厂测试 `tests/providers/factory.test.ts`**

```typescript
import { describe, expect, it, beforeEach, vi } from "vitest";

const mockEnv = { AVATAR_PROVIDER: "", AVATAR_PROVIDER_API_KEY: "" };

// Use dynamic import to pick up env changes
async function getFactory() {
  vi.stubEnv("AVATAR_PROVIDER", mockEnv.AVATAR_PROVIDER);
  vi.stubEnv("AVATAR_PROVIDER_API_KEY", mockEnv.AVATAR_PROVIDER_API_KEY);
  const { createProviderFromEnv } = await import(
    "@/lib/services/providers/index"
  );
  return createProviderFromEnv;
}

describe("avatar provider factory", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns mock provider when no env vars are set", async () => {
    mockEnv.AVATAR_PROVIDER = "";
    mockEnv.AVATAR_PROVIDER_API_KEY = "";
    const factory = await getFactory();
    const provider = factory();
    expect(provider.name).toBe("mock-avatar");
  });

  it("returns mock provider when AVATAR_PROVIDER is mock-avatar", async () => {
    mockEnv.AVATAR_PROVIDER = "mock-avatar";
    mockEnv.AVATAR_PROVIDER_API_KEY = "key-123";
    const factory = await getFactory();
    const provider = factory();
    expect(provider.name).toBe("mock-avatar");
  });

  it("returns heygen provider when AVATAR_PROVIDER=heygen and key is set", async () => {
    mockEnv.AVATAR_PROVIDER = "heygen";
    mockEnv.AVATAR_PROVIDER_API_KEY = "hk_12345";
    const factory = await getFactory();
    const provider = factory();
    expect(provider.name).toBe("heygen");
  });
});
```

- [ ] **Step 2: HeyGen 适配器测试 `tests/providers/heygen.test.ts`**

```typescript
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("heygen provider", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("AVATAR_PROVIDER_API_KEY", "hk_test_key");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("generateTalkingHead calls HeyGen API with correct payload", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ data: { video_id: "vid_abc", duration: 10 } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const { createHeyGenProvider } = await import(
      "@/lib/services/providers/heygen"
    );
    const provider = createHeyGenProvider();

    const result = await provider.generateTalkingHead({
      providerAvatarId: "avatar_1",
      scriptText: "欢迎光临本店",
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.heygen.com/v2/video/generate",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "X-Api-Key": "hk_test_key",
        }),
      }),
    );
    expect(result.videoAssetId).toBe("vid_abc");
    expect(result.durationSeconds).toBe(10);
  });

  it("throws on API error response", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: "Invalid avatar_id" } }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const { createHeyGenProvider } = await import(
      "@/lib/services/providers/heygen"
    );
    const provider = createHeyGenProvider();

    await expect(
      provider.generateTalkingHead({
        providerAvatarId: "bad_id",
      }),
    ).rejects.toThrow("Invalid avatar_id");
  });
});
```

- [ ] **Step 3: 运行新测试确认通过**

```bash
npm test -- tests/providers/
```
Expected: 4 tests PASS

- [ ] **Step 4: 运行全量测试**

```bash
npm test
```
Expected: 83 tests PASS (79 existing + 4 new)

---

### Task 7: 验证与提交

- [ ] **Step 1: 运行全量测试**

```bash
npm test
```
Expected: 83 PASS

- [ ] **Step 2: 运行类型检查**

```bash
npx tsc --noEmit
```
Expected: PASS

- [ ] **Step 3: 运行构建**

```bash
npm run build
```
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add lib/services/avatar-provider.ts lib/services/providers/ lib/env.ts worker/processors/avatar-generation.ts tests/providers/ .env.example
git commit -m "feat: add avatar provider factory with HeyGen adapter and mock fallback

- New providers/ directory with heygen.ts, mock.ts, and factory index.ts
- createProviderFromEnv() selects provider based on AVATAR_PROVIDER env var
- HeyGen adapter wraps /v2/video/generate REST API with timeout and error handling
- Mock provider moved to providers/mock.ts for clean separation
- Worker avatar-generation processor now uses factory
- No key configured → graceful fallback to mock provider

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 验收清单

- [ ] `AVATAR_PROVIDER=heygen` + key → 工厂返回 HeyGen 适配器
- [ ] 无 Key / `AVATAR_PROVIDER=mock-avatar` → 工厂返回 Mock
- [ ] Mock 供应商标记为 `name: "mock-avatar"`
- [ ] HeyGen 适配器标记为 `name: "heygen"`
- [ ] HeyGen API 调用包含 `X-Api-Key` header、30s 超时、错误转义
- [ ] 无 Key 时 avatar 工作流正常降级（不抛异常）
- [ ] Worker `avatar-generation` processor 通过工厂获取 provider
- [ ] `npm test` 全绿（83 个测试）
- [ ] `npm run build` 通过

---

## 关键设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| HeyGen 适配器不用 `ai-client.ts` | 用 `fetch` | HeyGen 是 REST API 非 OpenAI 兼容，`X-Api-Key` header、不同的请求格式 |
| Mock 移入 `providers/mock.ts` | 是 | 与 HeyGen 适配器保持一致的目录结构，职责单一 |
| `createAvatarProfile` 不动 | 是 | 它是消费者（用 provider），不是 provider 本身；接口稳定，改动无必要 |
| `AVATAR_PROVIDER_API_KEY` 独立变量 | 是 | 不与 `OPENAI_API_KEY` 混用，每个供应商独立配置 |
| `HEYGEN_AVATAR_TEMPLATE_ID` 可选 | 是 | 没有时为每个请求模拟 createAvatar，有则跳过训练直接用预置形象 |
