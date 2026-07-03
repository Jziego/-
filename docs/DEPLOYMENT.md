# 部署清单 — AI Video Assistant (Zeabur)

本文件描述把 AI Video Assistant 部署到 Zeabur 的完整流程：服务拓扑、环境变量、Cloudflare R2 配置、部署步骤、上线验证清单与已知限制。Claude 无法替你登录云平台，请照本清单完成云端操作。

---

## 1. 服务拓扑

| 服务 | 镜像/构建 | 启动命令 | 端口 | 作用 |
|------|----------|---------|------|------|
| **web** | Zeabur Next.js 服务（`zbpack.json`） | `npm run start:prod` → `prisma migrate deploy && prisma db seed && next start -H 0.0.0.0` | 3000（Zeabur 自动暴露） | App Router 页面 + API 路由 + middleware（auth/限流/黑名单） |
| **worker** | `worker/Dockerfile`（独立 Zeabur 服务） | `npx tsx worker/index.ts` | 3001（仅 healthcheck，不对外） | BullMQ 消费者：素材分析 / 脚本 / 数字人 / 成片 / 配额重置 cron |
| **PostgreSQL** | Zeabur Postgres 插件 | — | — | 主数据库（Prisma） |
| **Redis** | Zeabur Redis 插件 | — | — | BullMQ 队列 + 限流计数器 + JWT 黑名单 |

> web 与 worker **共享同一份代码库**（`lib/`、`prisma/`），连接**同一个** PostgreSQL 与 Redis 实例。worker 只是 BullMQ 消费进程，不对外提供 HTTP。

### 构建产物说明
- `zbpack.json`：`build_command = "npm run build"`（= `prisma generate && next build --webpack`，**生产构建走 webpack 非 turbopack**），`start_command = "npm run start:prod"`。
- `start:prod` 每次启动都执行 `prisma migrate deploy`（应用待迁移）+ `prisma db seed`（幂等：仅 `upsert demo_user`，`update: {}`，已存在则无操作）+ `next start`。

---

## 2. 前置：Cloudflare R2 配置

对象存储用 S3 协议；本地用 MinIO，生产用 Cloudflare R2。代码 `lib/storage.ts` 已设 `forcePathStyle: true`，与 R2 兼容。

### 2.1 建桶
1. Cloudflare Dashboard → R2 → 新建 bucket（如 `ai-video-assistant`）。
2. 记下 **Account ID**（用于拼 endpoint）。

### 2.2 创建 S3 API Token
1. R2 → Manage R2 API Tokens → Create API token。
2. 权限：Object Read & Write；指定 bucket 或全部。
3. 生成后记下 **Access Key ID** 与 **Secret Access Key**。

### 2.3 配置 CORS（浏览器直传必须）
R2 bucket → Settings → CORS Policy，允许 web 域名直传 PUT、预检 OPTIONS、回读 GET/HEAD：

```json
[
  {
    "AllowedOrigins": ["https://<your-app>.zeabur.app"],
    "AllowedMethods": ["PUT", "GET", "HEAD", "OPTIONS"],
    "AllowedHeaders": ["content-type", "x-amz-*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

> 预签名 PUT URL 有效期 **900 秒（15 分钟）**（`lib/storage.ts:PRESIGN_EXPIRES_SECONDS`），单文件上限 **200 MB**（`MAX_UPLOAD_BYTES`）。

### 2.4（可选）公开访问域名
成片/封面若需浏览器直接播放，给 bucket 绑定 R2 Public Domain（或接 CDN），把基础 URL 填入 `OBJECT_STORAGE_PUBLIC_URL`。不设则 `publicUrl` 为空（需通过签名 URL 访问）。

---

## 3. 环境变量清单

按子系统分组。**必填**缺一不可，**可选**留空即自动降级。

### 3.1 应用
| 变量 | 必填 | 生产值 | 说明 |
|------|------|--------|------|
| `APP_MODE` | ✅ | `production` | `production` 启用 auth/限流/配额；`demo` 放行全部 |
| `DEV_ALLOWED_ORIGINS` | ❌ | — | 仅 `next dev` 的 `allowedDevOrigins` 用，生产不需要 |

### 3.2 数据层
| 变量 | 必填 | 生产值 | 说明 |
|------|------|--------|------|
| `DATABASE_URL` | ✅ | Zeabur Postgres 连接串 | Prisma 数据源 |
| `REDIS_URL` | ✅ | Zeabur Redis 连接串 | **production 未设 → 限流 disabled + JWT 黑名单 fail-open**（见 §6） |

### 3.3 对象存储（R2）
| 变量 | 必填 | 生产值 | 说明 |
|------|------|--------|------|
| `OBJECT_STORAGE_ENDPOINT` | ✅ | `https://<account_id>.r2.cloudflarestorage.com` | R2 S3 endpoint |
| `OBJECT_STORAGE_BUCKET` | ✅ | bucket 名 | |
| `OBJECT_STORAGE_ACCESS_KEY_ID` | ✅ | R2 token Access Key ID | |
| `OBJECT_STORAGE_SECRET_ACCESS_KEY` | ✅ | R2 token Secret | |
| `OBJECT_STORAGE_REGION` | ❌ | `auto` | 默认 `us-east-1`；R2 忽略 region |
| `OBJECT_STORAGE_PUBLIC_URL` | ❌ | R2 public domain / CDN | 不设则不生成公开 URL |

### 3.4 Auth（NextAuth v5）
| 变量 | 必填 | 生产值 | 说明 |
|------|------|--------|------|
| `AUTH_SECRET` | ✅ | `openssl rand -hex 32` | JWT 加密密钥 |
| `AUTH_URL` | ✅ | `https://<your-app>.zeabur.app` | 回调/magic-link 基址 |
| `RESEND_API_KEY` | ⚠️ | Resend API key | 未配 → magic-link **不发邮件**，仅打印到 server 日志（生产无法登录） |
| `EMAIL_FROM` | ⚠️ | Resend 验证过的发件人 | 如 `AI助手 <noreply@yourdomain.com>` |

### 3.5 AI
| 变量 | 必填 | 生产值 | 说明 |
|------|------|--------|------|
| `OPENAI_API_KEY` | ✅ | OpenAI 兼容 key | 脚本生成 / 素材分析 |
| `OPENAI_BASE_URL` | ✅ | `https://api.openai.com/v1` 等 | OpenAI 兼容端点 |
| `AVATAR_PROVIDER` | ❌ | `heygen` | 留空或无 key → 走 mock 数字人 |
| `AVATAR_PROVIDER_API_KEY` | ❌ | HeyGen key | 未配 → mock 降级 |

### 3.6 监控（Sentry，可选）
| 变量 | 说明 |
|------|------|
| `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` | 不设 `SENTRY_DSN` → 自动跳过 Sentry |
| `SENTRY_ORG` / `SENTRY_PROJECT` / `SENTRY_AUTH_TOKEN` | sourcemap 上传用，仅 CI 需要 |

### 3.7 微信 OAuth（可选）
| 变量 | 说明 |
|------|------|
| `WECHAT_APP_ID` / `WECHAT_APP_SECRET` | 不设 → 隐藏微信登录按钮（需企业 AppID） |

### 3.8 Worker 专有（可选）
| 变量 | 说明 |
|------|------|
| `RUN_QUOTA_RESET_ON_STARTUP` | `1` → worker 启动时立即触发一次配额重置（运维用，正常留空） |

> **worker 服务必须配置与 web 相同的** `DATABASE_URL`、`REDIS_URL`、`APP_MODE=production`、`OPENAI_*`、`AVATAR_*`、`OBJECT_STORAGE_*`（成片上传需要）。Sentry/WeChat 可不配。

---

## 4. 部署流程

### 4.1 web 服务
1. Zeabur 新建项目，添加 **Postgres** 插件、**Redis** 插件。
2. 添加服务 → 选 Git 仓库 → Zeabur 读取 `zbpack.json` 自动执行 `npm run build` + `npm run start:prod`（含 `migrate deploy + seed + start`）。
3. 在服务 Variables 页注入 §3 全部环境变量（`APP_MODE=production`）。
4. 绑定域名，把 `https://<your-app>.zeabur.app` 回填到 `AUTH_URL` 与 R2 CORS `AllowedOrigins`。

### 4.2 worker 服务（第二个服务）

Zeabur 新版 UI 无独立 Build Type / Dockerfile Path 字段，worker 用 Settings → Source 区域的 inline Dockerfile 内容框覆盖默认构建。

1. 同项目下添加第二个服务 → 选同一 Git 仓库 → **Root Directory 留空**（= 项目根）。
2. 进入服务 → **Settings** tab → **Source** 区域 → 「Overriding the default Dockerfile used for Zeabur agent or redeployment.」下方的文本框，粘贴 `worker/Dockerfile` 的**完整内容**：
   ```dockerfile
   FROM node:20-alpine AS base
   WORKDIR /app
   RUN apk add --no-cache openssl
   COPY package.json package-lock.json* ./
   COPY prisma/ ./prisma/
   RUN npm ci
   RUN npx prisma generate
   COPY . .
   EXPOSE 3001
   HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
     CMD pgrep -f "worker/index.ts" || exit 1
   CMD ["npx", "tsx", "worker/index.ts"]
   ```
   - ⚠️ **不要**填 `worker/Dockerfile` 路径字符串 —— 该框是 inline 内容框，填路径会被当作 Dockerfile 文件内容解析，报 `dockerfile parse error on line 1: unknown instruction: worker/Dockerfile`。
   - 缺点：仓库 `worker/Dockerfile` 改动后需手动同步到该框（Zeabur 不支持「子目录 Dockerfile 路径 + 项目根上下文」的代码层配置，见下方注）。
3. **Startup Command** 留空（Dockerfile 的 `CMD` 已指定 `npx tsx worker/index.ts`）。
4. 注入与 web 相同的 `DATABASE_URL`、`REDIS_URL`、`APP_MODE=production`、`OPENAI_*`、`AVATAR_*`、`OBJECT_STORAGE_*`（可选 `RUN_QUOTA_RESET_ON_STARTUP`）。
5. worker 不需要公网域名；Zeabur 按 Dockerfile 的 `HEALTHCHECK`（`pgrep -f worker/index.ts`）做健康检查。
6. 首次部署后查 worker 日志，确认出现 `Worker started with 6 queues: ...` 与各队列 `Worker ready`。

> **注：为什么不用 zbpack.json 代码层配置？** zbpack 支持 `dockerfile.path` 字段（[源码](https://github.com/zeabur/zbpack) `internal/dockerfile/finder.go`），但路径相对 Root Directory 且不支持 `..` 穿越上下文（afero 虚拟 FS 隔离）。若在项目根 `zbpack.json` 加 `dockerfile.path: worker/Dockerfile`，会覆盖 web 的 `build_command`（zbpack 中 dockerfile.path 优先于 build_command），web 也会被 worker Dockerfile 构建，破坏 web。worker Root Directory 设 `worker/` 则上下文隔离，`COPY prisma/` / `COPY lib/` 失败。故当前只能用 Dashboard inline 内容框；若要根除手动同步，需重构 worker 为自包含子目录（独立 package.json + 复制 prisma/lib）。

### 4.3 部署后自检
- `prisma migrate deploy` 应无报错（4 个 migration 全部 applied）。
- `prisma db seed` 幂等创建 `demo_user`，重复执行无副作用。

---

## 5. 上线验证清单

部署完成后逐项核验：

- [ ] `GET /api/health` → `{"status":"ok","mode":"production","checks":{"database":"configured","redis":"configured","objectStorage":"configured"}}` 三项全 configured
- [ ] 未登录访问任意 `/api/*`（如 `/api/store-profiles`）→ **401**
- [ ] `/login` 输邮箱 → 收到 magic-link 邮件（生产需 `RESEND_API_KEY`）→ 点击登录成功
- [ ] 浏览器上传素材 → R2 bucket 出现文件 → `Asset` 行 `status=uploaded`
- [ ] 触发素材分析 → `AssetAnalysis` 有 AI 标签/关键词（真实 OpenAI）
- [ ] 一键成片 → worker 日志走 render pipeline → `RenderProject` → `ready` → `VideoOutput` 落库
- [ ] 成片过程 `GET /api/jobs/[id]/progress` SSE 推送 progress 0→100
- [ ] 登出后再访问 → **401 `session_revoked`**（JWT 黑名单生效）
- [ ] 高频请求 `/api/*` → 超 60/min 触发 **429**（IP 限流）

---

## 6. 已知限制与后续

| 项 | 现状 | 后续 |
|----|------|------|
| **微信 OAuth** | 需企业 AppID；未配则隐藏按钮 | 取得 AppID 后配 `WECHAT_APP_ID/SECRET` |
| **HeyGen 数字人** | 需付费 key；未配走 mock（占位 video） | 取得 key 后配 `AVATAR_PROVIDER_API_KEY` |
| **Resend 邮件** | 生产未配 `RESEND_API_KEY` 则 magic-link 无法发送 | 上线前必须配真实 key + 验证发件域名 |
| **多实例** | 外层 IP 限流 + JWT 黑名单均走 Redis 后端，**多实例安全**；内层 userId 限流亦 Redis 共享 | 可水平扩展 web 实例 |
| **middleware runtime** | 已锁定 `nodejs`（`middleware.ts`），ioredis 可用，黑名单不再 Edge fail-open | — |
| **配额** | free 计划初始 10 次/月，worker cron `0 0 1 * *` 月度重置 | 接计费系统后调整 |
| **Sentry** | 未配 DSN 自动跳过 | 生产建议配置 |

### 安全注意
- `REDIS_URL` 在 production **必须设置**：否则 `lib/rate-limit.ts:resolveBackend()` 会打印 warn 并 disable 限流，`lib/session-blacklist.ts:isSessionRevoked()` 会 fail-open（黑名单失效）。
- 所有密钥（`AUTH_SECRET`、`OPENAI_API_KEY`、`AVATAR_PROVIDER_API_KEY`、S3 凭证、`DATABASE_URL`）**禁止**入日志/响应/仓库；`.env` 已 gitignore。
- 预签名 URL 有效期 15 分钟，`storageKey` 为 UUID 不含用户输入。

---

## 7. 本地全栈验证结果（2026-06-27）

部署前已在本地 docker 全栈（PostgreSQL + Redis + MinIO + 真实 OpenAI）完成端到端验证：

**demo 主链路**：门店档案 → MinIO 上传 → AI 素材分析（真实 DeepSeek）→ AI 脚本（真实）→ mock 数字人 → 成片 + SSE 进度，`VideoOutput` 落库。

**production auth 加固**（`APP_MODE=production`）：
| 验证项 | 结果 |
|--------|------|
| 未登录 `/api/store-profiles` | **401** `{"error":"Unauthorized"}` |
| magic-link 登录（无 Resend → 日志读 URL） | server 日志打印 verify URL ✓ |
| 回调登录 → session | cookie set，`session.user.jti` 存在 ✓ |
| L0 外层 IP 限流（60/min, middleware） | 60×200 → **429** `{"error":"rate_limited","message":"Too many requests"}`，**无 Retry-After** ✓ |
| L2 内层写限流（20/min, route handler） | 20×400 → **429** + `retry-after` + `x-ratelimit-remaining: 0` ✓ |
| 配额扣减（POST render-projects） | `User.quotaRemaining` **10 → 9** ✓ |
| JWT 黑名单（revokeSession(jti)） | redis `revoked:<jti>` = `1` TTL≈7d；再访问 → **401** `{"error":"Session revoked","code":"session_revoked"}` ✓ |

> JWT 黑名单生效是 **middleware 锁 `nodejs` runtime** 改造（Task 3）的关键验证点：Edge 时代 ioredis 不可用导致 fail-open，现已由 nodejs runtime + 直连 `isSessionRevoked` 真实生效。
