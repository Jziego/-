# 生产部署 + 端到端验证 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Route C 代码从 mock 单测背书推进到本地全栈真实链路验证通过 + Zeabur 部署清单完备，并清理 4 项阻塞部署的技术债。

**Architecture:** 方案 A——验证驱动、增量修复。先 CF 脚手架清理（纯删除低风险），再 middleware 锁 nodejs runtime + 外层 IP 限流改 Redis 后端（替代 Upstash，零新依赖），然后 docker-compose 补 PostgreSQL 起本地全栈，分两阶段验证（demo 主链路 → production auth），最后产出 Zeabur 部署清单。每步回归 `npm test && npm run typecheck && npm run build`。

**Tech Stack:** Next.js 16 App Router、Prisma 7、BullMQ、Redis、NextAuth v5、Vitest、Docker Compose（PG+Redis+MinIO）、Chrome MCP（UI 验证）

**Spec:** `docs/superpowers/specs/2026-06-27-production-deploy-e2e-verification-design.md`

---

## 文件结构

**修改：**
- `package.json` — 删 4 个 cf 脚本 + `@opennextjs/cloudflare` + `wrangler` 依赖
- `next.config.ts` — 删末尾 `@opennextjs/cloudflare` dev 初始化
- `middleware.ts` — 加 `runtime = "nodejs"`、JWT 黑名单直接 import、外层 IP 限流改 `rateLimitByIp`、删 in-memory `ipStore`
- `lib/rate-limit.ts` — 新增 `IP_LIMIT_CONFIG` + `rateLimitByIp()` + `_resetMemoryStore()`
- `tests/rate-limit.test.ts` — 新增 `rateLimitByIp` 测试
- `docker-compose.yml` — 加 postgres 服务 + `pg_data` volume
- `.env.example` — 补 `OPENAI_BASE_URL` 行
- `.env` — 配置本地验证环境变量（不提交，在 .gitignore）
- `docs/DEVELOPER_SETUP.md` — 移除 Cloudflare MCP/wrangler 行
- `README.md` — 更新 Phase Docs 表格状态（Phase 3/4/5/5b 标完成）

**删除：**
- `wrangler.jsonc`
- `open-next.config.ts`
- `.open-next/` 目录（本地构建产物）

**新建：**
- `docs/DEPLOYMENT.md` — Zeabur 部署清单

---

## Task 1: CF Workers 遗留脚手架清理

**Files:**
- Delete: `wrangler.jsonc`, `open-next.config.ts`, `.open-next/`
- Modify: `package.json:10-13,40,84`, `next.config.ts:59-63`, `docs/DEVELOPER_SETUP.md:93`

- [ ] **Step 1: 删除 CF 配置文件与构建产物**

Run:
```bash
rm -f wrangler.jsonc open-next.config.ts
rm -rf .open-next
```
Expected: 三个路径均不存在（`ls wrangler.jsonc open-next.config.ts .open-next` 报 No such file）

- [ ] **Step 2: 从 package.json 删除 cf 脚本与依赖**

用 Edit 删除 `package.json` 中这 4 行脚本：
```json
    "build:cf": "opennextjs-cloudflare build",
    "preview:cf": "opennextjs-cloudflare build && opennextjs-cloudflare preview",
    "deploy:cf": "opennextjs-cloudflare build && opennextjs-cloudflare deploy",
    "upload:cf": "opennextjs-cloudflare build && opennextjs-cloudflare upload",
```

删除 dependencies 中的 `"@opennextjs/cloudflare": "^1.19.11",` 行。

删除 devDependencies 中的 `"wrangler": "^4.98.0"` 行（仅服务 CF 部署，无其他引用）。

- [ ] **Step 3: 从 next.config.ts 删除 CF dev 初始化**

删除 `next.config.ts` 末尾这 5 行：
```ts
if (process.env.NODE_ENV === "development") {
  void import("@opennextjs/cloudflare").then(({ initOpenNextCloudflareForDev }) => {
    initOpenNextCloudflareForDev();
  });
}
```

保留 `next.config.ts:26-39` 的 webpack 配置（含 `if (nextRuntime === "edge") externalize ioredis`——防御性保留）。

- [ ] **Step 4: 更新 docs/DEVELOPER_SETUP.md**

删除 `docs/DEVELOPER_SETUP.md:93` 这一行（Cloudflare MCP / wrangler 部署行）。若该行所在表格无其他行，删除整个表格段落；若表格其余行仍有意义，仅删该行。

- [ ] **Step 5: 重装依赖以更新 lockfile**

Run:
```bash
npm install
```
Expected: `package-lock.json` 中不再含 `@opennextjs/cloudflare` 与 `wrangler` 顶层条目；无安装错误。

- [ ] **Step 6: 回归验证**

Run:
```bash
npm run typecheck && npm test && npm run build
```
Expected: typecheck 通过；103 测试全绿；build 成功（确认构建不依赖 CF 脚手架）。

- [ ] **Step 7: 提交**

```bash
git add package.json package-lock.json next.config.ts docs/DEVELOPER_SETUP.md
git commit -m "chore: remove Cloudflare Workers scaffold (wrangler/open-next)

设计文档已明确不以 CF Workers 跑主站。删除 wrangler.jsonc、open-next.config.ts、
4 个 cf 脚本、@opennextjs/cloudflare 与 wrangler 依赖、next.config.ts 的 dev 初始化。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: 新增 rateLimitByIp（TDD）

**Files:**
- Modify: `lib/rate-limit.ts`（新增 `IP_LIMIT_CONFIG`、`rateLimitByIp()`、`_resetMemoryStore()`）
- Test: `tests/rate-limit.test.ts`

- [ ] **Step 1: 写失败测试**

在 `tests/rate-limit.test.ts` 末尾追加：
```typescript
describe("rateLimitByIp", () => {
  it("enforces maxRequests via in-memory backend when Redis absent", async () => {
    vi.stubEnv("APP_MODE", "demo");
    vi.stubEnv("REDIS_URL", "");
    const { rateLimitByIp, _resetMemoryStore } = await import("@/lib/rate-limit");
    _resetMemoryStore();
    const ip = "203.0.113.7";
    for (let i = 0; i < 60; i++) {
      const r = await rateLimitByIp(ip);
      expect(r.allowed).toBe(true);
    }
    const blocked = await rateLimitByIp(ip);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    vi.unstubAllEnvs();
  });

  it("disables limiting in production without Redis (fail-open)", async () => {
    vi.stubEnv("APP_MODE", "production");
    vi.stubEnv("REDIS_URL", "");
    const { rateLimitByIp } = await import("@/lib/rate-limit");
    const ip = "203.0.113.8";
    for (let i = 0; i < 100; i++) {
      const r = await rateLimitByIp(ip);
      expect(r.allowed).toBe(true);
    }
    vi.unstubAllEnvs();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- tests/rate-limit.test.ts`
Expected: FAIL — `rateLimitByIp is not a function` / `_resetMemoryStore is not a function`

- [ ] **Step 3: 实现 rateLimitByIp + _resetMemoryStore**

在 `lib/rate-limit.ts` 的 `applyRateLimit` 函数之前（约第 174 行 `// ── Convenience helper` 注释前）插入：
```typescript
// ── IP-based middleware rate limit (L0) ─────────────────────────────────────

const IP_LIMIT_CONFIG: RateLimitConfig = { windowSeconds: 60, maxRequests: 60 };

/**
 * L0: IP-based rate limit for middleware (coarse, pre-auth, multi-instance safe).
 * Uses the same Redis/memory backend as L2 — multi-instance safe when Redis is
 * configured. Called only when APP_MODE !== "demo" (middleware short-circuits
 * in demo mode before reaching this).
 */
export async function rateLimitByIp(ip: string): Promise<RateLimitResult> {
  return checkLimit(`ip:${ip}`, IP_LIMIT_CONFIG);
}

/** Reset the in-memory store (for testing only). */
export function _resetMemoryStore(): void {
  memoryStore.clear();
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- tests/rate-limit.test.ts`
Expected: PASS — 含新增 2 个 `rateLimitByIp` 用例，全文件测试通过。

- [ ] **Step 5: 全量回归**

Run: `npm test && npm run typecheck`
Expected: 105 测试全绿（103 + 2 新增）；typecheck 通过。

- [ ] **Step 6: 提交**

```bash
git add lib/rate-limit.ts tests/rate-limit.test.ts
git commit -m "feat: add rateLimitByIp for Redis-backed middleware IP limiting

复用 lib/rate-limit 的 Redis/memory 后端，替代 middleware 的 in-memory ipStore。
多实例共享，零新依赖（不引入 Upstash）。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: middleware 锁 nodejs runtime + 改造

**Files:**
- Modify: `middleware.ts`

**背景：** `isSessionRevoked` 在 Redis 未配置时 fail-open 返回 false，但 Redis 连接异常时会抛异常（`enableOfflineQueue: false`）。故改造后保留 try/catch（防御 Redis 抖动），但从 dynamic import 改为直接 import——nodejs runtime 下 Redis 正常时黑名单真正生效。

- [ ] **Step 1: 重写 middleware.ts**

将 `middleware.ts` 全文替换为：
```typescript
import { auth } from "@/auth";
import { getAppMode } from "@/lib/env";
import { NextResponse } from "next/server";
import { rateLimitByIp, getClientIp } from "@/lib/rate-limit";
import { isSessionRevoked } from "@/lib/session-blacklist";

// Middleware runs on the Node.js runtime (not Edge) so that ioredis is available
// for JWT session-blacklist checks and Redis-backed IP rate limiting. Under Edge
// runtime ioredis is unavailable and isSessionRevoked() silently fail-opens.
export const runtime = "nodejs";

export default auth(async (req) => {
  // demo: allow all traffic
  if (getAppMode() === "demo") return NextResponse.next();

  const { pathname } = req.nextUrl;

  // Public paths (accessible without login)
  if (
    pathname.startsWith("/api/auth") ||
    pathname === "/api/health" ||
    pathname.startsWith("/login") ||
    pathname.startsWith("/_next")
  ) {
    return NextResponse.next();
  }

  // API routes: IP rate limit (before auth, Redis-backed, multi-instance safe)
  if (pathname.startsWith("/api/")) {
    const ip = getClientIp(req.headers);
    const ipCheck = await rateLimitByIp(ip);
    if (!ipCheck.allowed) {
      return NextResponse.json(
        { error: "rate_limited", message: "Too many requests" },
        { status: 429 },
      );
    }
  }

  // API routes: auth + blacklist check
  if (pathname.startsWith("/api/")) {
    if (!req.auth) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // JWT blacklist check (session revocation).
    // isSessionRevoked returns false when Redis is unconfigured (fail-open), but
    // may throw on a transient Redis connection error (enableOfflineQueue: false).
    // Wrap in try/catch and fail-open to avoid 500ing every request during a blip.
    const jti = (req.auth.user as { jti?: string })?.jti;
    if (jti) {
      try {
        if (await isSessionRevoked(jti)) {
          const response = NextResponse.json(
            { error: "Session revoked", code: "session_revoked" },
            { status: 401 },
          );
          response.cookies.delete("authjs.session-token");
          return response;
        }
      } catch (err) {
        console.warn(
          "[middleware] session blacklist check failed, fail-open:",
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    return NextResponse.next();
  }

  // Page routes: redirect to /login with callbackUrl
  if (!req.auth) {
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("callbackUrl", req.nextUrl.pathname);
    return NextResponse.redirect(loginUrl);
  }

  // JWT blacklist check for page routes
  const jti = (req.auth.user as { jti?: string })?.jti;
  if (jti) {
    try {
      if (await isSessionRevoked(jti)) {
        const response = NextResponse.redirect(new URL("/login", req.url));
        response.cookies.delete("authjs.session-token");
        return response;
      }
    } catch (err) {
      console.warn(
        "[middleware] session blacklist check failed, fail-open:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return NextResponse.next();
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
```

- [ ] **Step 2: typecheck**

Run: `npm run typecheck`
Expected: 通过（`req.headers` 是标准 `Headers`，兼容 `getClientIp` 的 `{ get(name) }` 接口）。

- [ ] **Step 3: 测试回归**

Run: `npm test`
Expected: 105 测试全绿。

- [ ] **Step 4: build 回归**

Run: `npm run build`
Expected: build 成功，middleware 编译为 nodejs runtime。

- [ ] **Step 5: 提交**

```bash
git add middleware.ts
git commit -m "fix: lock middleware to nodejs runtime, Redis-backed IP rate limit

- export const runtime = 'nodejs' 让 ioredis 可用，JWT 黑名单不再 Edge fail-open
- 外层 IP 限流改用 rateLimitByIp（Redis 后端，多实例共享）
- 删除 in-memory ipStore / checkIpRateLimit / getClientIpFromHeaders
- JWT 黑名单检查改为直接 import，保留 try/catch 防御 Redis 连接异常

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: docker-compose 补 PostgreSQL + 本地环境配置

**Files:**
- Modify: `docker-compose.yml`, `.env.example`, `.env`（本地，不提交）

- [ ] **Step 1: docker-compose.yml 加 postgres 服务**

在 `docker-compose.yml` 的 `services:` 下（`redis:` 之前）插入：
```yaml
  postgres:
    image: postgres:16-alpine
    ports:
      - "5432:5432"
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: ai_video_assistant
    volumes:
      - pg_data:/var/lib/postgresql/data
```

在文件末尾 `volumes:` 下追加 `pg_data:`：
```yaml
volumes:
  minio_data:
  redis_data:
  pg_data:
```

- [ ] **Step 2: .env.example 补 OPENAI_BASE_URL**

在 `.env.example` 的 `OPENAI_API_KEY=""` 行后追加：
```
# OpenAI-compatible base URL (e.g. https://api.openai.com/v1 or DeepSeek/other compatible endpoint)
OPENAI_BASE_URL=""
```

- [ ] **Step 3: 配置本地 .env**

确认 `.env` 包含以下值（`OPENAI_API_KEY` / `OPENAI_BASE_URL` 填用户提供的真实凭证）：
```bash
APP_MODE="demo"
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/ai_video_assistant"
REDIS_URL="redis://localhost:6379"
OBJECT_STORAGE_ENDPOINT="http://127.0.0.1:9000"
OBJECT_STORAGE_BUCKET="ai-video-assistant"
OBJECT_STORAGE_ACCESS_KEY_ID="minioadmin"
OBJECT_STORAGE_SECRET_ACCESS_KEY="minioadmin"
OBJECT_STORAGE_REGION="us-east-1"
OPENAI_API_KEY="<用户提供>"
OPENAI_BASE_URL="<用户提供>"
AVATAR_PROVIDER=""
AUTH_SECRET="<openssl rand -hex 32 生成的值>"
AUTH_URL="http://localhost:3000"
```

生成 AUTH_SECRET（若 .env 中为空）：
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
把输出填入 `.env` 的 `AUTH_SECRET`。

- [ ] **Step 4: 起全栈容器**

Run:
```bash
docker compose up -d
```
Expected: `docker compose ps` 显示 postgres、redis、minio、minio-init 均 running。

- [ ] **Step 5: 跑 migration**

Run:
```bash
npm run db:migrate
```
Expected: Prisma 应用 4 个 migration（init、add_auth_models、add_last_quota_reset、add_account_model），无报错。

- [ ] **Step 6: 跑 seed**

Run:
```bash
npm run db:seed
```
Expected: 无报错；`demo_user` 写入 DB（可 `docker compose exec postgres psql -U postgres -d ai_video_assistant -c "SELECT id, email, plan FROM \"User\";"` 看到 demo_user 行）。

- [ ] **Step 7: 启动 web 与 worker（后台）**

在两个后台终端分别运行：
```bash
npm run dev         # 后台终端 1：web
npm run worker:dev  # 后台终端 2：worker
```
Expected: web 日志显示 `Ready`；worker 日志显示 `Worker started with 6 queues` + `[cron] Scheduled monthly quota reset`。

- [ ] **Step 8: 验证 health**

Run: `curl -s http://localhost:3000/api/health`
Expected: JSON 含 `db: configured`、`redis: configured`、`objectStorage: configured`。

- [ ] **Step 9: 提交 compose 与 env.example 改动**

```bash
git add docker-compose.yml .env.example
git commit -m "feat: add postgres to docker-compose, document OPENAI_BASE_URL

本地全栈验证需 PG。.env.example 补 OPENAI_BASE_URL（ai-client.ts 直接读取）。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: 阶段一 — demo 主链路验证（APP_MODE=demo）

**Files:** 无代码改动（纯验证）。若 Step 1 发现 hydration warning，则在 Task 5 末尾追加修复 commit。

- [ ] **Step 1: 打开首页，观察 hydration**

用 Chrome MCP `navigate` 到 `http://localhost:3000`，截图 + 读取控制台日志。
Expected: 页面正常渲染；**控制台无 hydration warning**。若有 warning，记录报错内容，在本 Task 末尾定位修复（见 Step 9）。

- [ ] **Step 2: 填门店档案三步**

用 Chrome MCP 操作 Dashboard：填店名、行业、主推产品、卖点等三步表单并提交。
Expected: 提交成功；刷新页面后数据从 API 恢复。
核验 DB：
```bash
docker compose exec postgres psql -U postgres -d ai_video_assistant -c "SELECT id, name, industry FROM \"StoreProfile\" LIMIT 5;"
```
Expected: 看到刚才提交的门店行。

- [ ] **Step 3: 上传素材**

用 Chrome MCP 在素材库区域选择一个本地小文件（如 `test-upload.mp4`）上传。
Expected: 进度条完成；素材库显示文件名。
核验 MinIO：浏览器开 `http://localhost:9001`（minioadmin/minioadmin），见 `ai-video-assistant` 桶内有上传文件。
核验 DB：
```bash
docker compose exec postgres psql -U postgres -d ai_video_assistant -c "SELECT id, \"originalFilename\", status, \"storageKey\" FROM \"Asset\" LIMIT 5;"
```
Expected: `status=uploaded`，`storageKey` 是 UUID-based（非 `object-storage.local` 假 URL）。

- [ ] **Step 4: 触发素材分析**

用 Chrome MCP 触发素材分析动作。
Expected: worker 日志（后台终端 2）显示 `[asset_analysis] Processing job ...` 并走 AI 路径（非降级）。
核验 DB：
```bash
docker compose exec postgres psql -U postgres -d ai_video_assistant -c "SELECT \"businessTags\", keywords, confidence FROM \"AssetAnalysis\" LIMIT 5;"
```
Expected: `businessTags`/`keywords` 丰富（真实 OpenAI 产出），`confidence > 0.5`。

- [ ] **Step 5: 生成脚本**

用 Chrome MCP 触发脚本生成。
Expected: worker 日志显示 AI 调用；产出脚本内容明显优于模板。
核验 DB：
```bash
docker compose exec postgres psql -U postgres -d ai_video_assistant -c "SELECT \"generationMode\", LEFT(content, 100) FROM \"ScriptDraft\" LIMIT 5;"
```
Expected: `generationMode=ai`。

- [ ] **Step 6: 创建数字人**

用 Chrome MCP 触发数字人创建。
Expected: worker 日志显示 `provider=mock-avatar`（无 HeyGen key 走 mock），不抛异常。
核验 DB：
```bash
docker compose exec postgres psql -U postgres -d ai_video_assistant -c "SELECT id, \"providerAvatarId\" FROM \"Avatar\" LIMIT 5;"
```
Expected: 有 Avatar 行。

- [ ] **Step 7: 一键成片**

用 Chrome MCP 点击一键成片。
Expected: worker 日志显示 FlowProducer 作业链：`avatar_generation` → `video_render`，状态 queued→processing→completed。
核验 DB：
```bash
docker compose exec postgres psql -U postgres -d ai_video_assistant -c "SELECT id, type, status FROM \"Job\" ORDER BY \"createdAt\" DESC LIMIT 10;"
docker compose exec postgres psql -U postgres -d ai_video_assistant -c "SELECT id, status FROM \"RenderProject\" ORDER BY \"createdAt\" DESC LIMIT 5;"
docker compose exec postgres psql -U postgres -d ai_video_assistant -c "SELECT id FROM \"VideoOutput\" LIMIT 5;"
```
Expected: `Job` 有 completed 行；`RenderProject` `status=ready`；`VideoOutput` 有记录。

- [ ] **Step 8: 验证 SSE 进度**

在成片过程中，用 Chrome MCP `eval` 或 `curl` 访问：
```bash
curl -s -N http://localhost:3000/api/jobs/<job-id>/progress
```
Expected: 推送 `progress` 0→100 的事件流。

- [ ] **Step 9: hydration 修复（仅 Step 1 发现 warning 时执行）**

若 Step 1 记录了 hydration warning：定位 `components/dashboard.tsx` 中 SSR/客户端不一致的代码（典型：render 中直接读 localStorage、Date.now、Math.random）。用 `useEffect` + `useState` 延迟到客户端 mount，或加 `suppressHydrationWarning`。
改后回归：
```bash
npm test && npm run typecheck && npm run build
```
提交：
```bash
git add components/dashboard.tsx
git commit -m "fix: resolve hydration mismatch in dashboard hero region

Co-Authored-By: Claude <noreply@anthropic.com>"
```
若无 warning，跳过本步，记录「hydration 已不存在」。

- [ ] **Step 10: 记录阶段一证据**

把 Step 1-8 的截图、DB 查询输出、worker 日志摘录整理记录（可写入临时验证记录文件，不提交）。阶段一通过标准：Step 7 `VideoOutput` 落库 + Step 8 SSE 推送可见。

---

## Task 6: 阶段二 — production auth 加固验证（APP_MODE=production）

**Files:** 无代码改动（纯验证）。

- [ ] **Step 1: 切 production 模式并重启**

把 `.env` 的 `APP_MODE` 改为 `production`，重启 web（停掉后台终端 1 的 `npm run dev`，重新 `npm run dev`）。worker 保持运行。

- [ ] **Step 2: 验证未登录 401**

Run:
```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/store-profiles
```
Expected: `401`。

- [ ] **Step 3: magic-link 登录（日志读 URL）**

用 Chrome MCP `navigate` 到 `http://localhost:3000/login`，输入邮箱（如 `test@example.com`），提交。
Expected: web 日志（后台终端 1）打印 magic link verify URL（因 Resend 未配，降级日志输出）。复制该 URL。

- [ ] **Step 4: 访问 verify URL 登录**

用 Chrome MCP `navigate` 到 Step 3 复制的 URL。
Expected: 登录成功，重定向到 `/`，set cookie。用 Chrome MCP `eval` 读 `document.cookie` 确认含 `authjs.session-token`。

- [ ] **Step 5: 验证 JWT 含 jti**

用 Chrome MCP 在已登录会话下 `eval` 调用 `/api/auth/session`：
```js
fetch('/api/auth/session').then(r=>r.text()).then(t=>document.title=t)
```
Expected: session JSON 含 `user.jti`。

- [ ] **Step 6: 验证外层 IP 限流（60/min）**

用已登录会话的 cookie，循环请求 65 次：
```bash
for i in $(seq 1 65); do curl -s -o /dev/null -w "%{http_code}\n" -b "authjs.session-token=<cookie值>" http://localhost:3000/api/store-profiles; done
```
Expected: 前 60 次 `200`，之后出现 `429`（rate_limited）。

- [ ] **Step 7: 验证配额扣减**

核验成片前后 `User.quotaRemaining` 递减：
```bash
docker compose exec postgres psql -U postgres -d ai_video_assistant -c "SELECT email, \"quotaRemaining\" FROM \"User\";"
```
Expected: 创建 RenderProject 后 `quotaRemaining` 较前减少。

- [ ] **Step 8: 验证 JWT 黑名单（登出 → revoked）**

用 Chrome MCP 触发登出（调用 `signOutWithRevocation` server action）。
核验 Redis：
```bash
docker compose exec redis redis-cli KEYS "revoked:*"
```
Expected: 见 `revoked:<jti>` key。
再用该会话 cookie 访问受保护 API：
```bash
curl -s -o /dev/null -w "%{http_code}" -b "authjs.session-token=<登出前cookie值>" http://localhost:3000/api/store-profiles
```
Expected: `401`（session_revoked）。

- [ ] **Step 9: 记录阶段二证据**

整理 Step 2-8 的命令输出。阶段二通过标准：Step 8 黑名单生效（`401 session_revoked`）——这是 Task 3 middleware 改造后的关键验证点。

---

## Task 7: 产出 Zeabur 部署清单

**Files:**
- Create: `docs/DEPLOYMENT.md`
- Modify: `README.md`（Phase Docs 表格补状态）

- [ ] **Step 1: 写 docs/DEPLOYMENT.md**

新建 `docs/DEPLOYMENT.md`，内容包含以下章节（完整填写，不留占位符）：

1. **服务拓扑** — web（`next start`）+ worker（`worker/Dockerfile`）+ Zeabur PostgreSQL 插件 + Redis 插件
2. **环境变量清单** — 按 subsystem 分组表格（Auth / Storage / AI / Queue / Sentry / 微信），每行：变量名、必填/可选、本地默认值、生产获取方式
3. **Cloudflare R2 配置** — 建桶 `ai-video-assistant` → 建 S3 兼容 token（读写）→ 桶 CORS（Methods: PUT/GET/HEAD；Headers: Content-Type；Origins: Zeabur 域名）→ 注入 `OBJECT_STORAGE_*` env
4. **部署流程** — `zbpack.json` 已自动化 `prisma migrate deploy + db seed + next start`；web 服务注入 env；worker 第二服务（Docker 类型用 `worker/Dockerfile`，或 Node 类型 `npx tsx worker/index.ts`，共享 DATABASE_URL/REDIS_URL）
5. **上线验证清单** — `/api/health` 全 configured；浏览器上传 mp4；magic-link 登录；一键成片到 `VideoOutput`
6. **已知限制与后续** — 微信 OAuth 需企业 AppID；HeyGen 需付费 key；Resend 需真实 key；多实例已支持（外层 IP 限流走 Redis 共享）

- [ ] **Step 2: 更新 README.md Phase Docs 表格**

在 `README.md` 的 "Route C Phase Docs" 表格中补齐 Phase 3/4/5/5b 状态行：
```markdown
| 3 — Worker + jobs | ✅ Complete | （无独立计划文档，见 spec） |
| 4 — Real AI integration | ✅ Complete | `docs/superpowers/plans/2026-06-11-route-c-phase4-*.md` |
| 5 — Auth/quota/rate-limit | ✅ Complete | `docs/superpowers/specs/2026-06-12-phase5-auth-design.md` |
| 5b — Auth hardening | ✅ Complete | `docs/superpowers/specs/2026-06-14-phase5b-auth-hardening-design.md` |
| Deploy + E2E | ✅ Complete | `docs/superpowers/plans/2026-06-27-production-deploy-e2e-verification.md` |
```

- [ ] **Step 3: 提交**

```bash
git add docs/DEPLOYMENT.md README.md
git commit -m "docs: add Zeabur deployment guide, update phase status

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 8: 全量回归 + 收尾

**Files:** 无

- [ ] **Step 1: 全量 CI 等价回归**

Run:
```bash
npm test && npm run typecheck && npm run lint && npx prisma validate && npm run build
```
Expected: 全部通过（105 测试 + typecheck + lint + prisma validate + build）。

- [ ] **Step 2: 确认工作区干净**

Run:
```bash
git status
```
Expected: working tree clean（所有改动已提交）。

- [ ] **Step 3: 确认分支提交历史**

Run:
```bash
git log --oneline main..HEAD
```
Expected: 看到 Task 1-7 的提交（CF 清理 / rateLimitByIp / middleware / compose / hydration[若有] / DEPLOYMENT）。

- [ ] **Step 4: 停止本地服务**

停掉后台 web 与 worker 进程；可选 `docker compose down`（保留卷以复用数据，或 `docker compose down -v` 清空）。

- [ ] **Step 5: 汇报结果**

向用户汇报：
- 阶段一/二验证通过情况（引用 Step 证据）
- 技术债清理结果（4 项）
- `docs/DEPLOYMENT.md` 位置
- 后续：用户照 `docs/DEPLOYMENT.md` 在 Zeabur 操作上云

---

## 自审记录

- **Spec 覆盖**：§3 本地环境→Task 4；§4.1 阶段一→Task 5；§4.2 阶段二→Task 6；§5.1 #1+#2→Task 2+3；§5.2 #3 hydration→Task 5 Step 1/9；§5.3 #4 CF→Task 1；§6 验证策略→每 Task 末回归 + Task 8；§7 部署清单→Task 7。全覆盖。
- **类型一致性**：`rateLimitByIp(ip: string): Promise<RateLimitResult>` 在 Task 2 定义、Task 3 调用一致；`_resetMemoryStore()` 定义与测试调用一致；`getClientIp` 复用现有签名。
- **spec 修正**：spec §5.1 step 2 说"直接 import 真实调用，Redis 不可用时 isSessionRevoked 内部 fail-open"——实际 isSessionRevoked 在 Redis 连接异常时会抛异常，故 Task 3 保留 try/catch（防御性 fail-open）。已采用更准确实现。
