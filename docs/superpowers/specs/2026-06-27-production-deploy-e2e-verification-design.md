# 生产部署 + 端到端验证 设计文档

**日期：** 2026-06-27
**状态：** 待实施
**依赖：** Route C Phase 0→5b（全部已完成）
**关联：** `docs/superpowers/specs/2026-06-08-route-c-production-launch-design.md`

---

## 1. 背景

Route C 上线路径 Phase 0→5b 已全部落地：103 个测试通过，TypeScript 类型检查零错误，4 个 Prisma migration 齐全，`.env.example` 完整覆盖所有环境变量。但**所有功能仅有 mock 单测背书，从未经过真实全栈链路验证**——OpenAI 调用、HeyGen 适配器、R2 上传、BullMQ 作业链、SSE 进度、JWT 黑名单、限流、配额扣减等，均无一次真实联调证据。

同时存在若干阻塞部署的技术债（见 §5）。本设计的目标是把代码从「mock 单测背书」推进到「本地全栈真实链路验证通过 + Zeabur 部署清单完备」，并清理技术债。

### 用户确认的约束

| 维度 | 决策 |
|------|------|
| 部署路径 | 本地全栈验证 + Zeabur 部署清单（不上真实 Zeabur，用户后续照清单操作） |
| 可用凭证 | 仅 OpenAI / 兼容 API key（数字人 mock、magic-link 日志读） |
| 验证深度 | 先 demo 主链路，再 production 验 auth |
| 技术债 | 全部清理；多实例限流用 Redis 后端替代 Upstash（零新依赖） |
| 执行方式 | 方案 A——验证驱动、增量修复，每改一项立即回归 |

### 现实边界

Claude Code 无法替用户登录 Zeabur 控制台、创建 Cloudflare R2 桶、提供真实 API key。因此「生产部署」由两部分组成：Claude 全程执行「代码就绪 + 本地全栈验证 + 部署清单完备」，用户照清单完成云端操作。

---

## 2. 目标与范围

### 目标

1. 本地全栈环境（PostgreSQL + Redis + MinIO）一条 `docker compose up` 起齐
2. demo 模式跑通主链路：门店档案 → 上传素材 → AI 分析（真实 OpenAI）→ AI 脚本（真实 OpenAI）→ mock 数字人 → 成片 + SSE 进度
3. production 模式验证 auth 加固：magic-link 登录 / JWT 黑名单 / 限流 / 配额扣减
4. 清理 4 项技术债（§5）
5. 产出 Zeabur 部署清单（`docs/DEPLOYMENT.md`）

### 范围

**做：**
- `docker-compose.yml` 补 PostgreSQL 服务
- 配置本地 `.env`（MinIO + docker redis/pg + 真实 OpenAI key）
- prisma migrate + seed
- demo 主链路端到端验证
- production auth 加固验证
- 清理 4 项技术债
- 产出 `docs/DEPLOYMENT.md`

**不做（明确排除）：**
- 不上真实 Zeabur（用户后续照清单操作）
- 不接真实 HeyGen / Resend（走 mock / 日志）
- 不做计费 / 监控 / 管理后台（属运营准备方向，另开）
- 不做新功能
- 不引入 Upstash（用 Redis 后端替代，见 §5）

---

## 3. 本地全栈验证环境

### 3.1 docker-compose.yml 补 PostgreSQL

当前 `docker-compose.yml` 仅有 redis + minio + minio-init，**缺少 PostgreSQL**。补：

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

并在 `volumes:` 顶层加 `pg_data:`。

### 3.2 `.env` 配置策略（本地验证）

| 变量 | 值 | 说明 |
|------|-----|------|
| `APP_MODE` | demo / production | 按验证阶段切换 |
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/ai_video_assistant` | docker pg |
| `REDIS_URL` | `redis://localhost:6379` | docker redis |
| `OBJECT_STORAGE_ENDPOINT` | `http://127.0.0.1:9000` | MinIO |
| `OBJECT_STORAGE_BUCKET` | `ai-video-assistant` | minio-init 自动建 |
| `OBJECT_STORAGE_ACCESS_KEY_ID` | `minioadmin` | |
| `OBJECT_STORAGE_SECRET_ACCESS_KEY` | `minioadmin` | |
| `OBJECT_STORAGE_REGION` | `us-east-1` | |
| `OPENAI_API_KEY` | 用户提供 | 真实 |
| `OPENAI_BASE_URL` | 用户提供 | OpenAI 兼容 |
| `AVATAR_PROVIDER` | （留空） | 自动走 mock |
| `AUTH_SECRET` | `openssl rand -hex 32` 生成 | 本地用 |
| `AUTH_URL` | `http://localhost:3000` | |
| `RESEND_API_KEY` | （留空） | 日志读 magic link |
| `SENTRY_DSN` | （留空） | 自动跳过 |

### 3.3 启动编排

```bash
docker compose up -d              # 起 pg + redis + minio
npm run db:migrate                # prisma migrate dev
npm run db:seed                   # prisma db seed
npm run dev        # 终端 1：web (next dev, 0.0.0.0)
npm run worker:dev # 终端 2：worker (tsx worker/index.ts)
```

### 3.4 凭证降级矩阵

验证 fallback 机制是否真实 work：

| 子系统 | 本地验证 | 预期行为 |
|--------|---------|---------|
| 脚本生成 | 真实 OpenAI | `generationMode=ai`，产出明显优于模板 |
| 素材分类 | 真实 OpenAI | AI 标签 / 关键词，`confidence > 0.5` |
| 数字人 | mock | `createMockProvider()`，产出占位 video，不抛异常 |
| 邮件登录 | 日志读 link | magic link URL 打印到 server 日志 |
| Sentry | 不配 DSN | 自动跳过，`console.*` 照常 |

---

## 4. 端到端验证流程

分两阶段，每步都有可观察证据。Chrome MCP 做 UI 交互，`psql` / `redis-cli` / MinIO Console 做数据核验。

### 4.1 阶段一：demo 主链路（APP_MODE=demo）

| # | 操作 | 验证点 | 可观察证据 |
|---|------|--------|-----------|
| 1 | `docker compose up -d` + migrate + seed + 启 web/worker | 全栈就绪 | `/api/health` 返回 `db/redis/objectStorage: configured`；worker 日志 "Worker ready" |
| 2 | 浏览器开 `localhost:3000`，填门店档案三步 | 持久化 | `psql` 查 `StoreProfile` 有行；刷新页面数据恢复 |
| 3 | 选素材文件 → 浏览器 PUT 到 MinIO → confirm | 真实上传 | MinIO Console 见文件；`Asset` 行 `status=uploaded`、`storageKey` 非 fake URL |
| 4 | 触发素材分析 | AI 分类（真实 OpenAI） | `AssetAnalysis` 行 `businessTags/keywords` 丰富、`confidence > 0.5`；worker 日志走 AI 路径非降级 |
| 5 | 生成脚本 | AI 文案（真实 OpenAI） | `ScriptDraft` 行 `generationMode=ai`、内容明显优于模板 |
| 6 | 创建数字人 | mock 降级 | `Avatar` 行；worker 日志 `provider=mock-avatar`；不抛异常 |
| 7 | 一键成片 | FlowProducer 依赖链 | `Job` 状态 queued→processing→completed；`RenderProject` → `ready`；`VideoOutput` 有记录 |
| 8 | 成片过程观察 | SSE 实时进度 | `GET /api/jobs/[id]/progress` 推送 progress 0→100 |

**阶段一通过标准**：第 7 步 `VideoOutput` 落库 + 第 8 步 SSE 推送可见。任一环节走 fallback 时，日志需明确标注降级原因（顺带验证 fallback 机制）。

### 4.2 阶段二：production auth 加固（APP_MODE=production）

| # | 操作 | 验证点 | 可观察证据 |
|---|------|--------|-----------|
| 1 | 切 production，重启 | auth 生效 | 未登录访问 `/api/store-profiles` → 401 |
| 2 | `/login` 输邮箱 | magic-link 发送（无 Resend） | server 日志打印 verify URL（Resend 未配时降级日志） |
| 3 | 访问日志中的 verify URL | 登录成功 | set cookie；JWT payload 含 `jti` |
| 4 | 高频请求 `/api/*` | 外层 IP 限流（60/min） | 超 60 次 → 429 `rate_limited` |
| 5 | 高频写请求 | 内层 userId 限流（20/min） | 超 20 次 → 429，响应头含 `Retry-After` |
| 6 | 创建 RenderProject | 配额扣减 | `User.quotaRemaining` 递减 |
| 7 | 登出 → revokeSession(jti) | JWT 黑名单 | `redis-cli` 见 `revoked:<jti>` key；再访问 → 401 `session_revoked` |

**阶段二通过标准**：第 7 步黑名单生效（依赖 §5 技术债 #1+#2 修复后才能验证——当前 Edge fail-open 会让这步失效）。

### 4.3 关键依赖

阶段二 #4/#5/#7 依赖技术债清理先完成（middleware runtime 锁定 + 外层限流改 Redis 后端）。执行顺序：阶段一建基线 → 技术债清理（§5）→ 阶段二验 auth。

### 4.4 AI 失败判定

若真实 OpenAI 调用失败（网络 / key 问题），阶段一第 4/5 步会走 fallback——这本身是可接受的验证结果（证明降级 work），但需在日志确认是「AI 失败降级」而非「代码 bug」。

---

## 5. 技术债清理

### 5.1 #1+#2 合并：middleware 锁 nodejs runtime + 外层 IP 限流改 Redis 后端

**当前问题：**
- `middleware.ts` 未显式声明 runtime → NextAuth v5 默认走 Edge → ioredis 不可用 → JWT 黑名单 `try/catch` fail-open（`middleware.ts:96-111`）
- 外层 IP 限流是 `ipStore` in-memory Map（`middleware.ts:28`），多实例不共享

**改造方案（替代 Upstash）：**

1. `middleware.ts` 顶部加 `export const runtime = "nodejs"` —— ioredis 在 middleware 可直接使用
2. JWT 黑名单检查从 `dynamic import + try/catch fail-open` → 直接 `import { isSessionRevoked }` 真实调用（Redis 不可用时 `isSessionRevoked` 内部仍 fail-open + warn，与 `lib/rate-limit.ts:resolveBackend` 逻辑一致）
3. 外层 IP 限流：`ipStore` in-memory → 复用 `lib/rate-limit.ts` 的 Redis/memory 后端。在 `lib/rate-limit.ts` 导出 `rateLimitByIp(ip)` 函数，内部走 `checkLimit("ip:"+ip, IP_LIMIT_CONFIG)`，middleware 调用它。`IP_LIMIT_CONFIG = { windowSeconds: 60, maxRequests: 60 }`，与原 `middleware.ts` 的 `IP_RATE_LIMIT_WINDOW=60_000` / `IP_RATE_LIMIT_MAX=60` 保持一致
4. 删除 `middleware.ts` 中的 `ipStore` Map、`checkIpRateLimit`、`getClientIpFromHeaders`（IP 提取复用 `lib/rate-limit.ts:getClientIp`，`req.headers` 是标准 `Headers`，兼容 `getClientIp` 的 `{ get(name) }` 接口）

**为什么不用 Upstash：**

| 维度 | Upstash 方案 | Redis 后端方案（采纳） |
|------|------------|-------------------|
| 新依赖 | `@upstash/redis` | 无 |
| 新凭证 | 需 UPSTASH_REST_URL/TOKEN | 复用现有 REDIS_URL |
| 本地可验证 | 否（无凭证） | 是（docker redis） |
| 多实例共享 | 是 | 是 |
| Edge 兼容 | 是 | 否，但 middleware 已锁 nodejs，不需要 |

middleware 锁 nodejs 后 Edge 兼容性不再是约束，复用现有 Redis 后端即达成「多实例共享 + 本地可验证 + 零新依赖」。

**已知风险：** NextAuth v5 的 `auth()` wrapper 在 nodejs runtime middleware 是官方支持的配置，但实施时需验证 `req.auth` 在 nodejs runtime 下行为一致（阶段二第 3 步登录覆盖此验证）。应急回退见 §6.2。

### 5.2 #3：hydration 警告

**当前状态：** grep `dashboard.tsx` 仅发现两处正确的 `typeof window === "undefined"` SSR 守卫，未发现 `localStorage` / `Date.now()` / `Math.random()` in render 等典型风险点。Phase 2 文档记录的问题**可能已修复**。

**处理方式：** 实施时不预设存在——先在阶段一启动 `npm run dev` 用 Chrome MCP 打开首页，观察控制台是否有 hydration warning。有则定位修复；无则记录「已不存在」并跳过。避免无的放矢改代码。

### 5.3 #4：CF Workers 遗留脚手架清理

设计文档已明确决定「不以 CF Workers 跑主站」。清理范围：

| 删除项 | 位置 |
|--------|------|
| `wrangler.jsonc` | 项目根 |
| `open-next.config.ts` | 项目根 |
| `.open-next/` 目录 | 构建产物（gitignored，删本地） |
| `build:cf` / `preview:cf` / `deploy:cf` / `upload:cf` 脚本 | `package.json` |
| `@opennextjs/cloudflare` dev 初始化 | `next.config.ts:59-63` |
| `@opennextjs/cloudflare` 依赖 | `package.json` dependencies |
| CF 相关说明 | `README.md`（若有） |

**保留：** `next.config.ts` 里 `if (nextRuntime === "edge") externalize ioredis` 逻辑保留——防御性，删除后若有其他 edge 代码引用 ioredis 会报错。

**回归：** 删除后必跑 `npm run build` 确认构建不依赖 CF 脚手架。

### 5.4 技术债内部执行顺序

1. 先做 #4（CF 清理）——纯删除，最低风险，先清场
2. 再做 #1+#2（middleware runtime + IP 限流改 Redis）——核心改动，改完跑全量测试 + 阶段二验证
3. #3（hydration）——阶段一启动时观察，按需修

每步后跑 `npm test && npm run typecheck && npm run build` 回归。

---

## 6. 验证策略与错误处理

### 6.1 三层回归网

1. **技术债每步**：`npm test && npm run typecheck && npm run build` 全绿才进下一步
2. **阶段验证**：阶段一/二每步按「可观察证据」列核验，留证据（Chrome MCP 截图、`psql`/`redis-cli` 查询输出、worker 日志摘录）
3. **不降级覆盖**：现有 103 测试必须保持全绿；新增 `rateLimitByIp()` 单测覆盖 Redis/memory 两后端

### 6.2 错误处理与回退

| 风险 | 回退策略 |
|------|---------|
| 技术债修复破坏构建/测试 | `git` 回滚该步，定位后再试 |
| 真实 OpenAI 调用失败 | 视为可接受结果（验证 fallback），日志确认降级原因 |
| middleware nodejs runtime 与 NextAuth 不兼容 | 应急回退：保留 edge runtime + 改用 Upstash（保留 Upstash 作为 plan B） |
| CF 脚手架删除后构建失败 | 恢复被删文件，排查依赖关系 |

### 6.3 新增测试点

- `tests/rate-limit.test.ts` 增 `rateLimitByIp` 用例（Redis / memory 两后端）
- middleware nodejs runtime 行为：通过阶段二第 7 步黑名单实测覆盖（不新增 mock 测试，因 nodejs middleware 难单测）

---

## 7. 产出物：Zeabur 部署清单

落盘为 `docs/DEPLOYMENT.md`，结构：

1. **服务拓扑**：web（next start）+ worker（Dockerfile）+ PG 插件 + Redis 插件
2. **环境变量清单**：按子系统分组，标注必填 / 可选、本地默认值、生产获取方式
3. **Cloudflare R2 配置**：建桶 → S3 token → CORS（PUT/GET/HEAD + Zeabur 域名）→ 注入 env
4. **部署流程**：`zbpack.json` 已自动化 `migrate deploy + seed + start`；worker 第二服务配置
5. **上线验证清单**：`/api/health` 全 configured、浏览器上传、magic-link 登录、一键成片
6. **已知限制与后续**：
   - 微信 OAuth 需企业 AppID（未配则隐藏按钮）
   - HeyGen 需付费 key（未配走 mock）
   - Resend 需配真实 key（未配生产无法发邮件）
   - 多实例：外层 IP 限流已走 Redis 共享，可安全多实例

---

## 8. 执行顺序

```
0. 建分支（已完成：feat/production-deploy-e2e-verification）
1. CF 脚手架清理 (#4) → 回归
2. middleware 锁 nodejs + 外层 IP 限流改 Redis (#1+#2) → 回归 + 新增单测
3. docker-compose 补 postgres → 启全栈 → migrate + seed
4. 阶段一：demo 主链路验证（含 hydration 观察 #3，按需修）→ 留证据
5. 阶段二：production auth 验证 → 留证据
6. 产出 docs/DEPLOYMENT.md
7. 全量回归 + 提交
```

---

## 9. 验收标准

- [ ] `docker compose up -d` 一条命令起齐 PG + Redis + MinIO
- [ ] `/api/health` 返回 `db/redis/objectStorage: configured`
- [ ] 阶段一：demo 主链路 8 步全部通过，`VideoOutput` 落库 + SSE 推送可见
- [ ] 阶段二：production auth 7 步全部通过，JWT 黑名单生效（401 `session_revoked`）
- [ ] middleware 显式 `runtime = "nodejs"`，外层 IP 限流走 Redis 后端
- [ ] CF 脚手架完全清理，`npm run build` 不依赖 CF
- [ ] `npm test` 全绿（103 + 新增 `rateLimitByIp` 用例）
- [ ] `npm run typecheck` + `npm run build` 通过
- [ ] `docs/DEPLOYMENT.md` 产出，含完整 env 清单与上线验证清单

---

## 10. 风险与缓解

| 风险 | 缓解 |
|------|------|
| NextAuth nodejs middleware 兼容性 | 阶段二第 3 步登录验证；应急回退 Upstash plan B |
| 真实 OpenAI 调用失败 | 视为 fallback 验证，日志确认降级原因 |
| CF 脚手架删除影响构建 | 删除后 `npm run build` 回归，失败则恢复 |
| docker pg 端口冲突（本机已有 5432） | 实施时检查端口，必要时改 compose 映射端口 |
| hydration 问题已不存在 | 先观察再决定是否修，避免无的放矢 |

---

## 11. 关键设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 多实例限流 | Redis 后端替代 Upstash | 零新依赖、复用现有 Redis、本地可验证；middleware 锁 nodejs 后无需 Edge 兼容 |
| middleware runtime | 锁定 nodejs | 让 ioredis 可用，JWT 黑名单不再 fail-open |
| 验证路径 | 本地全栈 + 部署清单 | Claude 无法操作云平台，本地验证 + 清单是可全程执行的最大价值 |
| 凭证策略 | 仅 OpenAI 真实，其余降级 | 同时验证真实 AI 价值与 fallback 机制 |
| 执行方式 | 方案 A 验证驱动 | 每步回归保护，技术债修复不破坏已验证链路 |
| hydration | 先验证再修 | grep 未发现现存风险，避免无的放矢 |
