# Phase 5b — Auth 短板补齐：设计文档

**日期：** 2026-06-14
**状态：** 待实施
**依赖：** Phase 5（Auth.js v5 + JWT + Magic Link + Quota + Rate Limit）

---

## 1. 目标

在 Phase 5 已完成的 Magic Link 邮箱登录、配额、限流基础上，补齐 5 个短板：

| # | 子系统 | 目标 |
|---|--------|------|
| 1 | Sentry 错误追踪 | 生产环境全栈错误监控 |
| 2 | Middleware 统一限流 | 将 per-route 限流提升到 Middleware 层，减少重复代码 |
| 3 | Cron 配额月度重置 | 每月 1 日自动重置用户配额 |
| 4 | JWT 吊销（Session 黑名单） | 支持主动登出、账号异常锁定 |
| 5 | 微信 OAuth 登录 | 微信开放平台扫码登录 |

**实施顺序：** Sentry → Middleware 限流 → Cron 配额 → JWT 吊销 → 微信 OAuth

---

## 2. Sentry 错误追踪

### 2a. 包选型

| 包 | 版本 | 用途 |
|---|------|------|
| `@sentry/nextjs` | ^9.x | Next.js 全栈 SDK（client / server / edge） |

### 2b. 文件布局

```
sentry.client.config.ts       ← 浏览器端 Sentry 初始化
sentry.server.config.ts       ← Node.js 服务端 Sentry 初始化
sentry.edge.config.ts         ← Edge Runtime Sentry 初始化
instrumentation.ts            ← Next.js 服务端入口 hook
app/global-error.tsx          ← 根错误边界 UI
app/error.tsx                 ← 路由级错误边界 UI
```

### 2c. 核心配置

**环境变量（`lib/env.ts` 新增）：**

```ts
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

**环境行为：**

| 条件 | 行为 |
|------|------|
| `SENTRY_DSN` 已设置 | 启用 Sentry（client + server） |
| `SENTRY_DSN` 未设置 | Sentry 完全跳过，`console.*` 照常工作 |

### 2d. instrumentation.ts

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

### 2e. 全局错误页面

`app/global-error.tsx` — 捕获根布局错误，提供"刷新页面"按钮。
`app/error.tsx` — 路由级错误，提供"重试"按钮。

### 2f. 现有 console.* 处理

**不替换** 现有的 `console.error`/`console.warn` 调用。Sentry 自动捕获 `console.error`。项目现有的 `[module-name]` 前缀约定保留，Sentry 会将其作为 breadcrumb 记录。

### 2g. 上报范围

| 环境 | 上报 |
|------|------|
| Server-side (Node.js) | API 异常、Prisma 错误、AI 调用失败 |
| Edge (middleware) | Auth 失败、限流触发 |
| Client-side | React 渲染错误、未捕获异常 |

### 2h. 源码上传（Source Maps）

- `next.config.ts` 中启用 `sentry.sourceMapsUpload` 仅在 CI 环境（`CI=true`）
- 上传需要 `SENTRY_AUTH_TOKEN` + `SENTRY_ORG` + `SENTRY_PROJECT`
- 本地 dev 不上传 source maps 到 Sentry

---

## 3. Middleware 统一限流

### 3a. 当前问题

Phase 5 的 L2 限流在 13 个 API route 文件中各自调用 `rateLimitApi(ownerId, method)`。重复代码多，且限流发生在 auth 之后（已浪费 DB 查询）。

### 3b. 目标架构

两层限流，防御深度：

```
Request
  ↓
middleware.ts
  ├─ demo mode → next()
  ├─ public path → next()
  ├─ [外层] IP-based 限流（auth 之前，Edge 安全，in-memory）
  ├─ auth check
  └─ next()
  ↓
API Route Handler
  ├─ [内层] userId-based 限流（auth 之后，ioredis/Redis）
  └─ business logic
```

| 层 | 位置 | 运行时 | 后端 | Key | 限频 | 目的 |
|----|------|--------|------|-----|------|------|
| 外层 | middleware.ts | Edge | In-memory Map | `ip:<ip>` | 60/min 全路径 | 防 DDoS/扫描，轻量级 |
| 内层 | route handler | Node.js | ioredis → Redis | `api:<userId>:<method>` | 60r/20w per min | 精确用户级控速 |
| L1 | Server Action | Node.js | ioredis/内存 | `login:ip/email:<x>` | 5/min, 20/hr, 1/min | 登录防刷（不变） |

### 3c. 为什么不在 Middleware 做 userId-based 限流

- Middleware 运行在 Edge Runtime，`ioredis` 不兼容
- `@upstash/redis` 需要独立的 REST API endpoint，增加外部依赖和延迟
- 内层限流仅 2 行代码，通过提取 `applyRateLimit()` helper 消除重复（见 3d）
- 外层 in-memory IP 限流在 Edge 运行时零额外延迟，足以拦截恶意流量

### 3d. API Route 去重

将 13 个 route 文件中的 2 行限流调用提取为一个 helper：

```ts
// lib/rate-limit.ts 新增
export async function applyRateLimit(
  request: Request,
  ownerId: string
): Promise<Response | null> {
  const rl = await rateLimitApi(ownerId, request.method);
  if (!rl.allowed) return jsonRateLimited(rl);
  return null; // null = 未触发限流，继续处理
}
```

每个 route 调用从：
```ts
const rl = await rateLimitApi(ownerId, request.method);
if (!rl.allowed) return jsonRateLimited(rl);
```
简化为：
```ts
const limited = await applyRateLimit(request, ownerId);
if (limited) return limited;
```

`rateLimitApi()` 底层逻辑不变，只是调用点统一。

### 3e. 文件变更清单

| 文件 | 变更 |
|------|------|
| `middleware.ts` | 新增 IP-based 限流（in-memory，Edge 安全） |
| `lib/rate-limit.ts` | 新增 `applyRateLimit()` helper |
| `app/api/*/route.ts` (13 个文件) | `rateLimitApi` → `applyRateLimit` 调用简化 |

---

## 4. Cron 配额月度重置

### 4a. 方案选择

**使用 BullMQ `RepeatableJob`** — 项目已有 BullMQ + Redis 基础设施，无需引入新依赖。

### 4b. 重置逻辑

```ts
// worker/processors/quota-reset.ts
export async function resetMonthlyQuotas() {
  // free plan → 10
  await prisma.user.updateMany({
    where: { plan: "free", quotaRemaining: { not: -1 } },
    data: { quotaRemaining: 10 },
  });

  // pro plan → 100
  await prisma.user.updateMany({
    where: { plan: "pro", quotaRemaining: { not: -1 } },
    data: { quotaRemaining: 100 },
  });

  // enterprise (-1) 跳过：不更新
}
```

### 4c. 调度配置

```ts
// worker/index.ts 中注册
import { Queue } from "bullmq";

const cronQueue = new Queue("cron", { connection });
await cronQueue.add("quota-monthly-reset", {}, {
  repeat: { pattern: "0 0 1 * *" }  // 每月 1 日 00:00
});

// worker 注册处理器
registerProcessor("quota_monthly_reset", resetMonthlyQuotas);
```

### 4d. 幂等性

- `updateMany` 天然幂等：重复执行不产生副作用
- 添加 `lastQuotaReset` 字段到 User 模型，记录最后重置时间，避免手动重跑时重复

### 4e. Schema 变更

```prisma
model User {
  // ... existing ...
  lastQuotaReset DateTime?  // 新增：最后重置时间
}
```

### 4f. 文件变更清单

| 文件 | 变更 |
|------|------|
| `prisma/schema.prisma` | User 表新增 `lastQuotaReset` |
| `worker/processors/quota-reset.ts` | 新建：重置逻辑 |
| `worker/index.ts` | 注册 cron queue + processor |
| `lib/queue.ts` | 新增 `cron` queue name |

---

## 5. JWT 吊销（Session 黑名单）

### 5a. 方案选择

**Redis 黑名单** — middleware 检查 `revoked:<jti>` key，TTL = JWT 剩余有效期。

### 5b. JWT Payload 扩展

在 `auth.ts` 的 `jwt` callback 中注入 `jti`：

```ts
import { v4 as uuidv4 } from "uuid";

callbacks: {
  jwt({ token, user, trigger }) {
    if (user) {
      token.sub = user.id;
    }
    if (trigger === "signIn" || !token.jti) {
      token.jti = uuidv4();  // 每次登录生成新 jti
    }
    return token;
  },
  session({ session, token }) {
    if (session.user) {
      session.user.id = token.sub!;
      session.user.jti = token.jti as string;
    }
    return session;
  },
}
```

### 5c. 黑名单操作

**`lib/session-blacklist.ts`：**

```ts
import { Redis } from "ioredis";
import { getRedisUrl, hasRedis } from "@/lib/env";

let _redis: Redis | null = null;
function getRedis(): Redis | null {
  if (_redis) return _redis;
  if (hasRedis()) _redis = new Redis(getRedisUrl()!);
  return _redis;
}

// 吊销一个 session
export async function revokeSession(jti: string, ttlSeconds: number) {
  const r = getRedis();
  if (!r) return;
  await r.set(`revoked:${jti}`, "1", "EX", ttlSeconds);
}

// 检查 jti 是否被吊销
export async function isSessionRevoked(jti: string): Promise<boolean> {
  const r = getRedis();
  if (!r) return false;
  const exists = await r.exists(`revoked:${jti}`);
  return exists === 1;
}
```

### 5d. Middleware 集成

在 `middleware.ts` 中，auth check 之后增加黑名单检查：

```ts
const session = await auth();
if (session?.user?.jti) {
  const revoked = await isSessionRevoked(session.user.jti as string);
  if (revoked) {
    // 清除 cookie + 重定向登录
    const response = NextResponse.redirect(new URL("/login", req.url));
    response.cookies.delete("authjs.session-token");
    return response;
  }
}
```

### 5e. 吊销触发场景

| 场景 | 触发者 |
|------|--------|
| 用户主动登出 | Server Action (`/api/signout`) |
| 管理员封禁账号 | 管理后台（Phase 5b 不实现 UI，提供 API） |
| 密码/安全事件 | 手动或自动化 |

### 5f. 文件变更清单

| 文件 | 变更 |
|------|------|
| `auth.ts` | jwt callback 注入 `jti` |
| `lib/session-blacklist.ts` | 新建：revokeSession / isSessionRevoked |
| `middleware.ts` | auth 之后检查黑名单 |
| `lib/types.ts` | 扩展 session user 类型（jti） |
| `package.json` | 新增 `uuid`（如未安装） |

---

## 6. 微信 OAuth 登录

### 6a. 方案选择

**NextAuth v5 自定义 OAuth Provider** — 对接微信开放平台 OAuth 2.0。

### 6b. 前提条件

- 微信开放平台企业认证（`open.weixin.qq.com`）
- 获取 `AppID` / `AppSecret`
- 配置回调域名白名单

### 6c. Provider 配置

**`lib/auth/wechat-provider.ts`：**

```ts
import type { OAuthConfig, OAuthUserConfig } from "next-auth/providers/oauth";

interface WeChatProfile {
  unionid: string;
  openid: string;
  nickname: string;
  headimgurl: string;
}

export function WeChatProvider<P extends WeChatProfile>(
  config: OAuthUserConfig<P>
): OAuthConfig<P> {
  return {
    id: "wechat",
    name: "微信",
    type: "oauth",
    clientId: process.env.WECHAT_APP_ID!,
    clientSecret: process.env.WECHAT_APP_SECRET!,
    authorization: {
      url: "https://open.weixin.qq.com/connect/qrconnect",
      params: { appid: process.env.WECHAT_APP_ID, scope: "snsapi_login" },
    },
    token: "https://api.weixin.qq.com/sns/oauth2/access_token",
    userinfo: "https://api.weixin.qq.com/sns/userinfo",
    profile(profile) {
      return {
        id: profile.unionid || profile.openid,
        name: profile.nickname,
        image: profile.headimgurl,
        email: null, // 微信不返回 email
      };
    },
  };
}
```

### 6d. 微信登录流程

```
1. 用户在 /login 点击"微信登录"
2. 302 → 微信开放平台授权页（扫码）
3. 用户扫码授权
4. 回调 /api/auth/callback/wechat?code=xxx
5. 微信返回 access_token + openid + unionid
6. Auth.js 通过 Account 表查找已有账号
   - 已存在 → 直接登录
   - 不存在 → 创建 User + Account
7. 生成 JWT → set cookie → 302 → /
```

### 6e. Schema 变更

```prisma
// NextAuth 标准模型
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

### 6f. 登录页面改动

`app/login/page.tsx` 新增"微信登录"按钮，调用 `signIn("wechat")`。

### 6g. 环境变量

| 变量 | 说明 |
|------|------|
| `WECHAT_APP_ID` | 微信开放平台 AppID |
| `WECHAT_APP_SECRET` | 微信开放平台 AppSecret |

`lib/env.ts` 新增对应 accessor。

### 6h. 降级策略

- `WECHAT_APP_ID` 未设置 → 不注册微信 Provider，登录页面不显示微信按钮
- 微信 API 调用失败 → 显示友好错误，引导使用邮箱登录

### 6i. 文件变更清单

| 文件 | 变更 |
|------|------|
| `lib/auth/wechat-provider.ts` | 新建：微信 OAuth Provider |
| `auth.ts` | 条件注册微信 Provider |
| `prisma/schema.prisma` | 新增 Account 模型 |
| `app/login/page.tsx` | 新增微信登录按钮 |
| `lib/env.ts` | 新增 `getWechatAppId()` / `getWechatAppSecret()` |

---

## 7. 环境变量新增清单

| 变量 | 所属子系统 | 必填 | 说明 |
|------|-----------|------|------|
| `SENTRY_DSN` | Sentry | 否 | Sentry DSN |
| `SENTRY_ORG` | Sentry | 否 | Sentry 组织名（source maps 上传） |
| `SENTRY_PROJECT` | Sentry | 否 | Sentry 项目名（source maps 上传） |
| `SENTRY_AUTH_TOKEN` | Sentry | 否 | Sentry Auth Token（source maps 上传） |
| `WECHAT_APP_ID` | 微信 OAuth | 否 | 微信开放平台 AppID |
| `WECHAT_APP_SECRET` | 微信 OAuth | 否 | 微信开放平台 AppSecret |

以上均为可选：未设置时对应子系统自动禁用。

---

## 8. 实施顺序与依赖

```
Step 1: Sentry
  ├─ 安装 @sentry/nextjs
  ├─ sentry.*.config.ts × 3
  ├─ instrumentation.ts
  ├─ app/global-error.tsx + app/error.tsx
  ├─ lib/env.ts 新增 SENTRY_DSN
  └─ 无外部依赖

Step 2: Middleware 统一限流
  ├─ middleware.ts 新增 IP-based in-memory 限流
  ├─ lib/rate-limit.ts 新增 applyRateLimit() helper
  ├─ 13 个 route 文件调用简化为 applyRateLimit()
  ├─ 无需新增依赖
  └─ 依赖 Step 1（Sentry 监控变更影响）

Step 3: Cron 配额月度重置
  ├─ prisma/schema.prisma 新增 lastQuotaReset
  ├─ worker/processors/quota-reset.ts
  ├─ worker/index.ts 注册
  └─ 依赖现有 BullMQ 基础设施

Step 4: JWT 吊销
  ├─ auth.ts jwt callback 注入 jti
  ├─ lib/session-blacklist.ts
  ├─ middleware.ts 黑名单检查
  └─ 依赖 Step 2（middleware 已重构）

Step 5: 微信 OAuth
  ├─ prisma/schema.prisma 新增 Account 模型
  ├─ lib/auth/wechat-provider.ts
  ├─ auth.ts 条件注册
  ├─ app/login/page.tsx 微信按钮
  └─ 无内部依赖，但需微信开放平台 AppID
```

---

## 9. 测试策略

| 子系统 | 测试内容 |
|--------|----------|
| Sentry | instrumentation 加载测试、global-error/error 页面渲染 |
| Middleware 限流 | IP-based + userId-based 窗口计数、Edge 兼容性 |
| Cron 配额 | 重置逻辑正确性（free→10, pro→100, enterprise 跳过）、幂等性 |
| JWT 吊销 | revokeSession → isSessionRevoked 往返、TTL 过期自动清除 |
| 微信 OAuth | Provider 配置验证、Profile 解析、Account 创建/关联 |

---

## 10. 风险与缓解

| 风险 | 缓解 |
|------|------|
| Middleware in-memory 限流多实例不共享 | 外层仅做粗粒度 IP 防护；精确用户限流仍在 Redis-backed API route 层 |
| BullMQ RepeatableJob 国内时区偏移 | 使用 `pattern: "0 0 1 * *"` 基于 UTC；如需北京时间每月 1 日，调整为 `"0 16 28-31 * *"` + 月份判断 |
| 微信开放平台审核周期长 | 代码先行准备，Provider 通过 `WECHAT_APP_ID` 存在性动态启用 |
| JWT 黑名单增加 Redis 调用 | 仅检查 `exists`（O(1)），对延迟影响微乎其微 |
| Sentry 事件量成本 | `tracesSampleRate: 0.1`（生产仅采样 10%）；本地 dev 不上报 |
