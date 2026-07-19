# Security Baseline Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 baseline 安全审计发现的 7 条 HIGH/MEDIUM 漏洞（3 HIGH + 4 MEDIUM），覆盖 IDOR、MIME 校验、session TTL、错误信息泄漏、JSON 解析鲁棒性。

**Architecture:** 每条修复独立成 commit，TDD（先写失败测试 → 实现 → 绿 → commit）。jobs 子树两个 IDOR 同源一起修；错误泄漏沿用项目已有范式（`1c83e3c`/`d712aa5`：server `console.error` + client generic 消息）；MIME 校验接线已存在但未调用的 `lib/file-magic.ts`，需在 `lib/storage.ts` 新增 ranged GetObject helper。

**Tech Stack:** Next.js 16 (App Router), TypeScript 6, Vitest 4, Zod 4, AWS SDK v3 (`@aws-sdk/client-s3`), NextAuth v5.

**审计发现映射:**
- HIGH: #1 `jobs/[id]` IDOR · #2 `jobs/[id]/progress` IDOR · #3 `confirm` MIME 校验缺失
- MEDIUM: #4 session TTL 7d < JWT 30d · #5 `render-projects` 错误泄漏 · #6 `upload-intent` 错误泄漏 · #7 6 路由 `request.json()` 缺 try/catch

**执行约定:**
- 工作分支：直接在 `main` 上提交（项目 workflow 偏好，Zeabur 自动部署）
- commit message：conventional commits，结尾加 `Co-Authored-By: Claude <noreply@anthropic.com>`
- 每个 task 完成后本地跑 `npm test`（相关测试）+ `npm run typecheck`；全部完成后跑 `npm run build`
- 修复全部完成后、push 前，用新建立的 hook 流程：先 `/security-review` 审 `origin/main..HEAD`，再 push

---

## Task 1: `GET /api/jobs/[id]` IDOR guard（HIGH #1）

**Files:**
- Modify: `app/api/jobs/[id]/route.ts`
- Create: `tests/api/jobs-id.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `tests/api/jobs-id.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET } from "@/app/api/jobs/[id]/route";
import { getJobRepository } from "@/lib/repositories";
import { resetRuntimeStateForTests } from "@/lib/runtime-store";
import { createId } from "@/lib/ids";
import type { Job } from "@/lib/types";

const savedDbUrl = process.env.DATABASE_URL;

function makeJob(ownerId: string): Job {
  return {
    id: createId("job"),
    ownerId,
    projectId: createId("proj"),
    type: "video_render",
    status: "completed",
    progress: 100,
    payload: {},
    dependsOnJobIds: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("GET /api/jobs/[id] — IDOR guard", () => {
  beforeEach(() => {
    delete process.env.DATABASE_URL;
    resetRuntimeStateForTests();
  });
  afterEach(() => {
    if (savedDbUrl) process.env.DATABASE_URL = savedDbUrl;
  });

  it("returns 200 for the requesting owner's own job", async () => {
    const job = makeJob("demo_user");
    await getJobRepository().createMany([job]);
    const res = await GET(new Request(`http://localhost/api/jobs/${job.id}`), ctx(job.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.job.id).toBe(job.id);
  });

  it("returns 404 for another owner's job (no existence leak)", async () => {
    const job = makeJob("other_user");
    await getJobRepository().createMany([job]);
    const res = await GET(new Request(`http://localhost/api/jobs/${job.id}`), ctx(job.id));
    expect(res.status).toBe(404);
  });

  it("returns 404 for a missing job", async () => {
    const res = await GET(new Request("http://localhost/api/jobs/job_missing"), ctx("job_missing"));
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/api/jobs-id.test.ts`
Expected: FAIL — "returns 200 for the requesting owner's own job" 通过，但 "returns 404 for another owner's job" 失败（当前实现返 200，因为无 owner 校验）。

- [ ] **Step 3: 实现 IDOR guard**

替换 `app/api/jobs/[id]/route.ts` 全文:

```ts
import { jsonError, jsonOk } from "@/lib/api-response";
import { getJobRepository } from "@/lib/repositories";
import { getOwnerId } from "@/lib/auth-helpers";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ownerId = await getOwnerId();
  const job = await getJobRepository().findById(id);

  // IDOR guard: job must belong to the requesting owner. Missing and foreign
  // both resolve to 404 so existence is not leaked.
  if (!job || job.ownerId !== ownerId) {
    return jsonError("Job not found", 404);
  }

  return jsonOk({ job });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/api/jobs-id.test.ts && npm run typecheck`
Expected: PASS（3 用例全绿，typecheck 0 errors）

- [ ] **Step 5: Commit**

```bash
git add app/api/jobs/[id]/route.ts tests/api/jobs-id.test.ts
git commit -m "$(cat <<'EOF'
security(api): IDOR guard on GET /api/jobs/[id]

该路由未调用 getOwnerId() 也未校验 job.ownerId，任何已登录用户
（production）甚至任意未认证流量（demo 模式 middleware 放行）都可用
job_<uuid> 读取他人 job 详情（含 payload）。

修：接入 getOwnerId() + job.ownerId !== ownerId → 404（missing 与
foreign 归一，不泄漏存在性）。补 3 个 IDOR 单测。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `GET /api/jobs/[id]/progress` SSE IDOR guard（HIGH #2）

**Files:**
- Modify: `app/api/jobs/[id]/progress/route.ts`
- Create: `tests/api/jobs-id-progress.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `tests/api/jobs-id-progress.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET } from "@/app/api/jobs/[id]/progress/route";
import { getJobRepository } from "@/lib/repositories";
import { resetRuntimeStateForTests } from "@/lib/runtime-store";
import { createId } from "@/lib/ids";
import type { Job } from "@/lib/types";

const savedDbUrl = process.env.DATABASE_URL;

function makeJob(ownerId: string, status: Job["status"] = "completed"): Job {
  return {
    id: createId("job"),
    ownerId,
    projectId: createId("proj"),
    type: "video_render",
    status,
    progress: status === "completed" ? 100 : 0,
    payload: {},
    dependsOnJobIds: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("GET /api/jobs/[id]/progress — IDOR guard", () => {
  beforeEach(() => {
    delete process.env.DATABASE_URL;
    resetRuntimeStateForTests();
  });
  afterEach(() => {
    if (savedDbUrl) process.env.DATABASE_URL = savedDbUrl;
  });

  it("returns 404 for another owner's job before opening the stream", async () => {
    const job = makeJob("other_user");
    await getJobRepository().createMany([job]);
    const res = await GET(
      new Request(`http://localhost/api/jobs/${job.id}/progress`),
      ctx(job.id),
    );
    expect(res.status).toBe(404);
  });

  it("returns 200 for the owner's own terminal job", async () => {
    const job = makeJob("demo_user", "completed");
    await getJobRepository().createMany([job]);
    const res = await GET(
      new Request(`http://localhost/api/jobs/${job.id}/progress`),
      ctx(job.id),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/api/jobs-id-progress.test.ts`
Expected: FAIL — "returns 404 for another owner's job" 失败（当前返 200 流）。

- [ ] **Step 3: 实现 IDOR guard（在流创建前）**

编辑 `app/api/jobs/[id]/progress/route.ts`，在文件顶部 import 加 `getOwnerId`，并修改 handler 开头：

```ts
import { getJobRepository } from "@/lib/repositories";
import { getOwnerId } from "@/lib/auth-helpers";
```

将 handler 开头从:
```ts
  const { id } = await params;

  const job = await getJobRepository().findById(id);
  if (!job) {
    return new Response(JSON.stringify({ error: "Job not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" }
    });
  }
```
改为:
```ts
  const { id } = await params;
  const ownerId = await getOwnerId();

  const job = await getJobRepository().findById(id);
  // IDOR guard: must run before the stream is opened. Missing and foreign
  // both resolve to 404 so existence is not leaked.
  if (!job || job.ownerId !== ownerId) {
    return new Response(JSON.stringify({ error: "Job not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" }
    });
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/api/jobs-id-progress.test.ts && npm run typecheck`
Expected: PASS（2 用例绿，typecheck 0 errors）

- [ ] **Step 5: Commit**

```bash
git add "app/api/jobs/[id]/progress/route.ts" tests/api/jobs-id-progress.test.ts
git commit -m "$(cat <<'EOF'
security(api): IDOR guard on GET /api/jobs/[id]/progress (SSE)

SSE 路由与 jobs/[id] 同源问题：未接 getOwnerId()、未校验 job.ownerId。
任何人可订阅他人 job 的实时进度与 error 字段。

修：在流创建前加 getOwnerId() + owner 校验 → 404。补 SSE IDOR 单测。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Session 黑名单 TTL 对齐 JWT maxAge（MEDIUM #4）

**Files:**
- Modify: `auth.ts`
- Modify: `app/login/actions.ts`
- Create: `tests/auth-session-ttl.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `tests/auth-session-ttl.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SESSION_MAX_AGE_SECONDS } from "@/auth";

describe("session TTL alignment", () => {
  it("exports a 30-day constant (NextAuth v5 default JWT maxAge)", () => {
    expect(SESSION_MAX_AGE_SECONDS).toBe(30 * 24 * 60 * 60);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/auth-session-ttl.test.ts`
Expected: FAIL — `SESSION_MAX_AGE_SECONDS` 未从 `@/auth` 导出。

- [ ] **Step 3: 实现单一真相源常量 + 对齐两处**

编辑 `auth.ts`：

在 `export const { handlers, auth, signIn, signOut } = NextAuth({` **之前**加常量导出:

```ts
/**
 * JWT session lifetime. NextAuth v5 defaults maxAge to 30 days; we pin it
 * explicitly so session-blacklist revocation (revokeSession) can reference the
 * same value and stay aligned. If this changes, update app/login/actions.ts too.
 */
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
```

把 `session: { strategy: "jwt" },` 改为:

```ts
  session: { strategy: "jwt", maxAge: SESSION_MAX_AGE_SECONDS },
```

编辑 `app/login/actions.ts`：

import 行从 `import { auth, signIn, signOut } from "@/auth";` 改为:

```ts
import { auth, signIn, signOut, SESSION_MAX_AGE_SECONDS } from "@/auth";
```

把 `signOutWithRevocation` 内的:
```ts
    // Revoke the current JWT. TTL: 7 days (NextAuth default max session).
    await revokeSession(session.user.jti, 7 * 86400);
```
改为:
```ts
    // Revoke the current JWT for the full session lifetime so the blacklist
    // entry outlives the cookie (NextAuth v5 default maxAge = 30 days, pinned
    // via SESSION_MAX_AGE_SECONDS in auth.ts).
    await revokeSession(session.user.jti, SESSION_MAX_AGE_SECONDS);
```

- [ ] **Step 4: 跑测试确认通过 + 回归现有 auth 测试**

Run: `npx vitest run tests/auth-session-ttl.test.ts tests/login-actions.test.ts tests/auth-helpers.test.ts && npm run typecheck`
Expected: PASS（新测试绿，现有 auth 相关测试不回归，typecheck 0 errors）

- [ ] **Step 5: Commit**

```bash
git add auth.ts app/login/actions.ts tests/auth-session-ttl.test.ts
git commit -m "$(cat <<'EOF'
security(auth): align session-blacklist TTL with JWT maxAge (30d)

revokeSession 用 7 天 TTL，但 NextAuth v5 默认 JWT maxAge=30 天，
导致登出/吊销后 Redis 黑名单条目在第 7 天过期，被窃取的 cookie 可
"复活"长达 23 天。原注释 "7 days (NextAuth default)" 是错误前提。

修：导出 SESSION_MAX_AGE_SECONDS=30d 常量为单一真相源，auth.ts
session.maxAge 与 login/actions revokeSession TTL 同源对齐。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `POST /api/render-projects` 错误信息泄漏（MEDIUM #5）

**Files:**
- Modify: `app/api/render-projects/route.ts`
- Create: `tests/api/render-projects-error-leak.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `tests/api/render-projects-error-leak.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/render-projects/route";
import { getScriptRepository } from "@/lib/repositories";
import { resetRuntimeStateForTests } from "@/lib/runtime-store";
import { createId, nowIso } from "@/lib/ids";
import type { ScriptDraft } from "@/lib/types";

const savedDbUrl = process.env.DATABASE_URL;
const SECRET_REDIS_ERR = "connect ECONNREFUSED redis-cluster.internal.svc:6379";

function makeScriptDraft(): ScriptDraft {
  return {
    id: createId("script"),
    ownerId: "demo_user",
    storeId: createId("store"),
    purpose: "store_traffic",
    platform: "douyin",
    title: "t",
    hook: "h",
    scenes: [{ order: 1, text: "x", durationSeconds: 2, assetHints: [] }],
    voiceover: "v",
    captions: ["c"],
    cta: "cta",
    generationMode: "ai",
    complianceWarnings: [],
    createdAt: nowIso(),
  };
}

function req(body: unknown): Request {
  return new Request("http://localhost/api/render-projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/render-projects — error leak", () => {
  beforeEach(() => {
    delete process.env.DATABASE_URL;
    resetRuntimeStateForTests();
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    process.env.QUOTA_REMAINING_OVERRIDE = "100";
    // Force quota to succeed so we reach the enqueue path
    delete process.env.QUOTA_DISABLED;
  });
  afterEach(() => {
    if (savedDbUrl) process.env.DATABASE_URL = savedDbUrl;
    delete process.env.REDIS_URL;
  });

  it("does not leak internal Redis error messages to the client on enqueue failure", async () => {
    const draft = makeScriptDraft();
    await getScriptRepository().create(draft);

    // Mock the queue module so flowProducer.add throws an infrastructure error
    vi.doMock("@/lib/queue", () => {
      const err = new Error(SECRET_REDIS_ERR);
      return {
        createBullQueue: () => ({ add: vi.fn(), close: vi.fn() }),
        createFlowProducer: () => ({
          add: vi.fn().mockRejectedValue(err),
          close: vi.fn(),
        }),
        toFlowJobs: (jobs: unknown[]) => [{ name: (jobs as { id: string }[])[0]!.id, data: {}, children: [] }],
        toQueuePayload: (j: unknown) => ({ jobId: (j as { id: string }).id }),
      };
    });

    const res = await POST(req({ scriptDraftId: draft.id }));
    const body = await res.json();
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(SECRET_REDIS_ERR);
    expect(serialized).not.toMatch(/redis-cluster|ECONNREFUSED|6379/i);
    vi.doUnmock("@/lib/queue");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/api/render-projects-error-leak.test.ts`
Expected: FAIL — 当前 enqueueResults/响应体含 `connect ECONNREFUSED redis-cluster.internal.svc:6379`。

- [ ] **Step 3: 实现修复（沿用 1c83e3c 范式）**

编辑 `app/api/render-projects/route.ts`：

内层 catch（约 line 112-122），从:
```ts
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : "Unknown enqueue error";
          enqueueResults.push({ jobId: flowJob.name, ok: false, error: errorMsg });
          failedJobIds.push(flowJob.name);
          if (flowJob.children) {
            for (const child of flowJob.children) {
              enqueueResults.push({ jobId: child.name, ok: false, error: `Parent flow failed: ${errorMsg}` });
              failedJobIds.push(child.name);
            }
          }
        }
```
改为（移除 `error` 字段，server 端记录）:
```ts
        } catch (err) {
          console.error("[render-projects] enqueue failed for flow:", flowJob.name, err);
          enqueueResults.push({ jobId: flowJob.name, ok: false });
          failedJobIds.push(flowJob.name);
          if (flowJob.children) {
            for (const child of flowJob.children) {
              enqueueResults.push({ jobId: child.name, ok: false });
              failedJobIds.push(child.name);
            }
          }
        }
```

外层 catch（约 line 170-196），从:
```ts
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Redis unavailable";

      // Mark all jobs as failed since we couldn't enqueue
      for (const job of jobs) {
        try {
          await getJobRepository().update(job.id, {
            status: "failed",
            error: errorMsg,
            updatedAt: now
          });
        } catch {
          // Best-effort
        }
      }
      ...
      return jsonOk({ project: { ...project, status: "failed" }, jobs, enqueued: false, error: errorMsg }, 202);
    }
```
改为（generic DB error + 不向响应体透传 errorMsg）:
```ts
    } catch (err) {
      console.error("[render-projects] enqueue failed:", err);

      // Mark all jobs as failed since we couldn't enqueue. Use a generic
      // message in the DB; full error is in server logs only.
      for (const job of jobs) {
        try {
          await getJobRepository().update(job.id, {
            status: "failed",
            error: "Failed to enqueue to Redis",
            updatedAt: now
          });
        } catch {
          // Best-effort
        }
      }

      try {
        await getRenderRepository().updateProject(project.id, {
          status: "failed",
          updatedAt: now
        });
      } catch {
        // Best-effort
      }

      return jsonOk({ project: { ...project, status: "failed" }, jobs, enqueued: false }, 202);
    }
```

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `npx vitest run tests/api/render-projects-error-leak.test.ts tests/api/render-projects.test.ts && npm run typecheck`
Expected: PASS（新测试绿，现有 render-projects 测试不回归）

- [ ] **Step 5: Commit**

```bash
git add app/api/render-projects/route.ts tests/api/render-projects-error-leak.test.ts
git commit -m "$(cat <<'EOF'
security(api): don't leak Redis/BullMQ errors from render-projects

入队失败时把原始 err.message 通过 202 响应体（enqueueResults[].error
与顶层 error 字段）回传客户端，ioredis 错误典型含内部主机/端口
（connect ECONNREFUSED <host>:6379、slots cache of [cluster.internal]），
泄漏内部基础设施拓扑，违反 CLAUDE.md §8。

修：沿用 1c83e3c/d712aa5 范式——server console.error + 客户端只拿
ok:false / enqueued:false（不带 message）。补错误泄漏回归测试。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `POST /api/assets/upload-intent` 错误泄漏 + body try/catch（MEDIUM #6 + 部分 #7）

**Files:**
- Modify: `lib/services/assets.ts`（加 `UploadValidationError`）
- Modify: `app/api/assets/upload-intent/route.ts`（区分校验/基础设施 + body try/catch）
- Create: `tests/api/upload-intent-errors.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `tests/api/upload-intent-errors.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST } from "@/app/api/assets/upload-intent/route";
import { resetRuntimeStateForTests } from "@/lib/runtime-store";

const savedDbUrl = process.env.DATABASE_URL;

function req(body: unknown): Request {
  return new Request("http://localhost/api/assets/upload-intent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/assets/upload-intent — error handling", () => {
  beforeEach(() => {
    delete process.env.DATABASE_URL;
    resetRuntimeStateForTests();
    process.env.OBJECT_STORAGE_ENDPOINT = "http://localhost:9000";
    process.env.OBJECT_STORAGE_ACCESS_KEY_ID = "test";
    process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY = "test";
    process.env.OBJECT_STORAGE_BUCKET = "test";
  });
  afterEach(() => {
    if (savedDbUrl) process.env.DATABASE_URL = savedDbUrl;
    delete process.env.OBJECT_STORAGE_ENDPOINT;
    delete process.env.OBJECT_STORAGE_ACCESS_KEY_ID;
    delete process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY;
    delete process.env.OBJECT_STORAGE_BUCKET;
  });

  it("returns 400 on invalid JSON body", async () => {
    const res = await POST(req("{not json"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/json/i);
  });

  it("returns 400 with a user-facing message on validation error (bad content type)", async () => {
    const res = await POST(req({
      storeId: "store_x", filename: "a.mp4", contentType: "text/html", sizeBytes: 100,
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/content type/i);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/api/upload-intent-errors.test.ts`
Expected: FAIL — "returns 400 on invalid JSON body" 抛未捕获异常（当前裸 `request.json()`），非 400。

- [ ] **Step 3a: 在 service 层加类型化校验错误**

编辑 `lib/services/assets.ts`，在 `export { ALLOWED_MIME_PREFIXES, MAX_UPLOAD_BYTES };`（约 line 95）**之前**加:

```ts
/**
 * Thrown by {@link createUploadIntent} when input fails validation. These
 * messages are safe to echo to the client. Other errors (e.g. S3 presign
 * failures) must NOT be forwarded — routes branch on this type.
 */
export class UploadValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadValidationError";
  }
}
```

把 `createUploadIntent` 内两处 `throw new Error(...)` 改为 `throw new UploadValidationError(...)`:

```ts
  if (!isAllowedMimeType(input.contentType)) {
    throw new UploadValidationError(`Unsupported content type. Allowed: ${ALLOWED_MIME_PREFIXES.join(", ")}`);
  }

  if (input.sizeBytes <= 0 || input.sizeBytes > MAX_UPLOAD_BYTES) {
    throw new UploadValidationError(`File size must be between 1 and ${MAX_UPLOAD_BYTES} bytes`);
  }
```

- [ ] **Step 3b: 路由区分校验错误 vs 基础设施错误 + body try/catch**

替换 `app/api/assets/upload-intent/route.ts` 全文:

```ts
import { jsonError, jsonOk } from "@/lib/api-response";
import { applyRateLimit } from "@/lib/rate-limit";
import { getOwnerId } from "@/lib/auth-helpers";
import { hasObjectStorage } from "@/lib/env";
import { createUploadIntent, UploadValidationError } from "@/lib/services/assets";

export async function POST(request: Request) {
  if (!hasObjectStorage()) {
    return jsonError("Object storage is not configured", 503);
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return jsonError("Request body must be valid JSON", 400);
  }

  if (!body.storeId || !body.filename || !body.contentType || !body.sizeBytes) {
    return jsonError("Missing upload intent fields");
  }

  try {
    const ownerId = await getOwnerId();
    const limited = await applyRateLimit(request, ownerId);
    if (limited) return limited;
    const intent = await createUploadIntent({
      ownerId,
      storeId: body.storeId,
      filename: body.filename,
      contentType: body.contentType,
      sizeBytes: Number(body.sizeBytes),
    });

    return jsonOk({ intent }, 201);
  } catch (error) {
    // Validation errors carry a user-facing message — safe to forward.
    if (error instanceof UploadValidationError) {
      return jsonError(error.message, 400);
    }
    // Infrastructure errors (S3 presign) may contain endpoint/host/region —
    // log server-side, return generic message (CLAUDE.md §7/§8, matches the
    // outputs-url / preview-url pattern from 1c83e3c).
    console.error("[upload-intent] presign failed:", error);
    return jsonError("Failed to create upload intent", 503);
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/api/upload-intent-errors.test.ts && npm run typecheck`
Expected: PASS（2 用例绿，typecheck 0 errors）

- [ ] **Step 5: Commit**

```bash
git add lib/services/assets.ts app/api/assets/upload-intent/route.ts tests/api/upload-intent-errors.test.ts
git commit -m "$(cat <<'EOF'
security(api): don't leak S3 errors from upload-intent + JSON try/catch

presign 失败时 catch 块把 AWS SDK 原始 error.message 回传客户端，常含
endpoint host/bucket/region（与已修的 outputs-url 是姊妹路由，修了一半
漏了它）。同时该路由裸 request.json() 无 try/catch，违反 CLAUDE.md §2。

修：service 层用 UploadValidationError 区分校验错误（可回显）与基础
设施错误（隐藏）；路由 catch 按 instanceof 分流，infra 错误走
console.error + generic 503（沿用 1c83e3c 范式）；body 解析补 try/catch。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `POST /api/assets/confirm` 服务端 MIME 校验（HIGH #3）

**Files:**
- Modify: `lib/storage.ts`（加 `getFirstBytes` ranged GetObject helper）
- Modify: `app/api/assets/confirm/route.ts`（接线 file-magic）
- Create: `tests/api/assets-confirm-mime.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `tests/api/assets-confirm-mime.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/assets/confirm/route";
import { getStoreRepository, getAssetRepository } from "@/lib/repositories";
import { resetRuntimeStateForTests } from "@/lib/runtime-store";
import { createId, nowIso } from "@/lib/ids";

const savedDbUrl = process.env.DATABASE_URL;

// PNG magic bytes (valid image), but we'll claim text/html to trigger mismatch
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function setupStoreAndMock(headContentType: string, firstBytes: Uint8Array) {
  vi.mock("@/lib/storage", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/storage")>();
    return {
      ...actual,
      headObject: vi.fn().mockResolvedValue({
        exists: true,
        contentLength: 100,
        contentType: headContentType,
      }),
      getFirstBytes: vi.fn().mockResolvedValue(firstBytes),
      deleteObject: vi.fn().mockResolvedValue(undefined),
    };
  });
}

function req(body: unknown): Request {
  return new Request("http://localhost/api/assets/confirm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/assets/confirm — server-side MIME verification", () => {
  beforeEach(() => {
    delete process.env.DATABASE_URL;
    resetRuntimeStateForTests();
  });
  afterEach(() => {
    if (savedDbUrl) process.env.DATABASE_URL = savedDbUrl;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("rejects upload whose magic bytes don't match declared content type", async () => {
    // Claim image/png, but bytes are an HTML/EXE payload (no valid magic)
    const htmlBytes = new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e]); // "<html>"
    setupStoreAndMock("image/png", htmlBytes);

    const store = await getStoreRepository().upsert({
      id: createId("store"),
      ownerId: "demo_user",
      name: "s",
      industry: "餐饮",
      mainProducts: ["x"],
      targetCustomers: ["y"],
      sellingPoints: ["z"],
      promotions: [],
      brandTone: "亲切",
      forbiddenWords: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });

    const { POST: freshPOST } = await import("@/app/api/assets/confirm/route");
    const assetId = createId("asset");
    const res = await freshPOST(req({
      assetId,
      storeId: store.id,
      storageKey: `stores/${store.id}/assets/${assetId}-evil.html`,
      originalFilename: "evil.html",
      mimeType: "image/png",
      type: "image",
      sizeBytes: 100,
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/mime|content|match/i);

    // Asset must not have been persisted
    expect(await getAssetRepository().findById(assetId)).toBeNull();
  });

  it("accepts upload whose magic bytes match (valid PNG)", async () => {
    setupStoreAndMock("image/png", PNG_BYTES);
    const store = await getStoreRepository().upsert({
      id: createId("store"),
      ownerId: "demo_user",
      name: "s",
      industry: "餐饮",
      mainProducts: ["x"],
      targetCustomers: ["y"],
      sellingPoints: ["z"],
      promotions: [],
      brandTone: "亲切",
      forbiddenWords: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    const { POST: freshPOST } = await import("@/app/api/assets/confirm/route");
    const assetId = createId("asset");
    const res = await freshPOST(req({
      assetId,
      storeId: store.id,
      storageKey: `stores/${store.id}/assets/${assetId}-ok.png`,
      originalFilename: "ok.png",
      mimeType: "image/png",
      type: "image",
      sizeBytes: 100,
    }));
    expect(res.status).toBe(201);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/api/assets-confirm-mime.test.ts`
Expected: FAIL — 当前 confirm 不做 magic 校验，"rejects mismatch" 用例实际返 201（asset 被持久化）。

- [ ] **Step 3a: 在 `lib/storage.ts` 加 ranged GetObject helper**

在 `getObjectToBuffer`（约 line 123-129）**之后**加:

```ts
/**
 * Download only the first `length` bytes of an object via a ranged GET. Used
 * by the upload-confirm flow to verify magic bytes without fetching the whole
 * file (which can be up to 200 MB).
 */
export async function getFirstBytes(key: string, length: number): Promise<Uint8Array> {
  const response = await getS3Client().send(
    new GetObjectCommand({
      Bucket: getObjectStorageBucket(),
      Key: key,
      Range: `bytes=0-${Math.max(0, length - 1)}`,
    }),
  );
  if (!response.Body) return new Uint8Array();
  return new Uint8Array(await response.Body.transformToByteArray());
}
```

- [ ] **Step 3b: confirm 路由接线 file-magic**

编辑 `app/api/assets/confirm/route.ts`：

import 块改为（加 file-magic + getFirstBytes + deleteObject）:

```ts
import { jsonError, jsonOk } from "@/lib/api-response";
import { applyRateLimit } from "@/lib/rate-limit";
import { hasObjectStorage } from "@/lib/env";
import { nowIso } from "@/lib/ids";
import { getAssetRepository, getStoreRepository } from "@/lib/repositories";
import { getOwnerId } from "@/lib/auth-helpers";
import { confirmAssetUploadSchema } from "@/lib/schemas";
import { MAX_UPLOAD_BYTES, headObject, getFirstBytes, deleteObject } from "@/lib/storage";
import { detectMimeFromMagicBytes, isMimeConsistentWithMagic, MAGIC_BYTES_READ_LENGTH } from "@/lib/file-magic";
```

在 `headObject` + size 校验之后、`getAssetRepository().create(...)` **之前**（约 line 55 之后）插入 magic-byte 校验:

```ts
  // Server-side MIME verification: never trust the client-supplied contentType
  // (CLAUDE.md §2). Download the first N bytes and check magic bytes match the
  // declared type. Mismatch → reject and delete the orphan object.
  const firstBytes = await getFirstBytes(input.storageKey, MAGIC_BYTES_READ_LENGTH);
  const detectedMime = detectMimeFromMagicBytes(firstBytes);
  const claimedMime = head.contentType ?? input.mimeType;
  if (!isMimeConsistentWithMagic(claimedMime, detectedMime)) {
    await deleteObject(input.storageKey);
    return jsonError("Uploaded content does not match the declared MIME type", 400);
  }
```

- [ ] **Step 4: 跑测试确认通过 + 回归现有 confirm 测试**

Run: `npx vitest run tests/api/assets-confirm-mime.test.ts && npm run typecheck`
Expected: PASS（2 用例绿，typecheck 0 errors）

注：若现有 confirm 集成测试因新增 `getFirstBytes` 调用而失败（未 mock S3），在同批次补 mock 或在测试里跳过 S3 路径——但要确认现有 `tests/api/` 下 confirm 相关测试是否需要更新 mock，本步骤验证时一并处理。

- [ ] **Step 5: Commit**

```bash
git add lib/storage.ts app/api/assets/confirm/route.ts tests/api/assets-confirm-mime.test.ts
git commit -m "$(cat <<'EOF'
security(api): server-side MIME verification on upload confirm (§2)

CLAUDE.md §2 要求 "never trust client-supplied contentType without
server-side MIME verification"。项目已写好 lib/file-magic.ts（magic bytes
检测）但全仓 0 处调用——confirm 路由直接信任 head.contentType（客户端
可控），可上传伪装成图片的 HTML/JS/EXE。

修：lib/storage.ts 新增 getFirstBytes（ranged GET，只读前 256B）；
confirm 路由在 headObject 后做 detectMimeFromMagicBytes +
isMimeConsistentWithMagic，不一致 → 400 + deleteObject 清理脏对象。
补 magic 校验单测。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: 其余 5 路由 `request.json()` 加 try/catch（MEDIUM #7）

**Files:**
- Modify: `app/api/assets/route.ts`（POST，约 line 17）
- Modify: `app/api/assets/confirm/route.ts`（POST，约 line 15）
- Modify: `app/api/assets/analyze/route.ts`（POST，约 line 8）
- Modify: `app/api/store-profiles/route.ts`（POST，约 line 29）
- Modify: `app/api/script-drafts/route.ts`（POST，约 line 17）
- Create: `tests/api/json-body-validation.test.ts`

> **注:** upload-intent 的 try/catch 已在 Task 5 完成，本 task 不含它。

- [ ] **Step 1: 写失败测试（参数化覆盖 5 个路由）**

创建 `tests/api/json-body-validation.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as assetsPOST } from "@/app/api/assets/route";
import { POST as confirmPOST } from "@/app/api/assets/confirm/route";
import { POST as analyzePOST } from "@/app/api/assets/analyze/route";
import { POST as storeProfilesPOST } from "@/app/api/store-profiles/route";
import { POST as scriptDraftsPOST } from "@/app/api/script-drafts/route";
import { resetRuntimeStateForTests } from "@/lib/runtime-store";

const savedDbUrl = process.env.DATABASE_URL;

function req(url: string): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not valid json",
  });
}

const cases = [
  { name: "POST /api/assets", fn: () => assetsPOST(req("http://localhost/api/assets")) },
  { name: "POST /api/assets/confirm", fn: () => confirmPOST(req("http://localhost/api/assets/confirm")) },
  { name: "POST /api/assets/analyze", fn: () => analyzePOST(req("http://localhost/api/assets/analyze")) },
  { name: "POST /api/store-profiles", fn: () => storeProfilesPOST(req("http://localhost/api/store-profiles")) },
  { name: "POST /api/script-drafts", fn: () => scriptDraftsPOST(req("http://localhost/api/script-drafts")) },
];

describe("request.json() — invalid body returns 400 (not uncaught 500)", () => {
  beforeEach(() => {
    delete process.env.DATABASE_URL;
    resetRuntimeStateForTests();
  });
  afterEach(() => {
    if (savedDbUrl) process.env.DATABASE_URL = savedDbUrl;
  });

  for (const c of cases) {
    it(`${c.name} returns 400 on malformed JSON`, async () => {
      const res = await c.fn();
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/json/i);
    });
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/api/json-body-validation.test.ts`
Expected: FAIL — 5 个用例都失败（当前各路由裸 `request.json()` 抛未捕获异常，非 400）。

- [ ] **Step 3: 逐个路由包 try/catch**

**`app/api/assets/route.ts`**（POST，把 `const body = await request.json();` 替换为）:

```ts
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return jsonError("Request body must be valid JSON", 400);
  }
```

**`app/api/assets/confirm/route.ts`**（POST，把 `const body = await request.json();` 替换为同样模式）:

```ts
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return jsonError("Request body must be valid JSON", 400);
  }
```

**`app/api/assets/analyze/route.ts`**（POST，把 `const body = await request.json();` 替换为同样模式）:

```ts
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return jsonError("Request body must be valid JSON", 400);
  }
```

**`app/api/store-profiles/route.ts`**（POST，把 `const body = await request.json();` 替换为同样模式）:

```ts
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return jsonError("Request body must be valid JSON", 400);
  }
```

**`app/api/script-drafts/route.ts`**（POST，把 `const body = await request.json();` 替换为同样模式）:

```ts
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return jsonError("Request body must be valid JSON", 400);
  }
```

- [ ] **Step 4: 跑测试确认通过 + typecheck**

Run: `npx vitest run tests/api/json-body-validation.test.ts && npm run typecheck`
Expected: PASS（5 用例绿，typecheck 0 errors）。若某路由原本 `body` 被推断为 `any` 而后续用法报 typecheck 错，把后续 `body.xxx` 改为 `(body as Record<string, unknown>).xxx` 或保持 `let body: Record<string, unknown>` 后用 `body.xxx as <type>`。

- [ ] **Step 5: Commit**

```bash
git add app/api/assets/route.ts app/api/assets/confirm/route.ts app/api/assets/analyze/route.ts app/api/store-profiles/route.ts app/api/script-drafts/route.ts tests/api/json-body-validation.test.ts
git commit -m "$(cat <<'EOF'
security(api): wrap request.json() in try/catch across 5 routes (§2)

assets / assets/confirm / assets/analyze / store-profiles / script-drafts
的 POST 都裸 await request.json()，非法 JSON 会抛未捕获异常绕过 jsonError
统一封装（违反 CLAUDE.md §2 + Common Pitfalls）。同仓库 render-projects /
avatars 已达标，属系统性缺口（upload-intent 已在上一 commit 修）。

修：5 个路由统一 try/catch → 400。补参数化回归测试。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## 全部完成后的最终验证 + push 流程

- [ ] **Step F1: 跑全套验证**

```bash
npm test && npm run typecheck && npm run lint && npm run build
```
Expected: 全绿（test 全过、typecheck 0 errors、lint 0 errors、build exit 0）。

- [ ] **Step F2: 对累积 diff 跑 security-review**

确认 `/hooks` 已注册（首次配置需开一次 `/hooks` 菜单 reload），然后：
```
/security-review
```
审 `origin/main..HEAD`（2 个旧 commit + 7 个新 fix commit）。确认无新引入的高危问题。

- [ ] **Step F3: push（走新 hook 流程）**

让 Claude 发起 `git push origin main`——此时应触发 Task 配置的 PreToolUse hook 软提醒（注入 additionalContext）。push 成功后 Zeabur 自动部署。

- [ ] **Step F4: 部署后冒烟（可选）**

push 完成后，快速验证线上：
- 登出后再用旧 cookie 访问受保护页面（应 401/重定向，验证 session blacklist 修复）
- 上传一个伪装 content-type 的小文件确认被拒（验证 MIME 修复）

---

## Self-Review（plan 作者自检）

**1. Spec coverage（7 条审计发现是否都有 task）：**
- HIGH #1 (jobs/[id] IDOR) → Task 1 ✓
- HIGH #2 (jobs/[id]/progress IDOR) → Task 2 ✓
- HIGH #3 (confirm MIME) → Task 6 ✓
- MEDIUM #4 (session TTL) → Task 3 ✓
- MEDIUM #5 (render-projects 错误泄漏) → Task 4 ✓
- MEDIUM #6 (upload-intent 错误泄漏) → Task 5 ✓
- MEDIUM #7 (json try/catch, 6 路由) → Task 5 (upload-intent) + Task 7 (其余 5) ✓
- 无遗漏。LOW #8/#9 明确不在本次范围（用户选 HIGH+MEDIUM）。

**2. Placeholder scan：** 无 TBD/TODO/"add error handling"等占位；每个步骤都有真实代码。

**3. Type consistency：**
- `SESSION_MAX_AGE_SECONDS` 在 Task 3 的 auth.ts 导出，login/actions import —— 名称一致 ✓
- `UploadValidationError` 在 Task 5 的 assets.ts 导出，upload-intent route import —— 名称一致 ✓
- `getFirstBytes` 在 Task 6 的 storage.ts 定义，confirm route import —— 名称一致 ✓
- `MAGIC_BYTES_READ_LENGTH` / `detectMimeFromMagicBytes` / `isMimeConsistentWithMagic` 来自已存在的 file-magic.ts，签名核对一致 ✓
- jobs 两个 task 的 `getOwnerId()` import 自 `@/lib/auth-helpers`，与项目既有用法一致 ✓
