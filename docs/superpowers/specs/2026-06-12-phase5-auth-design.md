# Phase 5 — 认证、配额、限流：设计文档

**日期：** 2026-06-12
**状态：** 待实施
**依赖：** Auth.js v5 (next-auth@beta) + Resend + 已有 Prisma / Redis

---

## 1. 目标

为 AI Video Assistant 添加登录、配额控制与 API 限流，使之可对外开放注册使用。

### 范围

| 模块 | 内容 |
|------|------|
| Auth | Magic Link 邮箱登录、JWT session、middleware 路由保护 |
| Quota | 原子扣减，Plan 差异化预留，402 响应 |
| Rate Limit | L1 登录防刷 + L2 API 限流，固定窗口，Redis / 内存双后端 |

### 不做（Phase 5b+）

- OAuth / 微信登录
- Session 黑名单（JWT 吊销）
- Cron 配额月度重置
- Sentry 集成、安全响应头
- Middleware 统一限流（首期 per-route）

---

## 2. 认证架构

### 2a. 包选型

| 包 | 用途 |
|---|------|
| `next-auth@beta` | Auth.js v5 核心 |
| `@auth/prisma-adapter` | User / VerificationToken 表对接 |
| `resend` | Magic Link 邮件发送 |

### 2b. 文件布局

```
auth.ts                                   ← Auth.js 配置（根目录）
app/api/auth/[...nextauth]/route.ts       ← 路由处理
app/login/page.tsx                        ← 邮箱输入页
app/login/verify/page.tsx                 ← "请查收邮件" 提示页
app/login/actions.ts                      ← Server Action: sendMagicLink()
middleware.ts                             ← 路由保护
lib/auth-helpers.ts                       ← requireAuth() / getOwnerId()
components/auth-provider.tsx              ← SessionProvider 包裹
```

### 2c. auth.ts 配置

```ts
import NextAuth from "next-auth";
import EmailProvider from "next-auth/providers/email";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { Resend } from "resend";
import { getPrisma } from "@/lib/prisma";
import { getResendApiKey, getEmailFrom } from "@/lib/env";

const resend = new Resend(getResendApiKey());

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: {
    ...PrismaAdapter(getPrisma()),
    createUser: async (data) => {
      return getPrisma().user.create({
        data: { ...data, plan: "free", quotaRemaining: 10 },
      });
    },
  },
  providers: [
    EmailProvider({
      server: {},
      from: getEmailFrom(),
      sendVerificationRequest: async ({ identifier: email, url }) => {
        await resend.emails.send({
          from: getEmailFrom(),
          to: email,
          subject: "登录 AI 短视频助手",
          html: `<p>点击下方链接登录：</p><p><a href="${url}">${url}</a></p><p>链接 24 小时内有效。</p>`,
        });
      },
    }),
  ],
  session: { strategy: "jwt" },
  pages: {
    signIn: "/login",
    verifyRequest: "/login/verify",
  },
  callbacks: {
    jwt({ token, user }) {
      if (user) token.sub = user.id;
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = token.sub!;
      }
      return session;
    },
  },
});
```

**环境变量：**

| 变量 | 说明 | 示例 |
|------|------|------|
| `AUTH_SECRET` | JWT 签名密钥 | `openssl rand -hex 32` |
| `AUTH_URL` | 回调 URL 前缀 | `http://localhost:3000` 或 `https://你的域名` |
| `RESEND_API_KEY` | Resend API key | `re_xxx` |
| `EMAIL_FROM` | 发件地址 | `"AI短视频助手 <noreply@你的域名.com>"` |

- `AUTH_URL` 生产必须与用户实际访问的域名完全一致（含 https、是否带 www）
- 本地开发 Resend 可用 `onboarding@resend.dev` 发件地址（仅能发到 Resend 账号邮箱）

**`lib/env.ts` 新增 accessor（遵循项目约定，不直接读 `process.env`）：**

```ts
export function getAuthSecret(): string | undefined {
  return process.env.AUTH_SECRET?.trim() || undefined;
}
export function getAuthUrl(): string | undefined {
  return process.env.AUTH_URL?.trim() || undefined;
}
export function getResendApiKey(): string | undefined {
  return process.env.RESEND_API_KEY?.trim() || undefined;
}
export function getEmailFrom(): string {
  return process.env.EMAIL_FROM?.trim() || "AI短视频助手 <noreply@resend.dev>";
}
```

`auth.ts` 中应使用这些 accessor 而非直接读 `process.env`。

### 2d. Magic Link 流程

```
1. 用户打开 /login → 输入邮箱
2. Server Action sendMagicLink(email)：
   a. L1 限流检查（IP + 邮箱）
   b. signIn("email", { email, redirectTo: "/login/verify?email=..." })
   c. Auth.js 生成 token → 写 VerificationToken 表
   d. Resend 发邮件
3. 用户看到 /login/verify — "若邮箱存在，我们会发送邮件"
4. 用户点击邮件链接
5. GET /api/auth/callback/email?token=xxx
   a. 校验 token（存在 + 未过期）
   b. 删 VerificationToken
   c. 查/创 User，更新 emailVerified
   d. 生成 JWT → set cookie
   e. 302 → /
```

### 2e. 新用户初始化

PrismaAdapter 通过 `createUser` 创建用户。需在 auth.ts 中覆盖 adapter 的 `createUser` 方法，为新用户注入默认 `plan` 和 `quotaRemaining`：

```ts
adapter: {
  ...PrismaAdapter(getPrisma()),
  createUser: async (data) => {
    return getPrisma().user.create({
      data: { ...data, plan: "free", quotaRemaining: 10 },
    });
  },
},
```

### 2f. 中间件 & 路由保护

```ts
// middleware.ts
import { auth } from "@/auth";
import { NextResponse } from "next/server";

const isDemo = process.env.APP_MODE !== "production";

export default auth((req) => {
  // demo：全放行，ownerId 由 route 层 getOwnerId() 决定
  if (isDemo) return NextResponse.next();

  const { pathname } = req.nextUrl;

  // 公开路径
  if (
    pathname.startsWith("/api/auth") ||
    pathname === "/api/health" ||
    pathname.startsWith("/login") ||
    pathname.startsWith("/_next")
  ) {
    return NextResponse.next();
  }

  // API 未登录 → 401
  if (pathname.startsWith("/api/")) {
    if (!req.auth) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.next();
  }

  // 页面未登录 → 重定向 /login?callbackUrl=原路径
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

### 2g. API route helper

```ts
// lib/auth-helpers.ts
import { auth } from "@/auth";
import { getAppMode } from "@/lib/env";
import { demoOwnerId } from "@/lib/runtime-store";

class UnauthorizedError extends Error {
  constructor() { super("Unauthorized"); }
}

// 生产强校验
export async function requireAuth(): Promise<{ userId: string }> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) throw new UnauthorizedError();
  return { userId };
}

// 统一起口：demo 回退 demoOwnerId
export async function getOwnerId(): Promise<string> {
  if (getAppMode() === "demo") {
    const session = await auth();
    return session?.user?.id ?? demoOwnerId;
  }
  return (await requireAuth()).userId;
}
```

### 2h. 禁止 body.ownerId（IDOR 修复）

- **所有 route 的 `ownerId` 来源只能是 `getOwnerId()`**
- `body.ownerId` 永远不被信任
- 按 ID 操作资源时，先校验 `resource.ownerId === await getOwnerId()`，不等返回 404（不暴露资源存在性）

### 2i. 环境行为表

| 模式 | Middleware | getOwnerId() | 必需登录 |
|------|-----------|-------------|----------|
| demo | 全放行 | auth() ?? demoOwnerId | 否 |
| production | 强制登录 | auth().user.id，空则 401 | 是 |

---

## 3. 数据库 Schema 变更

### 3a. 新增表

```prisma
model VerificationToken {
  identifier String
  token      String   @unique
  expires    DateTime
  @@unique([identifier, token])
}
```

### 3b. User 表补字段

```prisma
model User {
  // ... existing ...
  emailVerified DateTime?   // 新增
  image         String?     // 新增（未来 OAuth 预留）
}
```

### 3c. 账户表（Account）暂不加

OAuth 阶段引入，减轻首期 migration 复杂度。

---

## 4. 配额

### 4a. 核心逻辑

```ts
// lib/quota.ts
import { getPrisma } from "@/lib/prisma";
import { hasDatabase } from "@/lib/env";
import { demoOwnerId } from "@/lib/runtime-store";

const UNLIMITED = -1;

export class QuotaExhaustedError extends Error {
  constructor(public plan: string) { super("Quota exhausted"); }
}

// 只读展示（Dashboard 用）
export async function getQuotaInfo(userId: string) {
  if (!hasDatabase()) return { plan: "free", remaining: 10 };
  const user = await getPrisma().user.findUniqueOrThrow({ where: { id: userId } });
  return { plan: user.plan, remaining: user.quotaRemaining };
}

// 原子扣减（写路径唯一入口）
export async function consumeQuota(userId: string): Promise<{ plan: string; remaining: number }> {
  // demo 不扣
  if (userId === demoOwnerId) return { plan: "free", remaining: 10 };
  // 无 DB 跳过
  if (!hasDatabase()) return { plan: "free", remaining: 10 };

  const user = await getPrisma().user.findUniqueOrThrow({ where: { id: userId } });
  // 无限用户跳过扣减
  if (user.quotaRemaining === UNLIMITED) {
    return { plan: user.plan, remaining: UNLIMITED };
  }

  // 原子更新
  const result = await getPrisma().user.updateMany({
    where: { id: userId, quotaRemaining: { gt: 0 } },
    data: { quotaRemaining: { decrement: 1 } },
  });
  if (result.count === 0) {
    throw new QuotaExhaustedError(user.plan);
  }

  const updated = await getPrisma().user.findUniqueOrThrow({ where: { id: userId } });
  return { plan: updated.plan, remaining: updated.quotaRemaining };
}
```

### 4b. Plan 差异

| Plan | Quota | 备注 |
|------|-------|------|
| `free` | 10/月 | 默认，新用户自动分配 |
| `pro` | 100/月 | 二期定价 |
| `enterprise` | -1（无限） | 二期定价 |

首期新用户统一 `free`。

### 4c. render-projects 扣费流程

```
POST /api/render-projects

1. ownerId = getOwnerId()
2. 查 scriptDraft → 校验 draft.ownerId === ownerId（否则 404）
3. consumeQuota(ownerId)                    ← 失败 = 402
4. 建立 project + jobs（DB 事务）
5. enqueue Redis（不阻塞响应）
```

enqueue 失败不退配额（首期接受，Phase 5b 加补偿 job）。

### 4d. 环境行为表

| 条件 | 行为 |
|------|------|
| `userId === demoOwnerId` | 跳过扣减 |
| `!hasDatabase()` | 跳过扣减 |
| `quotaRemaining === -1` | 跳过扣减，返回无限 |
| `quotaRemaining > 0` | 原子 `decrement: 1` |
| `quotaRemaining === 0` | `QuotaExhaustedError` → 402 |

### 4e. 402 响应格式

```ts
// lib/api-response.ts
export function jsonQuotaError(plan: string): Response {
  return Response.json(
    { error: "quota_exhausted", plan, message: `Your ${plan} plan quota is exhausted` },
    { status: 402 }
  );
}
```

---

## 5. 限流

### 5a. 分层策略

| 层级 | 目标 | 算法 | Key | 窗口 | 响应 |
|------|------|------|-----|------|------|
| L1 | 登录邮箱 | INCR 固定窗口 | `login:ip:<ip>` | 5/min, 20/hour | 200（同成功文案） |
| L1 | 登录邮箱 | INCR 固定窗口 | `login:email:<norm>` | 1/min | 200（同成功文案） |
| L2 | 通用 API | INCR 固定窗口 | `api:<key>` | 60/min (GET) | 200 / 429 + headers |
| L2 | 写 API | INCR 固定窗口 | `api:<key>` | 20/min (POST/PUT/DELETE) | 200 / 429 + headers |

### 5b. 后端选型

| 环境 | 后端 | 行为 |
|------|------|------|
| dev（有 Redis） | Redis INCR | 正常 |
| dev（无 Redis） | 内存 Map | 正常（单进程） |
| production（有 Redis） | Redis INCR | 正常 |
| production（无 Redis） | `"none"` + console.warn | 放行（需修复） |

### 5c. 核心实现

```ts
// lib/rate-limit.ts
import { hasRedis, getRedisUrl, getAppMode } from "@/lib/env";
import { Redis } from "ioredis";

// ── 配置 ──
interface RateLimitConfig { windowSeconds: number; maxRequests: number; }

const LOGIN_IP_PER_MINUTE: RateLimitConfig = { windowSeconds: 60, maxRequests: 5 };
const LOGIN_IP_PER_HOUR: RateLimitConfig = { windowSeconds: 3600, maxRequests: 20 };
const LOGIN_EMAIL_PER_MINUTE: RateLimitConfig = { windowSeconds: 60, maxRequests: 1 };
const API_READ: RateLimitConfig = { windowSeconds: 60, maxRequests: 60 };
const API_WRITE: RateLimitConfig = { windowSeconds: 60, maxRequests: 20 };

// ── Redis 懒加载 ──
let _redis: Redis | null = null;
function getRedis(): Redis | null {
  if (_redis) return _redis;
  if (hasRedis()) _redis = new Redis(getRedisUrl()!);
  return _redis;
}

// ── IP 提取 ──
export function getClientIp(headersList: { get(name: string): string | null }): string {
  const forwarded = headersList.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim() || "unknown";
  return headersList.get("x-real-ip") ?? "unknown";
}

// ── 邮箱规范化 ──
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// ── 结果类型 ──
export interface RateLimitResult { allowed: boolean; remaining: number; reset: number; }

// ── Redis 固定窗口 ──
async function redisFixedWindow(key: string, config: RateLimitConfig): Promise<RateLimitResult> {
  const r = getRedis()!;
  const count = await r.incr(key);
  if (count === 1) await r.expire(key, config.windowSeconds);
  const ttlRemaining = await r.ttl(key);
  return {
    allowed: count <= config.maxRequests,
    remaining: Math.max(0, config.maxRequests - count),
    reset: Math.floor(Date.now() / 1000) + (ttlRemaining > 0 ? ttlRemaining : config.windowSeconds),
  };
}

// ── 内存 fallback ──
const memoryStore = new Map<string, { count: number; reset: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of memoryStore) {
    if (entry.reset <= now) memoryStore.delete(key);
  }
}, 60_000);

function memoryFixedWindow(key: string, config: RateLimitConfig): RateLimitResult {
  const now = Date.now();
  const entry = memoryStore.get(key);
  if (!entry || entry.reset <= now) {
    const reset = now + config.windowSeconds * 1000;
    memoryStore.set(key, { count: 1, reset });
    return { allowed: true, remaining: config.maxRequests - 1, reset: Math.floor(reset / 1000) };
  }
  entry.count++;
  return {
    allowed: entry.count <= config.maxRequests,
    remaining: Math.max(0, config.maxRequests - entry.count),
    reset: Math.floor(entry.reset / 1000),
  };
}

// ── 后端分发 ──
function resolveBackend(): "redis" | "memory" | "none" {
  if (getRedis()) return "redis";
  if (getAppMode() === "production") {
    console.warn("[rate-limit] REDIS_URL missing in production — rate limiting disabled");
    return "none";
  }
  return "memory";
}

async function checkLimit(key: string, config: RateLimitConfig): Promise<RateLimitResult> {
  const backend = resolveBackend();
  if (backend === "none") return { allowed: true, remaining: 999, reset: 0 };
  if (backend === "redis") return redisFixedWindow(key, config);
  return memoryFixedWindow(key, config);
}

// ── 公开 API ──
export async function rateLimitLogin(ip: string, email: string): Promise<boolean> {
  const normalized = normalizeEmail(email);
  const [ipMin, ipHour, emailMin] = await Promise.all([
    checkLimit(`login:ip:min:${ip}`, LOGIN_IP_PER_MINUTE),
    checkLimit(`login:ip:hour:${ip}`, LOGIN_IP_PER_HOUR),
    checkLimit(`login:email:${normalized}`, LOGIN_EMAIL_PER_MINUTE),
  ]);
  return ipMin.allowed && ipHour.allowed && emailMin.allowed;
}

export async function rateLimitApi(key: string, method: string): Promise<RateLimitResult> {
  if (getAppMode() === "demo") return { allowed: true, remaining: 999, reset: 0 };
  const config = ["POST", "PUT", "DELETE"].includes(method) ? API_WRITE : API_READ;
  return checkLimit(`api:${key}`, config);
}

// ── Response headers ──
export function ratelimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": String(result.reset),
    ...(result.allowed ? {} : { "Retry-After": String(Math.max(0, result.reset - Math.floor(Date.now() / 1000))) }),
  };
}
```

### 5d. 集成点

**L1 — Server Action（永远 200）：**

```ts
// app/login/actions.ts
"use server";
import { rateLimitLogin, getClientIp } from "@/lib/rate-limit";
import { signIn } from "@/auth";
import { headers } from "next/headers";

export async function sendMagicLink(email: string) {
  const ip = getClientIp(await headers());
  if (!(await rateLimitLogin(ip, email))) {
    return { success: true, message: "若邮箱存在，我们会发送邮件" };
  }
  await signIn("email", { email, redirectTo: "/login/verify" });
  return { success: true, message: "若邮箱存在，我们会发送邮件" };
}
```

**L2 — API route：**

```ts
const ownerId = await getOwnerId();
const rl = await rateLimitApi(ownerId, request.method);
if (!rl.allowed) {
  return jsonRateLimited(rl);
}
```

### 5e. Response helpers

```ts
// lib/api-response.ts — 新增

export function jsonRateLimited(result: RateLimitResult): Response {
  return Response.json(
    { error: "rate_limited", retryAfter: result.reset - Math.floor(Date.now() / 1000) },
    { status: 429, headers: ratelimitHeaders(result) }
  );
}

export function jsonQuotaError(plan: string): Response {
  return Response.json(
    { error: "quota_exhausted", plan, message: `Your ${plan} plan quota is exhausted` },
    { status: 402 }
  );
}
```

---

## 6. 环境变量清单

| 变量 | Phase | 必填 | 说明 |
|------|-------|------|------|
| `AUTH_SECRET` | 5 | 是 | JWT 签名密钥 |
| `AUTH_URL` | 5 | 是 | 回调 URL 前缀 |
| `RESEND_API_KEY` | 5 | 是 | Resend API key |
| `EMAIL_FROM` | 5 | 否 | 发件地址（默认 `noreply@resend.dev`） |
| `APP_MODE` | 0 | 否 | demo / production |
| `DATABASE_URL` | 1 | 是* | *production 必填 |
| `REDIS_URL` | 3 | 建议 | 限流后端 + BullMQ |

---

## 7. 环境行为总表

| 条件 | Auth | Quota | Rate Limit L1 | Rate Limit L2 |
|------|------|-------|---------------|---------------|
| `APP_MODE=demo` | 放行（回退 demoOwnerId） | 不扣 | 登录限流生效 | 跳过 |
| `APP_MODE=production` | 强制登录 | 正常扣减 | 登录限流生效 | 正常执行 |
| `!DATABASE_URL` | JWT 验签仍可用；新登录/写 User 不可用 | 跳过 | 正常工作 | 正常工作 |
| `!REDIS_URL` + dev | — | — | 内存 fallback | 内存 fallback |
| `!REDIS_URL` + prod | — | — | 放行 + warn | 放行 + warn |

---

## 8. 测试策略

| 模块 | 测试内容 |
|------|----------|
| auth | middleware 鉴权矩阵（demo/production × 登录/未登录 × API/页面） |
| auth | requireAuth / getOwnerId 单元测试 |
| auth | Server Action sendMagicLink 调用契约 |
| quota | consumeQuota 原子扣减测试（并发模拟） |
| quota | 无限用户、demo 用户、无 DB 场景 |
| rate-limit | 固定窗口计数正确性 |
| rate-limit | L1 双窗口独立验证 |
| rate-limit | 内存 fallback 行为 |
| integration | 每个 API route 的 auth + quota + rate-limit 组合场景 |

---

## 9. 实施顺序

| 步骤 | 内容 | 依赖 |
|------|------|------|
| 1 | 安装依赖：next-auth@beta, @auth/prisma-adapter, resend | — |
| 2 | Prisma migration：VerificationToken + User 补字段 | — |
| 3 | auth.ts 配置 + [...nextauth] route | 1, 2 |
| 4 | middleware.ts | 3 |
| 5 | lib/auth-helpers.ts (requireAuth / getOwnerId) | 3 |
| 6 | /login 页面 + Server Action | 3, 5 |
| 7 | 全量 API route 切 ownerId 来源（去 demoOwnerId 硬编码） | 5 |
|   | 涉及文件：`app/api/store-profiles/route.ts`、`app/api/assets/route.ts`、`app/api/assets/upload-intent/route.ts`、`app/api/assets/confirm/route.ts`、`app/api/assets/analyze/route.ts`、`app/api/avatars/route.ts`、`app/api/script-drafts/route.ts`、`app/api/render-projects/route.ts`、`app/api/jobs/route.ts` | |
| 8 | IDOR 修复：资源归属校验（按 ID 操作资源时校验 `resource.ownerId === await getOwnerId()`） | 5 |
| 9 | lib/quota.ts + render-projects 集成 | 7 |
| 10 | lib/rate-limit.ts + 集成 | 7 |
| 11 | lib/api-response.ts 扩展（jsonQuotaError / jsonRateLimited） | 9, 10 |
| 12 | 测试 + typecheck + lint + build | 全部 |

---

## 10. 决策记录

| 决策 | 选择 | 备选 / 原因 |
|------|------|-------------|
| Auth 方案 | Auth.js v5 | Clerk（付费）；Auth.js 无 vendor lock-in |
| Session 策略 | JWT | Database Session（Edge middleware 不兼容 Prisma） |
| 邮箱发送 | Resend | 免费 100 封/天，MVP 够用 |
| 限流算法 | INCR 固定窗口 | 滑动窗口 ZSET（off-by-one，固定窗口足够） |
| 限流后端 | Redis 主 / 内存 fallback | Upstash（已有 ioredis） |
| Quota 原子性 | updateMany + gt 0 条件 | 单独 check-then-decrement（并发不安全） |
| Demo 模式 | 全放行、不扣配额、L2 不限 | 与现有匿名 demo_user 行为兼容 |

---

## 11. 风险

| 风险 | 缓解 |
|------|------|
| Resend 额度耗尽 | L1 限流护住；监控 Resend dashboard |
| JWT 无法即时吊销 | Phase 5b 加 token 黑名单表 |
| 内存 fallback 多实例不共享 | production 标记 warn，督促接 Redis |
| Prisma adapter createUser 覆盖 | adapter 定制逻辑轻量，测试覆盖 |
| Magic Link 邮件进垃圾箱 | Resend 已验证域名；`EMAIL_FROM` 设真实域名 |
