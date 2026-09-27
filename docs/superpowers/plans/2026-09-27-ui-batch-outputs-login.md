# 第三批次实施计划 —— 产物管理 UI + 登录 OTP

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 产物区改竖屏网格卡片并支持删除（DELETE 端点 + R2 清理）；登录从 magic link 改为 6 位邮箱验证码（OTP），登录/verify 页深色化。

**Architecture:** 产物删除复用素材删除模式（ownerId 归属校验 → DB 删除 → R2 best-effort 清理）；OTP 走 NextAuth v5 EmailProvider 的 `generateVerificationToken` 换成 6 位数字（哈希存储/一次性/自动建用户内置），middleware 给 `/api/auth/callback/email` 补专项限流（现状零限流，上 OTP 前必堵）；UI 不引入 shadcn 体系，直接 Tailwind 深色对齐主站（`#0a0a0a`）。

**Tech Stack:** Next.js 16 App Router / React 19 / NextAuth v5 / Prisma 7 / Vitest / Tailwind 4（登录页）+ globals.css 自定义类（dashboard）

---

### Task 1: RenderRepository.deleteOutput（数据层）

**Files:**
- Modify: `lib/repositories/types.ts`（RenderRepository 接口，`listOutputsByOwner` 声明之后）
- Modify: `lib/repositories/memory.ts`（`listOutputsByOwner` 实现之后）
- Modify: `lib/repositories/prisma.ts`（`listOutputsByOwner` 实现之后）
- Test: `tests/repositories/render-output.test.ts`（新建）

- [ ] **Step 1: 写失败测试**

新建 `tests/repositories/render-output.test.ts`：

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryRenderRepository } from "@/lib/repositories/memory";
import { resetRuntimeStateForTests } from "@/lib/runtime-store";
import type { VideoOutput } from "@/lib/types";

function sampleOutput(id: string, ownerId = "demo_user"): VideoOutput {
  return {
    id,
    ownerId,
    renderProjectId: null,
    storageKey: `outputs/${id}.mp4`,
    aspectRatio: "9:16",
    durationSeconds: 45,
    kind: "talking_head",
    status: "completed",
    createdAt: new Date().toISOString(),
  };
}

describe("MemoryRenderRepository.deleteOutput", () => {
  beforeEach(() => {
    resetRuntimeStateForTests();
  });

  it("deletes an existing output and returns true", async () => {
    const repo = new MemoryRenderRepository();
    await repo.createOutput(sampleOutput("out_1"));

    expect(await repo.deleteOutput("out_1")).toBe(true);
    expect(await repo.findOutputById("out_1")).toBeNull();
  });

  it("returns false for a missing output", async () => {
    const repo = new MemoryRenderRepository();
    expect(await repo.deleteOutput("out_missing")).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/repositories/render-output.test.ts`
Expected: FAIL（`repo.deleteOutput is not a function`）

- [ ] **Step 3: 接口 + 双实现**

`lib/repositories/types.ts` —— RenderRepository 接口 `listOutputsByOwner` 声明后加：

```ts
  /** 删除产物记录；不存在返回 false。存储清理由调用方负责（best-effort）。 */
  deleteOutput(id: string): Promise<boolean>;
```

`lib/repositories/memory.ts` —— MemoryRenderRepository 的 `listOutputsByOwner` 实现后加：

```ts
  async deleteOutput(id: string): Promise<boolean> {
    const state = getRuntimeState();
    const index = state.outputs.findIndex((output) => output.id === id);
    if (index === -1) return false;
    state.outputs.splice(index, 1);
    return true;
  }
```

`lib/repositories/prisma.ts` —— PrismaRenderRepository 的 `listOutputsByOwner` 实现后加：

```ts
  async deleteOutput(id: string): Promise<boolean> {
    const result = await this.prisma.videoOutput.deleteMany({ where: { id } });
    return result.count > 0;
  }
```

（用 `deleteMany` 而非 `delete`：不存在时返回 count=0 而不是抛 P2025，与接口语义一致。）

- [ ] **Step 4: 跑测试确认通过 + 类型检查**

Run: `npx vitest run tests/repositories/render-output.test.ts && npm run typecheck`
Expected: 测试 PASS；typecheck 无错

- [ ] **Step 5: Commit**

```bash
git add lib/repositories/types.ts lib/repositories/memory.ts lib/repositories/prisma.ts tests/repositories/render-output.test.ts
git commit -m "feat(render): RenderRepository 新增 deleteOutput（memory+prisma 双实现）"
```

---

### Task 2: 产物删除端点 DELETE /api/render-projects/outputs/[id]

**Files:**
- Create: `app/api/render-projects/outputs/[id]/route.ts`
- Test: `tests/api/render-outputs-delete.test.ts`（新建）

参照模式：`tests/api/assets-delete.test.ts`（归属校验 404 + R2 清理断言）。

- [ ] **Step 1: 写失败测试**

新建 `tests/api/render-outputs-delete.test.ts`：

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE } from "@/app/api/render-projects/outputs/[id]/route";
import * as repositories from "@/lib/repositories";
import { MemoryRenderRepository } from "@/lib/repositories/memory";
import { resetRuntimeStateForTests } from "@/lib/runtime-store";
import * as storage from "@/lib/storage";
import type { VideoOutput } from "@/lib/types";

function sampleOutput(overrides: Partial<VideoOutput> = {}): VideoOutput {
  return {
    id: "out_1",
    ownerId: "demo_user",
    renderProjectId: null,
    storageKey: "outputs/out_1.mp4",
    aspectRatio: "9:16",
    durationSeconds: 45,
    kind: "talking_head",
    status: "completed",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function callDelete(id: string): Promise<Response> {
  const req = new Request(`http://localhost/api/render-projects/outputs/${id}`, { method: "DELETE" });
  return DELETE(req, { params: Promise.resolve({ id }) });
}

describe("DELETE /api/render-projects/outputs/[id]", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetRuntimeStateForTests();
    vi.spyOn(repositories, "getRenderRepository").mockImplementation(() => new MemoryRenderRepository());
    vi.spyOn(storage, "deleteObject").mockResolvedValue(undefined);
  });

  it("returns 404 when the output does not exist", async () => {
    const res = await callDelete("out_missing");
    expect(res.status).toBe(404);
  });

  it("returns 404 when the output belongs to another owner (IDOR guard)", async () => {
    const repo = new MemoryRenderRepository();
    await repo.createOutput(sampleOutput({ id: "out_foreign", ownerId: "other_user" }));

    const res = await callDelete("out_foreign");
    expect(res.status).toBe(404);
    expect(await repo.findOutputById("out_foreign")).not.toBeNull();
  });

  it("deletes the owner's output and cleans storage incl. cover", async () => {
    const repo = new MemoryRenderRepository();
    await repo.createOutput(sampleOutput({ id: "out_mine", coverStorageKey: "outputs/out_mine.jpg" }));

    const res = await callDelete("out_mine");

    expect(res.status).toBe(200);
    expect(await repo.findOutputById("out_mine")).toBeNull();
    expect(storage.deleteObject).toHaveBeenCalledWith("outputs/out_1.mp4");
    expect(storage.deleteObject).toHaveBeenCalledWith("outputs/out_mine.jpg");
  });

  it("still returns 200 when R2 cleanup fails (best-effort)", async () => {
    const repo = new MemoryRenderRepository();
    await repo.createOutput(sampleOutput({ id: "out_r2fail" }));
    vi.spyOn(storage, "deleteObject").mockRejectedValue(new Error("R2 down"));

    const res = await callDelete("out_r2fail");

    expect(res.status).toBe(200);
    expect(await repo.findOutputById("out_r2fail")).toBeNull();
  });
});
```

注意：测试 ownerId 用 `demo_user` —— 测试环境 `getOwnerId()` 在 demo 模式回退 demoOwnerId（与 assets-delete 测试同款前提）。若该测试文件里现有惯例不同，以 `tests/api/assets-delete.test.ts` 为准。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/api/render-outputs-delete.test.ts`
Expected: FAIL（模块不存在 `Cannot find module '@/app/api/render-projects/outputs/[id]/route'`）

- [ ] **Step 3: 实现端点**

新建 `app/api/render-projects/outputs/[id]/route.ts`：

```ts
import { jsonError, jsonOk } from "@/lib/api-response";
import { getOwnerId } from "@/lib/auth-helpers";
import { applyRateLimit } from "@/lib/rate-limit";
import { getRenderRepository } from "@/lib/repositories";
import { deleteObject } from "@/lib/storage";

/**
 * DELETE /api/render-projects/outputs/[id]
 *
 * Owner-scoped (IDOR-safe): missing or foreign ids both 404 to avoid existence
 * leaks. The DB row is deleted first; R2 cleanup is best-effort — same
 * trade-off as asset deletion: a delete button that fails on transient storage
 * errors is worse than an orphaned object.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ownerId = await getOwnerId();
  const limited = await applyRateLimit(request, ownerId);
  if (limited) return limited;

  const { id } = await params;
  const repo = getRenderRepository();
  const output = await repo.findOutputById(id);
  if (!output || output.ownerId !== ownerId) {
    return jsonError("产物不存在", 404);
  }

  await repo.deleteOutput(id);

  try {
    await deleteObject(output.storageKey);
    if (output.coverStorageKey) {
      await deleteObject(output.coverStorageKey);
    }
  } catch (err) {
    console.warn(
      `[outputs] R2 cleanup failed for ${id}:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  return jsonOk({ deleted: true });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/api/render-outputs-delete.test.ts`
Expected: 4 个用例 PASS

- [ ] **Step 5: Commit**

```bash
git add app/api/render-projects/outputs/\[id\]/route.ts tests/api/render-outputs-delete.test.ts
git commit -m "feat(outputs): 产物删除端点 DELETE /api/render-projects/outputs/[id]——归属校验+DB 删除+R2 best-effort 清理"
```

---

### Task 3: 产物网格卡片 UI

**Files:**
- Modify: `lib/api-client.ts`（`fetchVideoOutputUrl` 之后加 `deleteVideoOutputApi`）
- Create: `components/video-output-card.tsx`（从 dashboard.tsx 抽离并网格化）
- Modify: `components/dashboard.tsx`（删除旧内部 VideoOutputCard，import 新组件，`#render-outputs` 容器换 grid）
- Modify: `app/globals.css`（新增 outputGrid/outputCard 等样式）
- Test: `tests/render-output-card.test.tsx`（新建）

- [ ] **Step 1: 写失败测试**

新建 `tests/render-output-card.test.tsx`：

```tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { VideoOutputCard } from "@/components/video-output-card";
import type { VideoOutput } from "@/lib/types";

vi.mock("@/lib/api-client", () => ({
  fetchVideoOutputUrl: vi.fn(async () => "https://cdn.example.com/out_1.mp4"),
  deleteVideoOutputApi: vi.fn(async () => {}),
}));

import { deleteVideoOutputApi } from "@/lib/api-client";

function sampleOutput(overrides: Partial<VideoOutput> = {}): VideoOutput {
  return {
    id: "out_1",
    ownerId: "demo_user",
    renderProjectId: null,
    storageKey: "outputs/out_1.mp4",
    aspectRatio: "9:16",
    durationSeconds: 45,
    kind: "talking_head",
    status: "completed",
    createdAt: "2026-09-27T06:32:00.000Z",
    ...overrides,
  };
}

function renderCard(output: VideoOutput) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <VideoOutputCard output={output} />
    </QueryClientProvider>,
  );
}

describe("VideoOutputCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows kind label, formatted date and duration", async () => {
    renderCard(sampleOutput());
    expect(await screen.findByText("口播成片")).toBeTruthy();
    expect(screen.getByText(/45s/)).toBeTruthy();
    expect(screen.getByText(/09-27/)).toBeTruthy();
  });

  it("deletes after confirm and invalidates the outputs query", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderCard(sampleOutput());

    fireEvent.click(await screen.findByRole("button", { name: /删除成片 out_1/ }));

    await waitFor(() => expect(deleteVideoOutputApi).toHaveBeenCalledWith("out_1"));
  });

  it("does not delete when confirm is cancelled", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    renderCard(sampleOutput());

    fireEvent.click(await screen.findByRole("button", { name: /删除成片 out_1/ }));

    expect(deleteVideoOutputApi).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/render-output-card.test.tsx`
Expected: FAIL（`Cannot find module '@/components/video-output-card'`）

- [ ] **Step 3: 实现**

`lib/api-client.ts` —— `fetchVideoOutputUrl` 之后加：

```ts
export async function deleteVideoOutputApi(id: string): Promise<void> {
  await api<{ deleted: boolean }>(`/api/render-projects/outputs/${id}`, { method: "DELETE" });
}
```

新建 `components/video-output-card.tsx`：

```tsx
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deleteVideoOutputApi, fetchVideoOutputUrl } from "@/lib/api-client";
import type { VideoOutput, VideoOutputKind } from "@/lib/types";

const KIND_LABELS: Record<VideoOutputKind, string> = {
  talking_head: "口播成片",
  segmented_voice: "分段口播",
  final_composite: "素材成片",
  slideshow: "幻灯片",
};

function formatCreatedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function VideoOutputCard({ output }: { output: VideoOutput }) {
  const queryClient = useQueryClient();
  // Presigned URLs are short-lived (~15min). Cache ~10min so switching tabs
  // doesn't re-hit the route, and let it refresh after expiry.
  const { data: url, isPending, isError } = useQuery({
    queryKey: ["output-url", output.id],
    queryFn: () => fetchVideoOutputUrl(output.id),
    staleTime: 10 * 60 * 1000,
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteVideoOutputApi(output.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["render-outputs"] });
    },
  });

  function handleDelete() {
    // 与素材/分身删除一致：window.confirm（确认弹窗组件是已拍板的延期打磨项）
    if (!window.confirm("确认删除该成片？该操作不可撤销。")) return;
    deleteMutation.mutate();
  }

  return (
    <div className="outputCard">
      {isPending ? (
        <div className="previewLoading">
          <span className="spinner" aria-hidden="true" />
          加载中…
        </div>
      ) : isError ? (
        <div className="previewLoading">预览链接生成失败</div>
      ) : (
        // 竖屏网格卡直接用 video 首帧当封面（与素材缩略图同款 preload=metadata），
        // 不引入单独的封面 URL 端点。
        <video className="outputCover" controls preload="metadata" src={url} />
      )}
      <div className="outputMeta">
        <strong>{KIND_LABELS[output.kind]}</strong>
        <span>
          {formatCreatedAt(output.createdAt)} · {output.durationSeconds}s
        </span>
      </div>
      <div className="outputActions">
        {url ? (
          <a className="secondaryButton previewDownload" download href={url} rel="noopener noreferrer" target="_blank">
            下载
          </a>
        ) : null}
        <button
          type="button"
          className="secondaryButton"
          aria-label={`删除成片 ${output.id}`}
          onClick={handleDelete}
          disabled={deleteMutation.isPending}
        >
          {deleteMutation.isPending ? "删除中…" : "删除"}
        </button>
      </div>
      {deleteMutation.isError ? <p className="outputError">删除失败，请稍后重试。</p> : null}
    </div>
  );
}
```

`components/dashboard.tsx`：
- 顶部 import 加 `import { VideoOutputCard } from "@/components/video-output-card";`
- `#render-outputs` 区块的 `<div className="timeline">` 改为 `<div className="outputGrid">`（约 L1827）
- **删除文件末尾旧的内部 `function VideoOutputCard`**（约 L1867-1903）

`app/globals.css` —— `.previewDownload` 规则（约 L964）之后新增：

```css
/* ── Render output grid（第三批次：产物管理 UI）── */
.outputGrid {
  display: grid;
  gap: 16px;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
}

.outputCard {
  background: rgba(255, 255, 255, 0.025);
  border: 1px solid var(--border);
  border-radius: 12px;
  display: grid;
  gap: 10px;
  padding: 12px;
}

.outputCover {
  aspect-ratio: 9 / 16;
  background: #000;
  border-radius: 10px;
  display: block;
  object-fit: cover;
  width: 100%;
}

.outputMeta {
  display: grid;
  gap: 2px;
}

.outputMeta span {
  color: var(--muted);
  font-size: 12px;
}

.outputActions {
  display: flex;
  gap: 8px;
}

.outputError {
  color: #f87171;
  font-size: 12px;
  margin: 0;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/render-output-card.test.tsx tests/dashboard.test.tsx`
Expected: PASS（dashboard 现有测试不回归——其渲染路径若引用旧卡片区块需同步更新，以实际断言为准微调）

- [ ] **Step 5: Commit**

```bash
git add lib/api-client.ts components/video-output-card.tsx components/dashboard.tsx app/globals.css tests/render-output-card.test.tsx
git commit -m "feat(outputs): 产物区改竖屏网格卡片——类型徽标+日期+下载/删除，VideoOutputCard 抽离独立组件"
```

---

### Task 4: OTP 后端（6 位验证码 + 邮件模板）

**Files:**
- Create: `lib/auth/otp.ts`
- Modify: `lib/auth/magic-link-email.ts`（新增 `renderOtpEmail`）
- Modify: `auth.ts`（EmailProvider 三项配置）
- Test: `tests/otp.test.ts`（新建）、`tests/magic-link-email.test.ts`（改造）

- [ ] **Step 1: 写失败测试**

新建 `tests/otp.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { generateOtpCode } from "@/lib/auth/otp";

describe("generateOtpCode", () => {
  it("returns a 6-digit numeric string (zero-padded)", () => {
    for (let i = 0; i < 100; i++) {
      const code = generateOtpCode();
      expect(code).toMatch(/^\d{6}$/);
    }
  });
});
```

`tests/magic-link-email.test.ts` —— 保留现有 `renderMagicLinkEmail` 用例，新增：

```ts
  it("renderOtpEmail contains the code, fallback link and 10-minute notice", () => {
    const html = renderOtpEmail("123456", "https://app.example.com/api/auth/callback/email?token=123456");
    expect(html).toContain("123456");
    expect(html).toContain("https://app.example.com/api/auth/callback/email?token=123456");
    expect(html).toContain("10 分钟");
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/otp.test.ts tests/magic-link-email.test.ts`
Expected: FAIL（`@/lib/auth/otp` 不存在；`renderOtpEmail is not a function`）

- [ ] **Step 3: 实现**

新建 `lib/auth/otp.ts`：

```ts
import { randomInt } from "node:crypto";

/**
 * 6 位数字邮箱验证码（前导零保留）。
 * crypto.randomInt 均匀分布 [0, 1e6)；爆破防护不在此处——
 * 见 middleware 对 /api/auth/callback/email 的尝试限流（rateLimitOtpAttempt）。
 */
export function generateOtpCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}
```

`lib/auth/magic-link-email.ts` —— 文件末尾新增（`renderMagicLinkEmail` 保留给兜底链接语义参考，可留可删；若全项目仅剩 auth.ts 引用且本任务后不再使用则删除并同步清理其测试）：

```ts
/**
 * OTP 验证码邮件：大字验证码为主，同 token 的 magic link 作兜底
 *（两种消费方式等效——callback/email 只认 token）。
 */
export function renderOtpEmail(code: string, url: string): string {
  return [
    `<p>你的登录验证码：</p>`,
    `<p style="font-size:32px;font-weight:bold;letter-spacing:8px;margin:16px 0;">${code}</p>`,
    `<p>验证码 10 分钟内有效，请勿告知他人。</p>`,
    `<p>也可以<a href="${url}">点击此处直接登录</a>（与输入验证码等效）。</p>`,
    `<p>若非本人操作，请忽略本邮件。</p>`,
  ].join("");
}
```

`auth.ts` —— 替换现有 `EmailProvider({...})` 块为：

```ts
    EmailProvider({
      server: {},
      from: getEmailFrom(),
      // OTP 10 分钟有效（默认 24h 对验证码过长）；verify 页文案与此保持一致。
      maxAge: 10 * 60,
      // 6 位数字验证码替代 32 位随机串；哈希存储/一次性消费/自动建用户均为
      // NextAuth 内置流程，不变。爆破防护：middleware 对 callback/email 限流。
      generateVerificationToken: async () => generateOtpCode(),
      sendVerificationRequest: async ({ identifier: email, token, url }) => {
        if (!getResendApiKey()) {
          // Dev fallback: log the OTP code when Resend is not configured.
          console.log(`[auth] otp dev fallback (no RESEND_API_KEY): ${email} → ${token}`);
          return;
        }
        await getResend().emails.send({
          from: getEmailFrom(),
          to: email,
          subject: `登录验证码：${token}`,
          html: renderOtpEmail(token, url),
        });
      },
    }),
```

import 区更新：`import { generateOtpCode } from "@/lib/auth/otp";`，`renderMagicLinkEmail` 的 import 改为 `renderOtpEmail`（若旧函数删除）。

- [ ] **Step 4: 跑测试确认通过 + 类型检查**

Run: `npx vitest run tests/otp.test.ts tests/magic-link-email.test.ts tests/login-actions.test.ts tests/auth-session-ttl.test.ts && npm run typecheck`
Expected: PASS（login-actions/auth-session-ttl 不回归）

- [ ] **Step 5: Commit**

```bash
git add lib/auth/otp.ts lib/auth/magic-link-email.ts auth.ts tests/otp.test.ts tests/magic-link-email.test.ts
git commit -m "feat(auth): EmailProvider 改 6 位 OTP——generateVerificationToken+10min maxAge+验证码邮件（附 magic link 兜底）"
```

---

### Task 5: OTP 尝试限流（middleware 补安全缺口）

**Files:**
- Modify: `lib/rate-limit.ts`（`rateLimitLogin` 之后加 `rateLimitOtpAttempt`）
- Modify: `middleware.ts`（公开路径分支拆出 `/api/auth/callback/email` 专项限流）
- Test: `tests/rate-limit.test.ts`（增补用例）

- [ ] **Step 1: 写失败测试**

`tests/rate-limit.test.ts` 增补（参照文件内现有 `_resetMemoryStore` 隔离模式）：

```ts
  describe("rateLimitOtpAttempt", () => {
    it("allows up to 5 attempts per email in 10min, then blocks", async () => {
      for (let i = 0; i < 5; i++) {
        expect(await rateLimitOtpAttempt("1.2.3.4", "a@b.com")).toBe(true);
      }
      expect(await rateLimitOtpAttempt("1.2.3.4", "a@b.com")).toBe(false);
    });

    it("email bucket is case/whitespace-insensitive", async () => {
      for (let i = 0; i < 5; i++) {
        await rateLimitOtpAttempt("1.2.3.4", "A@b.com ");
      }
      expect(await rateLimitOtpAttempt("1.2.3.4", "a@b.com")).toBe(false);
    });

    it("allows up to 20 attempts per IP across different emails, then blocks", async () => {
      for (let i = 0; i < 20; i++) {
        expect(await rateLimitOtpAttempt("5.6.7.8", `user${i}@x.com`)).toBe(true);
      }
      expect(await rateLimitOtpAttempt("5.6.7.8", "another@x.com")).toBe(false);
    });
  });
```

（import 区加 `rateLimitOtpAttempt`；每个 describe/it 前确保 `_resetMemoryStore()` 隔离，跟随文件现有惯例。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/rate-limit.test.ts`
Expected: FAIL（`rateLimitOtpAttempt is not a function`）

- [ ] **Step 3: 实现**

`lib/rate-limit.ts` —— `LOGIN_EMAIL_PER_MINUTE` 常量附近加：

```ts
const OTP_EMAIL_ATTEMPTS: RateLimitConfig = { windowSeconds: 600, maxRequests: 5 };
const OTP_IP_ATTEMPTS: RateLimitConfig = { windowSeconds: 600, maxRequests: 20 };
```

`rateLimitLogin` 之后加：

```ts
/**
 * OTP 校验尝试限流（middleware 对 /api/auth/callback/email 调用）。
 * 6 位码空间仅 1e6：每邮箱 10 分钟 5 次（单码成功率 5e-6），每 IP 10 分钟 20 次。
 * 进入即计数（成功也计）——NextAuth 一次性消费 token 天然防重放，
 * 正常用户 1-2 次内成功，5 次硬顶不构成误伤。
 * 与全局限流同一后端：无 Redis 时 demo 走 memory / production fail-open（既有口径）。
 */
export async function rateLimitOtpAttempt(ip: string, email: string): Promise<boolean> {
  const normalized = normalizeEmail(email);
  const [emailLimit, ipLimit] = await Promise.all([
    checkLimit(`otp:try:email:${normalized}`, OTP_EMAIL_ATTEMPTS, false),
    checkLimit(`otp:try:ip:${ip}`, OTP_IP_ATTEMPTS, false),
  ]);
  return emailLimit.allowed && ipLimit.allowed;
}
```

`middleware.ts` —— 公开路径分支（现 L19-26）拆开，`/api/auth` 单独处理：

```ts
  // Public paths (accessible without login)
  if (pathname.startsWith("/api/auth")) {
    // OTP 校验端点爆破防护：此路径在 L0 IP 限流之前 return（公开路径），
    // 6 位码若无尝试上限可在线爆破——必须专项限流。
    if (pathname === "/api/auth/callback/email") {
      const ip = getClientIp(req.headers);
      const email = req.nextUrl.searchParams.get("email") ?? "";
      if (email && !(await rateLimitOtpAttempt(ip, email))) {
        return NextResponse.json(
          { error: "rate_limited", message: "尝试次数过多，请 10 分钟后再试" },
          { status: 429 },
        );
      }
    }
    return NextResponse.next();
  }
  if (
    pathname === "/api/health" ||
    pathname.startsWith("/login") ||
    pathname.startsWith("/_next")
  ) {
    return NextResponse.next();
  }
```

import 区更新：`rateLimitOtpAttempt` 加入 `from "@/lib/rate-limit"`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/rate-limit.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/rate-limit.ts middleware.ts tests/rate-limit.test.ts
git commit -m "feat(auth): /api/auth/callback/email 专项限流——每邮箱 5 次/10min + 每 IP 20 次/10min，堵 OTP 爆破缺口"
```

---

### Task 6: 登录页 + verify 页 UI（深色 + 两段式输码）

**Files:**
- Modify: `app/login/actions.ts`（`signIn` 改 `redirect: false`，由前端显式跳转）
- Modify: `app/login/page.tsx`（深色重构 + 文案 + error 显示 + 成功跳 verify）
- Modify: `app/login/verify/page.tsx`（两段式输码）
- Test: `tests/login-actions.test.ts`（更新断言）、`tests/login-verify.test.tsx`（新建）

- [ ] **Step 1: 写/改失败测试**

`tests/login-actions.test.ts` —— 更新 signIn 断言：调用参数从 `{ email, redirectTo: "/" }` 变为 `{ email, redirect: false }`（读现有用例逐处同步）。

新建 `tests/login-verify.test.tsx`：

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import VerifyPage from "@/app/login/verify/page";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("email=a%40b.com"),
}));

vi.mock("@/app/login/actions", () => ({
  sendMagicLink: vi.fn(async () => ({ success: true, message: "ok" })),
}));

describe("/login/verify OTP page", () => {
  it("filters non-digits and enables submit only at 6 digits", () => {
    render(<VerifyPage />);
    const input = screen.getByPlaceholderText("6 位验证码") as HTMLInputElement;
    const submit = screen.getByRole("button", { name: "登录" }) as HTMLButtonElement;

    expect(submit.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "12ab45" } });
    expect(input.value).toBe("1245");
    expect(submit.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "123456" } });
    expect(submit.disabled).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/login-actions.test.ts tests/login-verify.test.tsx`
Expected: FAIL（断言不符 / 页面结构不符）

- [ ] **Step 3: 实现**

`app/login/actions.ts` —— `sendMagicLink` 内 `signIn` 调用改为：

```ts
  // redirect:false —— 发码后由前端显式跳 /login/verify?email=...（NextAuth 默认
  // 跳 pages.verifyRequest 且不带 email，OTP 页需要 email 才能提交验证码）。
  await signIn("email", { email, redirect: false });
```

`app/login/page.tsx` —— 整文件替换：

```tsx
"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { sendMagicLink, signInWithWeChat } from "./actions";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // OTP 校验失败时 NextAuth 回跳 /login?error=Verification
  const verifyFailed = searchParams.get("error") === "Verification";
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await sendMagicLink(email);
      router.push(`/login/verify?email=${encodeURIComponent(email)}`);
    } catch {
      setMessage("发送失败，请稍后重试");
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-[#0a0a0a] px-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md bg-neutral-900 border border-neutral-800 rounded-2xl shadow-lg p-8 space-y-6"
      >
        <div className="text-center">
          <h1 className="text-2xl font-bold text-neutral-50">AI 短视频助手</h1>
          <p className="mt-2 text-sm text-neutral-400">输入邮箱，获取 6 位登录验证码</p>
        </div>

        {verifyFailed && (
          <div className="bg-red-950 border border-red-800 text-red-300 rounded-lg p-3 text-sm">
            验证码错误或已过期，请重新获取
          </div>
        )}
        {message && (
          <div className="bg-red-950 border border-red-800 text-red-300 rounded-lg p-3 text-sm">
            {message}
          </div>
        )}

        <div>
          <label htmlFor="email" className="block text-sm font-medium text-neutral-300 mb-1">
            邮箱地址
          </label>
          <input
            id="email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className="w-full px-4 py-3 bg-neutral-950 border border-neutral-700 rounded-lg text-neutral-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            disabled={loading}
          />
        </div>

        <button
          type="submit"
          disabled={loading || !email}
          className="w-full py-3 px-4 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {loading ? "发送中..." : "发送验证码"}
        </button>

        <div className="relative my-6">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-neutral-700" />
          </div>
          <div className="relative flex justify-center text-sm">
            <span className="bg-neutral-900 px-2 text-neutral-500">其他登录方式</span>
          </div>
        </div>

        <button
          type="button"
          onClick={() => signInWithWeChat()}
          className="w-full py-3 px-4 bg-[#07C160] text-white font-medium rounded-lg hover:bg-[#06AD56] transition-colors flex items-center justify-center gap-2"
        >
          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18z" />
          </svg>
          微信登录
        </button>
      </form>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[#0a0a0a]" />}>
      <LoginForm />
    </Suspense>
  );
}
```

`app/login/verify/page.tsx` —— 整文件替换：

```tsx
"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { sendMagicLink } from "../actions";

function VerifyContent() {
  const searchParams = useSearchParams();
  const email = searchParams.get("email") ?? "";
  const [code, setCode] = useState("");
  const [resendCooldown, setResendCooldown] = useState(0);

  function submit() {
    // 整页跳转交给浏览器：NextAuth 校验成功 302 到 callbackUrl（/），失败回
    // /login?error=Verification（pages.signIn）——session cookie 随响应落盘，
    // 无需 fetch 处理重定向。
    const params = new URLSearchParams({ email, token: code, callbackUrl: "/" });
    window.location.assign(`/api/auth/callback/email?${params.toString()}`);
  }

  async function resend() {
    if (resendCooldown > 0 || !email) return;
    await sendMagicLink(email);
    setResendCooldown(60);
    const timer = setInterval(() => {
      setResendCooldown((s) => {
        if (s <= 1) {
          clearInterval(timer);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-[#0a0a0a] px-4">
      <div className="w-full max-w-md bg-neutral-900 border border-neutral-800 rounded-2xl shadow-lg p-8 space-y-6">
        <div className="text-center">
          <div className="text-4xl">📧</div>
          <h1 className="mt-2 text-2xl font-bold text-neutral-50">输入登录验证码</h1>
          <p className="mt-2 text-sm text-neutral-400">
            若邮箱 <span className="font-medium text-neutral-200">{email || "已注册"}</span> 存在，验证码已发送（10 分钟内有效）
          </p>
        </div>

        {email ? (
          <>
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              placeholder="6 位验证码"
              className="w-full px-4 py-3 text-center text-2xl tracking-[0.5em] bg-neutral-950 border border-neutral-700 rounded-lg text-neutral-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />

            <button
              type="button"
              onClick={submit}
              disabled={code.length !== 6}
              className="w-full py-3 px-4 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              登录
            </button>

            <div className="flex items-center justify-between text-sm">
              <button
                type="button"
                onClick={() => void resend()}
                disabled={resendCooldown > 0}
                className="text-blue-400 hover:underline disabled:text-neutral-600 disabled:no-underline"
              >
                {resendCooldown > 0 ? `重新发送（${resendCooldown}s）` : "重新发送"}
              </button>
              <a href="/login" className="text-neutral-400 hover:underline">
                更换邮箱
              </a>
            </div>
          </>
        ) : (
          <div className="text-center">
            <p className="text-sm text-neutral-400">缺少邮箱参数，请重新发起登录。</p>
            <a href="/login" className="inline-block mt-2 text-blue-400 hover:underline text-sm">
              ← 返回登录
            </a>
          </div>
        )}
      </div>
    </main>
  );
}

export default function VerifyPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[#0a0a0a]" />}>
      <VerifyContent />
    </Suspense>
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/login-actions.test.ts tests/login-verify.test.tsx && npm run typecheck && npm run lint`
Expected: PASS（lint 注意 react/no-unescaped-entities——文案避免裸引号，用中文弯引号；上次分身卡片踩过）

- [ ] **Step 5: Commit**

```bash
git add app/login/actions.ts app/login/page.tsx app/login/verify/page.tsx tests/login-actions.test.ts tests/login-verify.test.tsx
git commit -m "feat(auth): 登录页/verify 页 OTP 两段式+深色重构——发码跳输码页，整页跳转 callback 校验"
```

---

### Task 7: 五件套 + 安全自查 + push

- [ ] **Step 1: 全量测试**

Run: `npm test`
Expected: 全部 PASS（含既有 600+ 用例不回归）

- [ ] **Step 2: 五件套**

Run: `npm run typecheck && npm run lint && npx prisma validate && npm run build`
Expected: 全部通过（build 里注意 `/login/verify` 的 Suspense 边界警告不应出现）

- [ ] **Step 3: 安全自查清单（对照 CLAUDE.md 安全规则）**

- [ ] 删除端点：`getOwnerId()` 归属校验、跨租户 404、限流桶正确（write 桶）
- [ ] OTP：`/api/auth/callback/email` 限流生效、验证码不落日志（生产）、邮件模板无 PII
- [ ] 无新 env、无密钥进代码、无原始错误消息外泄（`jsonError` 恒定文案）
- [ ] `dangerously` 无：删除确认 window.confirm 与现有一致

- [ ] **Step 4: Push**

```bash
git push origin main
```

- [ ] **Step 5: 生产冒烟（部署后用户执行）**

- 产物：出一条片 → 网格卡片展示 → 删除 → 列表消失
- 登录：邮箱收 6 位码 → 填码登录成功；错 5 次 → 429；magic link 兜底链接可用

---

## Self-Review 记录

- **Spec 覆盖**：②删除 API（Task 1-2）、网格卡片（Task 3）、OTP 后端（Task 4）、限流缺口（Task 5）、深色 UI（Task 6）、验收（Task 7）——全覆盖
- **占位符**：无 TBD；Task 3 Step 4 的「以实际断言为准微调」是既有测试兼容说明，非占位
- **类型一致**：`deleteOutput(id): Promise<boolean>`、`deleteVideoOutputApi(id): Promise<void>`、`renderOtpEmail(code, url)`、`rateLimitOtpAttempt(ip, email): Promise<boolean>`、`generateOtpCode(): string` 全链路一致
- **与 spec 的两处实施细化**（已回写 spec）：删除 R2 清理改 best-effort（对齐素材删除）；卡片封面用 video 首帧（不新增封面端点）
