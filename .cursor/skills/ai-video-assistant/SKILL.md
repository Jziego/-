---
name: ai-video-assistant
description: AI 短视频 SaaS 原型领域知识：用户流程、API 地图、目录结构、环境变量与故障排查。修改 dashboard、门店档案、素材库或数据层时使用。
---

# AI Video Assistant 领域 Skill

## 产品核心流程

```
门店档案 → 素材库（上传+AI识别）→ AI 分身 → 智能成片（脚本+渲染任务）
```

Dashboard 单页按 `#store-profile` → `#media-upload` → `#avatar-clone` → `#one-click-video` 递进解锁。

## API 路由地图

| 路径 | 用途 |
|------|------|
| `GET/POST /api/store-profiles` | 门店档案列表与保存 |
| `GET/POST /api/assets` | 素材 CRUD |
| `POST /api/assets/upload-intent` | 上传签名意图 |
| `POST /api/assets/analyze` | 触发素材 AI 分析 |
| `GET /api/asset-analyses` | 分析结果列表 |
| `GET/POST /api/avatars` | AI 分身档案 |
| `POST /api/avatars/talking-head` | 口播视频请求 |
| `GET/POST /api/script-drafts` | 营销脚本草稿 |
| `GET/POST /api/render-projects` | 渲染项目 |
| `GET /api/jobs` | 后台任务状态 |
| `GET /api/health` | 健康检查（DB/Redis 配置状态） |

客户端封装：`lib/api-client.ts`。

## 关键目录

```
app/                    # Next.js App Router（page + api）
components/dashboard.tsx  # 主 UI 与多步门店表单
lib/repositories/       # memory + prisma 双实现
lib/draft-storage.ts    # 门店草稿 localStorage
lib/queue.ts            # BullMQ 队列名与 payload
lib/services/           # 脚本引擎、渲染管线、头像提供商
prisma/schema.prisma    # 数据模型
tests/                  # Vitest 单元与 API 测试
```

## 环境变量

| 变量 | 说明 |
|------|------|
| `APP_MODE` | `demo`（默认，显示 Demo 徽章）或 `production` |
| `DATABASE_URL` | PostgreSQL；未设置则内存仓库 |
| `REDIS_URL` | BullMQ；未设置则连 `127.0.0.1:6379` |
| `DEV_ALLOWED_ORIGINS` | 非 localhost 开发访问白名单 |
| `OBJECT_STORAGE_*` | 对象存储（生产上传） |
| `OPENAI_API_KEY` | AI 文案等 |
| `AVATAR_PROVIDER` / `AVATAR_PROVIDER_API_KEY` | 数字人提供商 |

Cloudflare：`npm run build:cf` / `deploy:cf`（OpenNext）；主运行时推荐 Zeabur Node。

## 常见故障排查

| 现象 | 检查点 |
|------|--------|
| Hydration mismatch | `useState` 是否首屏读了 localStorage；改后用 browser MCP 验证 |
| 表单卡住 / 无法下一步 | 当前步 `trigger` 字段、必填项、`pendingAction` 是否未释放 |
| 保存门店 500 / 外键错误 | PostgreSQL 是否已 `db:seed`；`ensureDemoUser` 是否调用 |
| 素材库未解锁 | `localStore` 或 `stores[0]` 是否存在；最后一步是否调 `saveStore` |
| 内存 vs PG 数据不一致 | 是否配置了 `DATABASE_URL`；重启后内存数据丢失 |
| 部署差异 | Zeabur 注入 `DATABASE_URL`；CF Workers 不适合 BullMQ 长连接 |

## 本地开发命令

```bash
npm install
npm run dev          # http://0.0.0.0:3000
npm test             # Vitest
npm run typecheck
npm run lint
npm run db:migrate   # 需 DATABASE_URL
npm run db:seed
npm run db:studio
```

## 浏览器 / E2E 验证约定（必做）

修改 `dashboard.tsx` 或门店档案 / 素材库流程后，用 **cursor-ide-browser** MCP：

1. `npm run dev` 启动（或确认已在运行）
2. 打开首页，完成门店档案三步
3. 最后一步点击「完成设置」
4. 确认 `#media-upload` 区域可用（非锁定状态），控制台无 hydration 错误

单元测试 `tests/dashboard.test.tsx` 覆盖逻辑，**不能替代**上述浏览器流程。
