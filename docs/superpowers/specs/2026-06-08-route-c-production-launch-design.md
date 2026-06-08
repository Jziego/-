# Route C：正式上线路径设计

**日期：** 2026-06-08  
**状态：** 待评审  
**目标：** 以正式上线为目的，分阶段把原型变成可运营 SaaS，每一步可验证、可回滚，避免架构债。

---

## 1. 背景与现状

### 已完成
- 单页 Dashboard UI（门店档案 → 素材库 → AI 分身 → 智能成片）
- Zod Schema + Prisma 7 数据模型（完整但未接入）
- BFF API 路由（9 个 endpoint，内存存储）
- Service 层边界清晰（script / assets / avatar / render），含 fallback 模式
- BullMQ / 对象存储 / 队列 payload 的**脚手架**（未调用）
- Zeabur 香港部署（`npm run build` + `npm run start`）
- 单元测试覆盖 service 层与 Dashboard 交互

### 核心缺口（上线 blocker）
| 缺口 | 风险 |
|------|------|
| Dashboard 不调用 API，数据在 React state + localStorage | 用户以为「已保存」，服务端无数据 |
| `runtime-store` 内存存储 | 重启/多实例丢数据、状态分裂 |
| 无真实文件上传 | 素材链路是假的 |
| 无 Worker 消费队列 | 「智能成片」永不完成 |
| 无 Auth | 开放 demo 租户，无法计费/隔离 |
| AI / 渲染全是 Mock | 产品承诺与交付不符 |
| Cloudflare Workers 路径 | 与 BullMQ、ffmpeg、长连接 Redis **不兼容** |

### 明确不做（避免埋坑）
1. **不以 Cloudflare Workers 作为主运行时** — 仅保留静态 CDN 或未来边缘缓存选项
2. **不在 `next start` 进程内跑 BullMQ Worker** — 渲染/训练会阻塞 Web 请求
3. **不在接真实 AI 前跳过持久化** — 否则训练任务、脚本、作业状态无法恢复
4. **不先上计费再上配额 enforcement** — 防止超卖
5. **不删除 Mock fallback** — 生产环境保留降级路径，通过 env 切换主/备

---

## 2. 目标架构（终态）

```
                    ┌─────────────────────────────────────┐
                    │  Zeabur Project (香港)               │
                    │                                     │
  用户浏览器 ────────▶│  Web: Next.js (next start)          │
                    │    - Dashboard UI                   │
                    │    - BFF API routes                 │
                    │    - Auth middleware                │
                    └──────┬──────────────┬───────────────┘
                           │              │
              ┌────────────▼──┐    ┌──────▼──────┐
              │  PostgreSQL   │    │  Redis      │
              │  (Zeabur 插件) │    │  (Zeabur 插件) │
              └────────────▲──┘    └──────▲──────┘
                           │              │
                    ┌──────┴──────────────┴───────────────┐
                    │  Worker: Node 独立服务                 │
                    │    - BullMQ consumers               │
                    │    - ffmpeg / 外部 API 调用          │
                    └──────────────┬──────────────────────┘
                                   │
                    ┌──────────────▼──────────────────────┐
                    │  Object Storage (S3 兼容)          │
                    │  推荐：Cloudflare R2 或 阿里云 OSS   │
                    └────────────────────────────────────┘
```

**技术选型（推荐，可替换）**

| 组件 | 推荐 | 理由 |
|------|------|------|
| 宿主 | Zeabur 香港 | 已部署、大陆访问较好、支持 PG/Redis 插件 |
| 数据库 | PostgreSQL 15+ | Prisma 已建模 |
| 队列 | Redis + BullMQ | 代码已有 payload 定义 |
| 对象存储 | Cloudflare R2 | S3 API、无出站费、与域名/CDN 可同生态 |
| 认证 | NextAuth.js v5 (Auth.js) | 无 vendor lock-in、手机号/微信可后接；Clerk 备选 |
| AI 文案 | OpenAI API | `.env.example` 已预留 |
| 数字人 | HeyGen（首期） | 类型枚举已预留，异步训练模式匹配 UI |
| 可观测 | 结构化 JSON 日志 + Sentry（Phase 5） | 先轻后重 |

---

## 3. 分阶段路径

### Phase 0 — 护栏与诚实边界（~3 天）
**目标：** 部署行为可预期，不对外过度承诺。

- 新增 `GET /api/health`（检查 DB/Redis 连通性，未接时返回 degraded）
- 新增 `APP_MODE=demo|production` 环境变量；demo 模式下 UI 显示「演示版」角标
- 新增 GitHub Actions CI：`test` + `typecheck` + `lint` + `prisma validate` + `build`
- README 补充「架构限制」：暂不支持 CF Workers 主站
- Zeabur 环境变量文档化（哪些必填、何时填）

**验收：** CI 绿；health 可访问；demo 角标可见。

**坑规避：** 不在此阶段改业务逻辑，避免与 Phase 1 冲突。

---

### Phase 1 — 持久化 + UI↔API 统一（~1–2 周）⭐ 当前首要
**目标：** 用户操作写入 PostgreSQL，刷新/重启不丢数据。

**设计原则：**
- 引入 `lib/prisma.ts` 单例 + `lib/repositories/*` 仓储层，API 路由不直接散落 Prisma 调用
- `runtime-store` 保留为 **测试/本地无 DB 时的 fallback**（`DATABASE_URL` 未设置时），避免开发体验断裂
- Dashboard 改用 `@tanstack/react-query` 调 `/api/*`（依赖已在 package.json）
- 门店草稿仍用 localStorage 做**离线草稿**，提交后同步服务端（双写过渡期）
- 首版 migration + seed（`demo_user` 或首个真实用户）

**涉及文件：**
- 新建：`lib/prisma.ts`、`lib/repositories/store.ts`、`asset.ts`、`avatar.ts`、`script.ts`、`render.ts`、`job.ts`
- 新建：`prisma/migrations/`、`prisma/seed.ts`
- 修改：全部 `app/api/**/route.ts`、`components/dashboard.tsx`
- 新建：`lib/api-client.ts`（前端 fetch 封装）

**验收：**
- 填门店档案 → 刷新页面 → 数据从 API 恢复
- Zeabur 重启后数据仍在
- 现有 vitest 全绿 + 新增 API 集成测试（至少 store-profiles）

**坑规避：**
- 只迁 API 不迁 Dashboard = 假持久化（必须同批完成）
- migration 从空库开始，不做 runtime-store → PG 数据迁移（无生产数据）

---

### Phase 2 — 真实对象存储（~1 周）
**目标：** 用户上传真实视频/图片，服务端有 `storageKey`。

- `lib/storage.ts` 实现 S3 presigned PUT（`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`）
- `createUploadIntent` 返回真实 URL；Dashboard 增加 `<input type="file">` + 直传
- `POST /api/assets/confirm`（或 analyze 前校验）确认上传完成、写 Asset 记录
- 可选：上传大小/MIME 白名单

**验收：** 手机/电脑上传 mp4 → 对象存储有文件 → DB 有 Asset → analyze 可读 storageKey

**坑规避：** 禁止再返回 `object-storage.local` 假 URL；生产 env 未配置时 API 应 503 而非静默 fake。

---

### Phase 3 — Worker 服务 + 作业生命周期（~2–3 周）
**目标：** 渲染/训练任务真正执行并可查询状态。

- 新建 `worker/` 目录（独立 `package.json` 或 monorepo workspace）
- Zeabur 第二服务：`node worker/index.js`
- `POST /api/render-projects`：事务内写 Job + `queue.add()`
- Worker processors：
  - `asset_analysis` → 调 classify（暂可保留规则，接口统一）
  - `avatar_generation` → provider 工厂
  - `video_render` / `slideshow_render` → ffmpeg 管线（首期 slideshow 可先出占位 mp4）
- `GET /api/jobs/[id]` 或 SSE 推送进度
- 完成时写 `VideoOutput`

**验收：** 一键成片 → jobs 状态从 queued → processing → completed；DB 有 VideoOutput 记录

**坑规避：**
- Worker 与 Web 分进程
- Job 幂等（`jobId` 作 BullMQ jobId）
- 失败写 `error` 字段 + 触发 `recoverRenderFailure` 降级 job

---

### Phase 4 — 真实 AI 接入（与 Phase 3 可部分并行）
**目标：** 替换 Mock，保留 fallback。

| 模块 | 实现 | Fallback |
|------|------|----------|
| `script-engine` | OpenAI chat completion + store 上下文 | `createTemplateScriptDraft` |
| `assets.classifyAsset` | Vision API + Whisper 转写 | 现有规则引擎 |
| `avatar-provider` | `createProviderFromEnv()` → HeyGen REST | `createMockAvatarProvider` |

- 所有外部调用设超时（30s）+ 重试 1 次
- `generationMode` / `analysisUnavailable` 如实写入 DB

**验收：** 无 API Key 时降级可用；有 Key 时产出明显优于模板

---

### Phase 5 — 认证、配额、生产加固（~2 周）
**目标：** 可对外开放注册使用。

- Auth.js：邮箱 magic link 或 OAuth（微信需企业资质，可二期）
- `middleware.ts`：保护 `/api/*`（health 除外）
- `ownerId` 从 session 取，拒绝 body 伪造
- `User.quotaRemaining` 在创建 RenderProject 时扣减
- Rate limit（Upstash 或内存滑动窗口）
- Sentry + 安全响应头
- 去掉 Dashboard 硬编码 `demo_user`

**验收：** 未登录 401；配额用尽 402/403；跨用户无法读他人 store

---

## 4. 数据流（Phase 1 完成后）

```
Dashboard                BFF API                  Repository              PostgreSQL
   │                        │                         │                      │
   │ POST /api/store-profiles                          │                      │
   ├───────────────────────▶│ validate (Zod)          │                      │
   │                        ├────────────────────────▶│ upsert StoreProfile  │
   │                        │                         ├─────────────────────▶│
   │◀───────────────────────┤ JSON store              │◀─────────────────────┤
   │                        │                         │                      │
   │ GET /api/store-profiles│                         │                      │
   ├───────────────────────▶├────────────────────────▶│ list by ownerId      │
   │◀───────────────────────┤                         │                      │
```

Phase 3 之后，render 路径在 API 写 Job 后向 Redis enqueue，Worker 异步更新 Job.status。

---

## 5. 环境与部署清单

### Zeabur 服务拓扑（终态）
| 服务 | 类型 | 说明 |
|------|------|------|
| `web` | Next.js | 现有仓库，`npm run start` |
| `worker` | Node | `worker/` 子目录，消费 BullMQ |
| `postgresql` | 插件 | 自动注入 `DATABASE_URL` |
| `redis` | 插件 | 自动注入 `REDIS_URL` |

### 环境变量分期

| 变量 | Phase | 必填 |
|------|-------|------|
| `DATABASE_URL` | 1 | 是 |
| `APP_MODE` | 0 | 否（默认 demo） |
| `OBJECT_STORAGE_*` + credentials | 2 | 是 |
| `REDIS_URL` | 3 | 是 |
| `OPENAI_API_KEY` | 4 | 否（无则模板） |
| `AVATAR_PROVIDER*` | 4 | 否 |
| `AUTH_SECRET` | 5 | 是 |

---

## 6. 测试策略

| 阶段 | 新增测试 |
|------|----------|
| 0 | CI workflow 本身 |
| 1 | API route 集成测试（supertest 或 `next/test`）；repository 单元测试 |
| 2 | upload-intent + confirm 契约测试 |
| 3 | queue enqueue 单测；worker processor 单测（mock Redis） |
| 4 | provider 契约测试 + recorded fixtures |
| 5 | auth middleware 测试 |

**原则：** 每阶段合并前 CI 全绿；不降低现有 vitest 覆盖率。

---

## 7. 风险登记

| 风险 | 缓解 |
|------|------|
| Zeabur 单实例 Web 内存不足 | 2C4G 已够用；Worker 分离后可降 Web 负载 |
| HeyGen 大陆访问不稳定 | fallback TTS + slideshow；国内厂商作 Phase 4b |
| ffmpeg 在容器内缺失 | Worker Dockerfile 装 ffmpeg 静态构建 |
| Prisma migrate 生产失败 | 先在 Zeabur  staging 库验证；migrate deploy 进 CI |
| UI 与 API 字段漂移 | 共用 `lib/schemas.ts` + `lib/types.ts` |

---

## 8. 决策记录

| 决策 | 选择 | 备选 |
|------|------|------|
| 主部署平台 | Zeabur 香港 | Railway（大陆差） |
| 弃用 CF Workers 主站 | 是 | 仅 CDN |
| Auth 方案 | Auth.js | Clerk（更快但付费） |
| 对象存储 | R2 | 阿里云 OSS（国内合规备选） |
| 首期数字人 | HeyGen | 硅基智能（国内） |
| runtime-store | 保留为 dev fallback | 完全删除（不利于无 DB 本地开发） |

---

## 9. 评审确认项

请确认以下问题后进入实施计划：

1. **部署：** 同意 Zeabur 作为主平台，Worker 为第二服务，暂不用 CF Workers 跑 API？
2. **Auth：** 首期 Auth.js 邮箱登录可接受？（微信登录放 Phase 5b）
3. **存储：** Cloudflare R2 作为默认对象存储？
4. **执行顺序：** 从 Phase 0 + Phase 1 开始，同意？

---

## 附录：与现有代码的映射

| 现有 | 终态 |
|------|------|
| `lib/runtime-store.ts` | dev fallback / 测试 |
| `components/dashboard.tsx` simulate* | 改为 api-client 调用 |
| `lib/queue.ts` | Web 侧 enqueue；Worker 侧 consume |
| `lib/storage.ts` | Phase 2 真正实现 |
| `prisma/schema.prisma` | Phase 1 migrate + 少量字段对齐 |
| `createMockAvatarProvider` | env 未配置时的 fallback |
