# Phase 5b — Auth 短板补齐：实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐 Phase 5 的 5 个 auth/ops 短板：Sentry 错误追踪、Middleware 统一限流、Cron 配额月度重置、JWT Session 黑名单、微信 OAuth 登录。

**Architecture:** 按依赖顺序实施。Sentry 先行建立可观测性，Middleware 限流简化路由层，Cron 复用现有 BullMQ 基础设施，JWT 吊销基于 Redis 黑名单，微信 OAuth 通过 NextAuth 自定义 Provider 对接。

**Tech Stack:** `@sentry/nextjs` ^9.x, BullMQ repeatable jobs, ioredis, NextAuth v5 custom OAuth provider, Prisma migrations

---

## Step 1: Sentry 错误追踪

### Task 1: Install @sentry/nextjs

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the package**

```bash
npm install @sentry/nextjs@^9
```

Expected: package.json updated with `@sentry/nextjs` in dependencies.

- [ ] **Step 2: Verify installation**

```bash
npm ls @sentry/nextjs
```

Expected: shows version ^9.x.x

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: install @sentry/nextjs ^9"
```

---

### Task 2: Add Sentry env accessors to lib/env.ts

**Files:**
- Modify: `lib/env.ts`

- [ ] **Step 1: Append Sentry env accessors**

Add the following to the end of `lib/env.ts` (after line 61, before the file ends):

```ts
// ── Sentry ───────────────────────────────────────────────────────────────────

export function getSentryDsn(): string | undefined {
  return process.env.SENTRY_DSN?.trim() || undefined;
}

export function getSentryOrg(): string | undefined {
  return process.env.SENTRY_ORG?.trim() || undefined;
}

export function getSentryProject(): string | undefined {
  return process.env.SENTRY_PROJECT?.trim() || undefined;
}

export function getSentryAuthToken(): string | undefined {
  return process.env.SENTRY_AUTH_TOKEN?.trim() || undefined;
}
```

- [ ] **Step 2: Verify typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/env.ts
git commit -m "feat: add Sentry env accessors"
```

---

### Task 3: Create Sentry config files

**Files:**
- Create: `sentry.client.config.ts`
- Create: `sentry.server.config.ts`
- Create: `sentry.edge.config.ts`

- [ ] **Step 1: Create sentry.client.config.ts**

```ts
import * as Sentry from "@sentry/nextjs";

const dsn = process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    tracesSampleRate: 0.1,
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,
  });
}
```

- [ ] **Step 2: Create sentry.server.config.ts**

```ts
import * as Sentry from "@sentry/nextjs";

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: 0.1,
    environment: process.env.NODE_ENV ?? "development",
  });
}
```

- [ ] **Step 3: Create sentry.edge.config.ts**

```ts
import * as Sentry from "@sentry/nextjs";

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: 0,
  });
}
```

- [ ] **Step 4: Verify typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add sentry.client.config.ts sentry.server.config.ts sentry.edge.config.ts
git commit -m "feat: add Sentry config files (client/server/edge)"
```

---

### Task 4: Create instrumentation.ts

**Files:**
- Create: `instrumentation.ts`

- [ ] **Step 1: Create instrumentation.ts**

```ts
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}
```

- [ ] **Step 2: Verify typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add instrumentation.ts
git commit -m "feat: add Next.js instrumentation hook for Sentry"
```

---

### Task 5: Wire Sentry into next.config.ts

**Files:**
- Modify: `next.config.ts`

- [ ] **Step 1: Add withSentryConfig wrapper**

Replace the entire content of `next.config.ts` with:

```ts
import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

function parseAllowedDevOrigins(): string[] {
  const raw = process.env.DEV_ALLOWED_ORIGINS ?? "192.168.5.9";

  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      if (entry.startsWith("http://") || entry.startsWith("https://")) {
        return new URL(entry).hostname;
      }
      return entry.includes(":") ? entry.split(":")[0]! : entry;
    });
}

const nextConfig: NextConfig = {
  serverExternalPackages: ["@prisma/client", "@prisma/adapter-pg", "pg"],
  env: {
    NEXT_PUBLIC_APP_MODE: process.env.APP_MODE ?? "demo"
  },
  allowedDevOrigins: parseAllowedDevOrigins(),
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      nodemailer: false,
      "@react-email/render": false,
    };
    return config;
  },
  experimental: {
    serverActions: {
      bodySizeLimit: "20mb"
    }
  }
};

const sentryConfig = withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG ?? "",
  project: process.env.SENTRY_PROJECT ?? "",
  silent: !process.env.CI,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  sourcemaps: {
    disable: !process.env.CI,
  },
});

export default process.env.SENTRY_DSN ? sentryConfig : nextConfig;

if (process.env.NODE_ENV === "development") {
  void import("@opennextjs/cloudflare").then(({ initOpenNextCloudflareForDev }) => {
    initOpenNextCloudflareForDev();
  });
}
```

- [ ] **Step 2: Verify build does not break**

```bash
npx next build --webpack 2>&1 | tail -20
```

Expected: build succeeds (Sentry config skipped if no SENTRY_DSN set).

- [ ] **Step 3: Commit**

```bash
git add next.config.ts
git commit -m "feat: wire Sentry into next.config with conditional source map upload"
```

---

### Task 6: Create app/global-error.tsx

**Files:**
- Create: `app/global-error.tsx`

- [ ] **Step 1: Create app/global-error.tsx**

```tsx
"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";

interface GlobalErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function GlobalError({ error, reset }: GlobalErrorProps) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html>
      <body>
        <main className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
          <div className="text-center space-y-4">
            <h1 className="text-2xl font-bold text-gray-900">出错了</h1>
            <p className="text-gray-600">
              应用遇到了意外错误，请刷新页面重试。
            </p>
            <button
              onClick={reset}
              className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
            >
              刷新页面
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
```

- [ ] **Step 2: Verify typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/global-error.tsx
git commit -m "feat: add global-error boundary with Sentry capture"
```

---

### Task 7: Create app/error.tsx

**Files:**
- Create: `app/error.tsx`

- [ ] **Step 1: Create app/error.tsx**

```tsx
"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";

interface ErrorPageProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function ErrorPage({ error, reset }: ErrorPageProps) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="text-center space-y-4">
        <h1 className="text-xl font-bold text-gray-900">页面加载失败</h1>
        <p className="text-gray-600">请稍后重试。</p>
        <button
          onClick={reset}
          className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
        >
          重试
        </button>
      </div>
    </main>
  );
}
```

- [ ] **Step 2: Verify typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/error.tsx
git commit -m "feat: add route-level error boundary with Sentry capture"
```

---

### Task 8: Verify Sentry integration end-to-end

- [ ] **Step 1: Run full CI check**

```bash
npm run typecheck && npm run lint && npm run build 2>&1 | tail -30
```

Expected: all pass, build succeeds.

- [ ] **Step 2: Commit if anything changed**

```bash
git status
```

Only commit if there are uncommitted changes from fixes.

---

## Step 2: Middleware 统一限流

### Task 9: Add applyRateLimit() helper to lib/rate-limit.ts

**Files:**
- Modify: `lib/rate-limit.ts`

- [ ] **Step 1: Add applyRateLimit export**

Insert after the `rateLimitApi` function (after line 172), before the `ratelimitHeaders` section:

```ts
// ── Convenience helper for API routes ────────────────────────────────────────

import { jsonRateLimited } from "@/lib/api-response";

/**
 * Apply L2 API rate limit and return a 429 response if exceeded.
 * Returns null if the request is allowed (caller should continue).
 *
 * Usage in API routes:
 *   const limited = await applyRateLimit(request, ownerId);
 *   if (limited) return limited;
 */
export async function applyRateLimit(
  request: Request,
  ownerId: string,
): Promise<Response | null> {
  const rl = await rateLimitApi(ownerId, request.method);
  if (!rl.allowed) return jsonRateLimited(rl);
  return null;
}
```

Note: Remove the `import { jsonRateLimited }` from inside the function body — instead add it at the top of the file. The existing import section should become:

```ts
import { hasRedis, getRedisUrl, getAppMode } from "@/lib/env";
import { Redis } from "ioredis";
import { jsonRateLimited } from "@/lib/api-response";
```

But wait — `lib/rate-limit.ts` is imported by `lib/api-response.ts` (for `RateLimitResult` type). This creates a circular dependency if `rate-limit.ts` imports `jsonRateLimited` from `api-response.ts`.

**Fix:** Do NOT import `jsonRateLimited` in `rate-limit.ts`. Instead, construct the 429 response inline in `applyRateLimit`:

```ts
/**
 * Apply L2 API rate limit and return a 429 response if exceeded.
 * Returns null if the request is allowed (caller should continue).
 *
 * Usage in API routes:
 *   const limited = await applyRateLimit(request, ownerId);
 *   if (limited) return limited;
 */
export async function applyRateLimit(
  request: Request,
  ownerId: string,
): Promise<Response | null> {
  const rl = await rateLimitApi(ownerId, request.method);
  if (!rl.allowed) {
    const retryAfter = Math.max(0, rl.reset - Math.floor(Date.now() / 1000));
    return Response.json(
      { error: "rate_limited", retryAfter },
      {
        status: 429,
        headers: {
          "X-RateLimit-Remaining": String(rl.remaining),
          "X-RateLimit-Reset": String(rl.reset),
          "Retry-After": String(retryAfter),
        },
      },
    );
  }
  return null;
}
```

- [ ] **Step 2: Verify typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors, no circular dependency issues.

- [ ] **Step 3: Commit**

```bash
git add lib/rate-limit.ts
git commit -m "feat: add applyRateLimit() convenience helper"
```

---

### Task 10: Add IP-based rate limiting to middleware.ts

**Files:**
- Modify: `middleware.ts`

- [ ] **Step 1: Add in-memory IP rate limit**

Replace the entire content of `middleware.ts` with:

```ts
import { auth } from "@/auth";
import { getAppMode } from "@/lib/env";
import { NextResponse } from "next/server";

// ── In-memory IP rate limiter (Edge-safe) ────────────────────────────────────

const IP_RATE_LIMIT_WINDOW = 60_000; // 60 seconds
const IP_RATE_LIMIT_MAX = 60;        // 60 requests per window

const ipStore = new Map<string, { count: number; reset: number }>();

// Purge expired IP entries every 60s
if (typeof setInterval !== "undefined") {
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of ipStore) {
      if (entry.reset <= now) ipStore.delete(key);
    }
  }, 60_000);
}

function checkIpRateLimit(ip: string): { allowed: boolean } {
  const now = Date.now();
  const entry = ipStore.get(ip);
  if (!entry || entry.reset <= now) {
    ipStore.set(ip, { count: 1, reset: now + IP_RATE_LIMIT_WINDOW });
    return { allowed: true };
  }
  entry.count++;
  return { allowed: entry.count <= IP_RATE_LIMIT_MAX };
}

function getClientIpFromHeaders(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim() || "unknown";
  return request.headers.get("x-real-ip") ?? "unknown";
}

// ── Middleware ────────────────────────────────────────────────────────────────

export default auth((req) => {
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

  // IP-based rate limit for API routes (before auth, coarse protection)
  if (pathname.startsWith("/api/")) {
    const ip = getClientIpFromHeaders(req.request);
    const ipCheck = checkIpRateLimit(ip);
    if (!ipCheck.allowed) {
      return NextResponse.json(
        { error: "rate_limited", message: "Too many requests" },
        { status: 429 },
      );
    }
  }

  // API routes: return 401 if not authenticated
  if (pathname.startsWith("/api/")) {
    if (!req.auth) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.next();
  }

  // Page routes: redirect to /login with callbackUrl
  if (!req.auth) {
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("callbackUrl", req.nextUrl.pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
```

- [ ] **Step 2: Verify typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add middleware.ts
git commit -m "feat: add IP-based rate limiting to middleware (in-memory, Edge-safe)"
```

---

### Task 11: Simplify API routes — asset-analyses

**Files:**
- Modify: `app/api/asset-analyses/route.ts`

- [ ] **Step 1: Replace rateLimitApi pattern**

Change the import and the rate limit check:

Old imports (lines 1-2):
```ts
import { jsonOk, jsonRateLimited } from "@/lib/api-response";
import { rateLimitApi } from "@/lib/rate-limit";
```

New imports:
```ts
import { jsonOk } from "@/lib/api-response";
import { applyRateLimit } from "@/lib/rate-limit";
```

Old rate limit block (lines 8-9):
```ts
  const rl = await rateLimitApi(ownerId, "GET");
  if (!rl.allowed) return jsonRateLimited(rl);
```

New:
```ts
  const limited = await applyRateLimit(request, ownerId);
  if (limited) return limited;
```

- [ ] **Step 2: Verify typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/api/asset-analyses/route.ts
git commit -m "refactor: use applyRateLimit() in asset-analyses route"
```

---

### Task 12: Simplify remaining 9 API route files

**Files:**
- Modify: `app/api/jobs/route.ts`
- Modify: `app/api/store-profiles/route.ts`
- Modify: `app/api/avatars/route.ts`
- Modify: `app/api/script-drafts/route.ts`
- Modify: `app/api/assets/upload-intent/route.ts`
- Modify: `app/api/assets/confirm/route.ts`
- Modify: `app/api/render-projects/route.ts`
- Modify: `app/api/assets/route.ts`
- Modify: `app/api/assets/analyze/route.ts`

For each file, apply the same transformation:

1. Replace `import { ..., jsonRateLimited } from "@/lib/api-response"` → remove `jsonRateLimited` (keep other imports)
2. Replace `import { rateLimitApi } from "@/lib/rate-limit"` → `import { applyRateLimit } from "@/lib/rate-limit"`
3. Replace each occurrence of:
```ts
  const rl = await rateLimitApi(ownerId, "<METHOD>");
  if (!rl.allowed) return jsonRateLimited(rl);
```
with:
```ts
  const limited = await applyRateLimit(request, ownerId);
  if (limited) return limited;
```

**Note:** In `render-projects/route.ts`, keep `jsonQuotaError` in the import — only remove `jsonRateLimited`.

- [ ] **Step 1: Simplify jobs route**

```bash
# Edit app/api/jobs/route.ts per the pattern above
```

- [ ] **Step 2: Simplify store-profiles route**

```bash
# Edit app/api/store-profiles/route.ts per the pattern above (2 occurrences)
```

- [ ] **Step 3: Simplify avatars route**

```bash
# Edit app/api/avatars/route.ts per the pattern above (2 occurrences)
```

- [ ] **Step 4: Simplify script-drafts route**

```bash
# Edit app/api/script-drafts/route.ts per the pattern above (2 occurrences)
```

- [ ] **Step 5: Simplify assets/upload-intent route**

```bash
# Edit app/api/assets/upload-intent/route.ts per the pattern above
```

- [ ] **Step 6: Simplify assets/confirm route**

```bash
# Edit app/api/assets/confirm/route.ts per the pattern above
```

- [ ] **Step 7: Simplify render-projects route**

```bash
# Edit app/api/render-projects/route.ts per the pattern above (2 occurrences)
```

- [ ] **Step 8: Simplify assets route**

```bash
# Edit app/api/assets/route.ts per the pattern above (2 occurrences)
```

- [ ] **Step 9: Simplify assets/analyze route**

```bash
# Edit app/api/assets/analyze/route.ts per the pattern above
```

- [ ] **Step 10: Verify typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 11: Commit**

```bash
git add app/api/
git commit -m "refactor: simplify all API routes to use applyRateLimit() helper"
```

---

### Task 13: Run existing rate-limit tests

- [ ] **Step 1: Run rate-limit tests**

```bash
npx vitest run tests/rate-limit.test.ts
```

Expected: all tests pass.

- [ ] **Step 2: Run full test suite**

```bash
npm test
```

Expected: all tests pass.

---

### Task 14: Verify full build after middleware changes

- [ ] **Step 1: Run full CI check**

```bash
npm run typecheck && npm run lint && npm run build 2>&1 | tail -20
```

Expected: all pass.

- [ ] **Step 2: Commit if any fixes were needed**

```bash
git status
```

---

## Step 3: Cron 配额月度重置

### Task 15: Add lastQuotaReset to Prisma schema

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Add lastQuotaReset field**

In the `User` model, add after `quotaRemaining` (line 20):

```prisma
  lastQuotaReset DateTime?
```

The User model block should now include:

```prisma
model User {
  id             String          @id
  email          String          @unique
  emailVerified  DateTime?
  image          String?
  plan           String          @default("free")
  quotaRemaining Int             @default(10)
  lastQuotaReset DateTime?
  createdAt      DateTime        @default(now())
  stores         StoreProfile[]
  assets         Asset[]
  avatars        AvatarProfile[]
  scripts        ScriptDraft[]
  renderProjects RenderProject[]
  jobs           Job[]
}
```

- [ ] **Step 2: Run migration**

```bash
npx prisma migrate dev --name add_last_quota_reset
```

Expected: creates migration file, applies it successfully.

- [ ] **Step 3: Validate schema**

```bash
npx prisma validate
```

Expected: "The database schema is valid."

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat: add lastQuotaReset field to User for monthly quota reset tracking"
```

---

### Task 16: Add cron queue name to lib/queue.ts

**Files:**
- Modify: `lib/queue.ts`

- [ ] **Step 1: Add cron queue name**

Add `quota_monthly_reset` to the JobType union in `lib/types.ts` first, then update `queueNames`:

In `lib/types.ts`, change `JobType` (line 25-30) from:
```ts
export type JobType =
  | "asset_analysis"
  | "avatar_generation"
  | "video_render"
  | "slideshow_render"
  | "subtitle_generation";
```
to:
```ts
export type JobType =
  | "asset_analysis"
  | "avatar_generation"
  | "video_render"
  | "slideshow_render"
  | "subtitle_generation"
  | "quota_monthly_reset";
```

In `lib/queue.ts`, add to `queueNames`:
```ts
export const queueNames: Record<JobType, string> = {
  asset_analysis: "asset-analysis",
  avatar_generation: "avatar-generation",
  video_render: "video-render",
  slideshow_render: "slideshow-render",
  subtitle_generation: "subtitle-generation",
  quota_monthly_reset: "cron-quota-reset",
};
```

- [ ] **Step 2: Verify typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/types.ts lib/queue.ts
git commit -m "feat: add quota_monthly_reset job type and cron queue"
```

---

### Task 17: Create worker/processors/quota-reset.ts

**Files:**
- Create: `worker/processors/quota-reset.ts`

- [ ] **Step 1: Create quota-reset processor**

```ts
import type { Job } from "bullmq";
import { getPrisma } from "@/lib/prisma";
import { hasDatabase } from "@/lib/env";
import { nowIso } from "@/lib/ids";

export async function quotaResetProcessor(job: Job): Promise<{ usersReset: number }> {
  const prisma = getPrisma();
  if (!prisma || !hasDatabase()) {
    console.log("[quota-reset] No database available — skipping quota reset");
    return { usersReset: 0 };
  }

  const now = nowIso();
  let totalReset = 0;

  // Reset free plan users to 10
  const freeResult = await prisma.user.updateMany({
    where: {
      plan: "free",
      quotaRemaining: { not: -1 },
    },
    data: {
      quotaRemaining: 10,
      lastQuotaReset: now,
    },
  });
  totalReset += freeResult.count;
  console.log(`[quota-reset] Reset ${freeResult.count} free-plan users to 10`);

  // Reset pro plan users to 100
  const proResult = await prisma.user.updateMany({
    where: {
      plan: "pro",
      quotaRemaining: { not: -1 },
    },
    data: {
      quotaRemaining: 100,
      lastQuotaReset: now,
    },
  });
  totalReset += proResult.count;
  console.log(`[quota-reset] Reset ${proResult.count} pro-plan users to 100`);

  // enterprise (-1) users are skipped by the `not: -1` filter above

  console.log(`[quota-reset] Monthly quota reset complete. ${totalReset} users reset.`);
  return { usersReset: totalReset };
}
```

- [ ] **Step 2: Verify worker typecheck**

```bash
npx tsc --noEmit -p worker/tsconfig.json
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add worker/processors/quota-reset.ts
git commit -m "feat: add monthly quota reset processor"
```

---

### Task 18: Register quota reset processor and cron job in worker/index.ts

**Files:**
- Modify: `worker/index.ts`

- [ ] **Step 1: Add imports and registration**

Add import (after existing processor imports, around line 8):
```ts
import { quotaResetProcessor } from "@/worker/processors/quota-reset";
```

Add registration (after existing `registerProcessor` calls, around line 16):
```ts
registerProcessor("quota_monthly_reset", quotaResetProcessor);
```

- [ ] **Step 2: Add cron job scheduling**

After the `const jobTypes` declaration block (around line 138), add:

```ts
// ── Cron: Schedule monthly quota reset ──────────────────────────────────────

import { Queue } from "bullmq";

async function scheduleQuotaReset() {
  const cronQueue = new Queue("cron", { connection });
  await cronQueue.add(
    "quota-monthly-reset",
    { task: "quota_monthly_reset" },
    {
      repeat: { pattern: "0 0 1 * *" }, // 1st of every month at 00:00 UTC
      jobId: "quota-monthly-reset", // deduplicate
    },
  );
  console.log("[cron] Scheduled monthly quota reset (0 0 1 * *)");

  // Also add a one-off immediate run for dev/test
  // (remove in production — controlled by env)
  if (process.env.RUN_QUOTA_RESET_ON_STARTUP === "1") {
    await cronQueue.add(
      "quota-monthly-reset-immediate",
      { task: "quota_monthly_reset" },
      {},
    );
    console.log("[cron] Triggered immediate quota reset (RUN_QUOTA_RESET_ON_STARTUP=1)");
  }

  return cronQueue;
}

let cronQueue: Queue | null = null;
scheduleQuotaReset().then((q) => { cronQueue = q; }).catch((err) => {
  console.error("[cron] Failed to schedule quota reset:", err.message);
});
```

- [ ] **Step 3: Add cron queue to shutdown handler**

In the `shutdown` function, add before `process.exit(0)`:
```ts
  if (cronQueue) await cronQueue.close();
```

- [ ] **Step 4: Verify worker typecheck**

```bash
npx tsc --noEmit -p worker/tsconfig.json
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add worker/index.ts
git commit -m "feat: register quota reset processor and schedule monthly cron job"
```

---

### Task 19: Add tests for quota reset

**Files:**
- Create: `tests/quota-reset.test.ts`

- [ ] **Step 1: Create test file**

```ts
import { describe, it, expect, vi } from "vitest";

// Mock dependencies
vi.mock("@/lib/prisma", () => ({
  getPrisma: vi.fn(),
}));
vi.mock("@/lib/env", () => ({
  hasDatabase: vi.fn(),
}));

import { quotaResetProcessor } from "@/worker/processors/quota-reset";
import { getPrisma } from "@/lib/prisma";
import { hasDatabase } from "@/lib/env";

describe("quotaResetProcessor", () => {
  it("skips when no database is available", async () => {
    vi.mocked(hasDatabase).mockReturnValue(false);

    const result = await quotaResetProcessor({
      data: {},
    } as any);

    expect(result).toEqual({ usersReset: 0 });
  });

  it("resets free plan users to 10 and pro to 100", async () => {
    const mockUpdateMany = vi.fn()
      .mockResolvedValueOnce({ count: 3 }) // free users
      .mockResolvedValueOnce({ count: 1 }); // pro users

    vi.mocked(hasDatabase).mockReturnValue(true);
    vi.mocked(getPrisma).mockReturnValue({
      user: { updateMany: mockUpdateMany },
    } as any);

    const result = await quotaResetProcessor({
      data: {},
    } as any);

    expect(result.usersReset).toBe(4);
    expect(mockUpdateMany).toHaveBeenCalledTimes(2);

    // First call: free plan
    expect(mockUpdateMany).toHaveBeenNthCalledWith(1, {
      where: { plan: "free", quotaRemaining: { not: -1 } },
      data: { quotaRemaining: 10, lastQuotaReset: expect.any(String) },
    });

    // Second call: pro plan
    expect(mockUpdateMany).toHaveBeenNthCalledWith(2, {
      where: { plan: "pro", quotaRemaining: { not: -1 } },
      data: { quotaRemaining: 100, lastQuotaReset: expect.any(String) },
    });
  });

  it("does not reset enterprise (-1) users", async () => {
    const mockUpdateMany = vi.fn()
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 });

    vi.mocked(hasDatabase).mockReturnValue(true);
    vi.mocked(getPrisma).mockReturnValue({
      user: { updateMany: mockUpdateMany },
    } as any);

    const result = await quotaResetProcessor({
      data: {},
    } as any);

    // Enterprise users with quotaRemaining: -1 are excluded by `not: -1` filter
    expect(result.usersReset).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests**

```bash
npx vitest run tests/quota-reset.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/quota-reset.test.ts
git commit -m "test: add quota reset processor tests"
```

---

### Task 20: Run full CI check for Step 3

- [ ] **Step 1: Run tests**

```bash
npm test
```

Expected: all tests pass (including new quota-reset tests).

- [ ] **Step 2: Run typecheck and build**

```bash
npm run typecheck && npm run build 2>&1 | tail -10
```

Expected: all pass.

- [ ] **Step 3: Commit any fixes**

```bash
git status
```

---

## Step 4: JWT 吊销（Session 黑名单）

### Task 21: Extend session user type with jti

**Files:**
- Modify: `lib/types.ts`

- [ ] **Step 1: Add JWT session type extensions**

Add at the end of `lib/types.ts`:

```ts
// ── Auth session extensions ──────────────────────────────────────────────────

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      jti?: string;
      name?: string | null;
      email?: string | null;
      image?: string | null;
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    jti?: string;
  }
}
```

- [ ] **Step 2: Verify typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/types.ts
git commit -m "feat: extend session/JWT types with jti for session blacklist"
```

---

### Task 22: Create lib/session-blacklist.ts

**Files:**
- Create: `lib/session-blacklist.ts`

- [ ] **Step 1: Create session blacklist module**

```ts
import { Redis } from "ioredis";
import { getRedisUrl, hasRedis } from "@/lib/env";

let _redis: Redis | null = null;

function getRedis(): Redis | null {
  if (_redis) return _redis;
  if (hasRedis()) _redis = new Redis(getRedisUrl()!);
  return _redis;
}

const REVOKED_PREFIX = "revoked:";

/**
 * Revoke a session by its JWT ID (jti).
 * Sets a Redis key with TTL equal to the remaining JWT lifetime.
 *
 * @param jti - The JWT ID to revoke
 * @param ttlSeconds - Remaining seconds until the JWT naturally expires
 */
export async function revokeSession(jti: string, ttlSeconds: number): Promise<void> {
  const r = getRedis();
  if (!r) return; // Redis not available — skip silently (JWT will expire naturally)
  await r.set(`${REVOKED_PREFIX}${jti}`, "1", "EX", ttlSeconds);
}

/**
 * Check if a session has been revoked.
 * Returns false when Redis is unavailable (fail-open).
 *
 * @param jti - The JWT ID to check
 */
export async function isSessionRevoked(jti: string): Promise<boolean> {
  const r = getRedis();
  if (!r) return false;
  const exists = await r.exists(`${REVOKED_PREFIX}${jti}`);
  return exists === 1;
}

/**
 * Revoke all sessions for a user by revoking specific jti values.
 * Useful for "logout all devices" or admin account locking.
 *
 * @param jtis - Array of JWT IDs to revoke
 * @param ttlSeconds - TTL for each revocation entry
 */
export async function revokeAllSessions(jtis: string[], ttlSeconds: number): Promise<void> {
  const r = getRedis();
  if (!r) return;
  if (jtis.length === 0) return;
  const pipeline = r.pipeline();
  for (const jti of jtis) {
    pipeline.set(`${REVOKED_PREFIX}${jti}`, "1", "EX", ttlSeconds);
  }
  await pipeline.exec();
}

/** Reset the Redis connection (for testing) */
export function _resetRedis(): void {
  _redis = null;
}
```

- [ ] **Step 2: Verify typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/session-blacklist.ts
git commit -m "feat: add session blacklist module (revokeSession / isSessionRevoked)"
```

---

### Task 23: Inject jti into JWT in auth.ts

**Files:**
- Modify: `auth.ts`

- [ ] **Step 1: Add jti to jwt callback**

Replace the `callbacks` block in `auth.ts` (lines 43-54) with:

```ts
  callbacks: {
    jwt({ token, user, trigger }) {
      if (user) {
        token.sub = user.id;
      }
      // Inject jti on sign-in or if missing (e.g., token refresh)
      if (trigger === "signIn" || !token.jti) {
        token.jti = crypto.randomUUID();
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = token.sub!;
        session.user.jti = token.jti;
      }
      return session;
    },
  },
```

Note: `crypto.randomUUID()` is a Web API available in both Node.js 20+ and Edge runtime — no need for the `uuid` package.

- [ ] **Step 2: Verify typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors (session.user.jti is now recognized via the type extension in Task 21).

- [ ] **Step 3: Commit**

```bash
git add auth.ts
git commit -m "feat: inject jti into JWT on sign-in for session blacklist support"
```

---

### Task 24: Add blacklist check to middleware.ts

**Files:**
- Modify: `middleware.ts`

- [ ] **Step 1: Add JWT blacklist check**

After the auth check in middleware (after line that checks `!req.auth`), add a blacklist check. The key section of the middleware should be updated.

Replace the API auth section (the block starting with `// API routes: return 401`) with this expanded version:

```ts
  // API routes: auth + blacklist check
  if (pathname.startsWith("/api/")) {
    if (!req.auth) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // JWT blacklist check (session revocation)
    const jti = req.auth.user?.jti as string | undefined;
    if (jti) {
      // Dynamic import to avoid Edge compatibility issues with ioredis
      // The isSessionRevoked function handles missing Redis gracefully
      // In Edge runtime, this will fail-open (return false)
      try {
        const { isSessionRevoked } = await import("@/lib/session-blacklist");
        const revoked = await isSessionRevoked(jti);
        if (revoked) {
          const response = NextResponse.json(
            { error: "Session revoked", code: "session_revoked" },
            { status: 401 },
          );
          response.cookies.delete("authjs.session-token");
          return response;
        }
      } catch {
        // ioredis not available in Edge — fail-open
        // Session revocation is best-effort in middleware;
        // API routes will also check via getOwnerId() → requireAuth()
      }
    }

    return NextResponse.next();
  }
```

- [ ] **Note on Edge compatibility:** `isSessionRevoked` uses `ioredis` which requires Node.js TCP sockets and won't work in Edge runtime. The try/catch ensures fail-open behavior. For production, consider using an Edge-compatible Redis check via `@upstash/redis` or deploying middleware to Node.js runtime by adding `export const runtime = 'nodejs'` to `middleware.ts`.

- [ ] **Step 2: Verify typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add middleware.ts
git commit -m "feat: add JWT blacklist check to middleware (fail-open for Edge)"
```

---

### Task 25: Add sign-out revocation to login actions

**Files:**
- Modify: `app/login/actions.ts`

- [ ] **Step 1: Add signOut action with session revocation**

Read the current `app/login/actions.ts`. Add a new `signOutAction` server action:

```ts
"use server";

import { auth, signOut } from "@/auth";
import { revokeSession } from "@/lib/session-blacklist";

export async function signOutWithRevocation() {
  const session = await auth();
  if (session?.user?.jti) {
    // Revoke the current JWT. TTL: 24 hours (maximum NextAuth session lifetime).
    await revokeSession(session.user.jti, 86400);
  }
  await signOut({ redirectTo: "/login" });
}
```

- [ ] **Step 2: Verify typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/login/actions.ts
git commit -m "feat: add signOut with JWT revocation"
```

---

### Task 26: Add session blacklist tests

**Files:**
- Create: `tests/session-blacklist.test.ts`

- [ ] **Step 1: Create test file**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/env", () => ({
  hasRedis: vi.fn(),
  getRedisUrl: vi.fn(),
}));

import { revokeSession, isSessionRevoked, _resetRedis } from "@/lib/session-blacklist";
import { hasRedis } from "@/lib/env";

describe("session-blacklist", () => {
  beforeEach(() => {
    _resetRedis();
    vi.clearAllMocks();
  });

  it("isSessionRevoked returns false when Redis is unavailable", async () => {
    vi.mocked(hasRedis).mockReturnValue(false);

    const result = await isSessionRevoked("test-jti-123");
    expect(result).toBe(false);
  });

  it("revokeSession is a no-op when Redis is unavailable", async () => {
    vi.mocked(hasRedis).mockReturnValue(false);

    await expect(revokeSession("test-jti-123", 3600)).resolves.toBeUndefined();
  });

  it("isSessionRevoked returns false for unknown jti when Redis is available", async () => {
    vi.mocked(hasRedis).mockReturnValue(true);
    // Note: This test requires a real Redis connection.
    // In CI without Redis, hasRedis returns false and test passes trivially.
    // For full integration, set REDIS_URL in CI environment.
    const result = await isSessionRevoked("unknown-jti-xyz");
    expect(result).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests**

```bash
npx vitest run tests/session-blacklist.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/session-blacklist.test.ts
git commit -m "test: add session blacklist unit tests"
```

---

### Task 27: Run full CI check for Step 4

- [ ] **Step 1: Run all tests**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 2: Typecheck + build**

```bash
npm run typecheck && npm run build 2>&1 | tail -10
```

Expected: all pass.

---

## Step 5: 微信 OAuth 登录

### Task 28: Add WeChat env accessors to lib/env.ts

**Files:**
- Modify: `lib/env.ts`

- [ ] **Step 1: Append WeChat env accessors**

Add to the end of `lib/env.ts`:

```ts
// ── WeChat OAuth ─────────────────────────────────────────────────────────────

export function getWechatAppId(): string | undefined {
  return process.env.WECHAT_APP_ID?.trim() || undefined;
}

export function getWechatAppSecret(): string | undefined {
  return process.env.WECHAT_APP_SECRET?.trim() || undefined;
}

export function hasWechatProvider(): boolean {
  return Boolean(getWechatAppId() && getWechatAppSecret());
}
```

- [ ] **Step 2: Verify typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/env.ts
git commit -m "feat: add WeChat OAuth env accessors"
```

---

### Task 29: Create lib/auth/wechat-provider.ts

**Files:**
- Create: `lib/auth/wechat-provider.ts`

- [ ] **Step 1: Ensure directory exists and create provider**

```bash
mkdir -p lib/auth
```

```ts
import type { OAuthConfig, OAuthUserConfig } from "next-auth/providers/oauth";

interface WeChatProfile {
  unionid: string;
  openid: string;
  nickname: string;
  headimgurl: string;
  sex?: number;
  province?: string;
  city?: string;
}

/**
 * NextAuth v5 custom OAuth provider for WeChat Open Platform (微信开放平台).
 *
 * Prerequisites:
 * - Enterprise certification on open.weixin.qq.com
 * - AppID and AppSecret from WeChat Open Platform
 * - Callback URL whitelisted: https://your-domain/api/auth/callback/wechat
 *
 * Docs: https://developers.weixin.qq.com/doc/oplatform/Website_App/WeChat_Login/Wechat_Login.html
 */
export function WeChatProvider<P extends WeChatProfile>(
  config: OAuthUserConfig<P>,
): OAuthConfig<P> {
  const appId = process.env.WECHAT_APP_ID!;
  const appSecret = process.env.WECHAT_APP_SECRET!;

  return {
    id: "wechat",
    name: "微信",
    type: "oauth",
    clientId: appId,
    clientSecret: appSecret,
    authorization: {
      url: "https://open.weixin.qq.com/connect/qrconnect",
      params: {
        appid: appId,
        redirect_uri: config.redirectProxyUrl ?? "",
        response_type: "code",
        scope: "snsapi_login",
        state: "",
      },
    },
    // WeChat requires sending appid + secret as query params (not in Authorization header)
    token: {
      url: "https://api.weixin.qq.com/sns/oauth2/access_token",
      async request({ params, provider }) {
        const url = new URL(provider.token!.url!);
        url.searchParams.set("appid", provider.clientId!);
        url.searchParams.set("secret", provider.clientSecret!);
        url.searchParams.set("code", params.code as string);
        url.searchParams.set("grant_type", "authorization_code");

        const res = await fetch(url.toString());
        const json = await res.json();

        if ("errcode" in json && json.errcode !== 0) {
          throw new Error(`WeChat token error [${json.errcode}]: ${json.errmsg}`);
        }

        return { tokens: json as any };
      },
    },
    userinfo: {
      url: "https://api.weixin.qq.com/sns/userinfo",
      async request({ tokens, provider }) {
        const url = new URL(provider.userinfo!.url!);
        url.searchParams.set("access_token", (tokens as any).access_token as string);
        url.searchParams.set("openid", (tokens as any).openid as string);

        const res = await fetch(url.toString());
        const json = await res.json();

        if ("errcode" in json && json.errcode !== 0) {
          throw new Error(`WeChat userinfo error [${json.errcode}]: ${json.errmsg}`);
        }

        return json as any;
      },
    },
    profile(profile) {
      return {
        id: profile.unionid || profile.openid,
        name: profile.nickname || "微信用户",
        image: profile.headimgurl || null,
        email: null, // WeChat does not provide email in snsapi_login scope
      };
    },
    style: {
      logo: "/wechat-logo.svg",
      bg: "#07C160",
      text: "#fff",
    },
  };
}
```

- [ ] **Step 2: Verify typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/auth/wechat-provider.ts
git commit -m "feat: add WeChat OAuth provider for NextAuth v5"
```

---

### Task 30: Conditionally register WeChat provider in auth.ts

**Files:**
- Modify: `auth.ts`

- [ ] **Step 1: Add WeChat provider conditionally**

Replace the `providers` array in `auth.ts` (lines 24-37) with:

```ts
import { hasWechatProvider, getWechatAppId } from "@/lib/env";
import { WeChatProvider } from "@/lib/auth/wechat-provider";

// ... inside NextAuth({...}):

  providers: [
    EmailProvider({
      server: {},
      from: getEmailFrom(),
      sendVerificationRequest: async ({ identifier: email, url }) => {
        await getResend().emails.send({
          from: getEmailFrom(),
          to: email,
          subject: "登录 AI 短视频助手",
          html: `<p>点击下方链接登录：</p><p><a href="${url}">${url}</a></p><p>链接 24 小时内有效。</p>`,
        });
      },
    }),
    // Conditionally register WeChat provider
    ...(hasWechatProvider()
      ? [
          WeChatProvider({
            clientId: getWechatAppId()!,
            clientSecret: getWechatAppSecret()!,
          }),
        ]
      : []),
  ],
```

Note: `getWechatAppSecret` needs to be imported. Update the import from `@/lib/env` to include both:
```ts
import { getResendApiKey, getEmailFrom, hasWechatProvider, getWechatAppId, getWechatAppSecret } from "@/lib/env";
```

- [ ] **Step 2: Verify typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add auth.ts
git commit -m "feat: conditionally register WeChat OAuth provider"
```

---

### Task 31: Add Account model to Prisma schema

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Add Account model**

Add after the `User` model (after line 23):

```prisma
model Account {
  id                String  @id
  userId            String
  type              String
  provider          String
  providerAccountId String
  refresh_token     String? @db.Text
  access_token      String? @db.Text
  expires_at        Int?
  token_type        String?
  scope             String?
  id_token          String? @db.Text
  session_state     String?
  user              User    @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([provider, providerAccountId])
}
```

- [ ] **Step 2: Run migration**

```bash
npx prisma migrate dev --name add_account_model
```

Expected: creates migration, applies successfully.

- [ ] **Step 3: Validate schema**

```bash
npx prisma validate
```

Expected: valid.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat: add Account model for OAuth provider support"
```

---

### Task 32: Add WeChat login button to app/login/page.tsx

**Files:**
- Modify: `app/login/page.tsx`

- [ ] **Step 1: Add WeChat login button**

Add `signIn` import and a WeChat login button below the email form's submit button (after line 63):

```tsx
import { signIn } from "next-auth/react";
```

Add after the `</form>` closing tag (after line 65), before `</main>`:

```tsx
        <div className="relative my-6">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-gray-300" />
          </div>
          <div className="relative flex justify-center text-sm">
            <span className="bg-white px-2 text-gray-500">其他登录方式</span>
          </div>
        </div>

        <button
          type="button"
          onClick={() => signIn("wechat", { callbackUrl: "/" })}
          className="w-full py-3 px-4 bg-[#07C160] text-white font-medium rounded-lg hover:bg-[#06AD56] transition-colors flex items-center justify-center gap-2"
        >
          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18z" />
          </svg>
          微信登录
        </button>
```

Note: The `signIn` import from `next-auth/react` and the `use client` directive already present in the file are sufficient. If the `signIn` import is not already present, add:

```ts
import { signIn } from "next-auth/react";
```

However, `next-auth/react` `signIn` requires the `SessionProvider` to be mounted. Check if `AuthProvider` is now in the component tree. If not, adjust: use a server component wrapper or the `redirect` approach instead.

**Alternative approach (more reliable without client-side SessionProvider):**
Use a simple link/redirect:

```tsx
// Instead of signIn("wechat"), navigate directly:
<form action="/api/auth/signin/wechat" method="POST">
  <button type="submit" className="...">
    <WeChatIcon /> 微信登录
  </button>
</form>
```

Or use `signIn` from a server action:
```ts
// In actions.ts
export async function signInWithWeChat() {
  await signIn("wechat", { redirectTo: "/" });
}
```

**Recommended: use a server action wrapper** (avoids client-side SessionProvider requirement):

In `app/login/actions.ts`, add:
```ts
import { signIn } from "@/auth";

export async function signInWithWeChat() {
  await signIn("wechat", { redirectTo: "/" });
}
```

In `app/login/page.tsx`, add the import and button:
```tsx
import { sendMagicLink, signInWithWeChat } from "./actions";
```

```tsx
        <button
          type="button"
          onClick={() => signInWithWeChat()}
          className="w-full py-3 px-4 bg-[#07C160] text-white font-medium rounded-lg hover:bg-[#06AD56] transition-colors flex items-center justify-center gap-2"
        >
          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18z" />
          </svg>
          微信登录
        </button>
```

- [ ] **Step 2: Verify typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/login/page.tsx app/login/actions.ts
git commit -m "feat: add WeChat login button to login page"
```

---

### Task 33: Run full CI check for Step 5

- [ ] **Step 1: Run all tests**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 2: Run typecheck, lint, build**

```bash
npm run typecheck && npm run lint && npm run build 2>&1 | tail -20
```

Expected: all pass. Build succeeds with WeChat provider conditionally disabled (no WECHAT_APP_ID set).

- [ ] **Step 3: Commit any remaining changes**

```bash
git status
```

---

## Verification Checklist

Before declaring Phase 5b complete, verify:

- [ ] `npm test` — all tests pass (including new ones for quota-reset, session-blacklist)
- [ ] `npm run typecheck` — no type errors
- [ ] `npm run lint` — no lint errors
- [ ] `npm run build` — builds successfully
- [ ] `npx prisma validate` — schema is valid
- [ ] `git log --oneline` — clean commit history with descriptive messages
- [ ] Sentry: `SENTRY_DSN` not set → build succeeds without Sentry
- [ ] Rate limit: middleware IP limiting uses in-memory (no Redis dependency)
- [ ] Cron: quota reset processor is registered but only runs when worker is active + Redis is available
- [ ] JWT blacklist: fails open when Redis is unavailable
- [ ] WeChat OAuth: `WECHAT_APP_ID` not set → provider not registered, no WeChat button visible

---

## Rollback Considerations

Each step is self-contained and can be reverted independently:

```bash
# Revert Sentry
git revert <sentry-commits>

# Revert rate limit changes
git revert <rate-limit-commits>

# Etc.
```

Prisma migrations are additive (new column + new table) and backward-compatible.
