# Cursor 开发环境说明

本文档说明 ai-video-assistant 项目的 Cursor Rules、MCP、Skill 与验证约定。

## 已启用能力

### Superpowers 插件

项目 `.cursor/settings.json` 已启用 Superpowers。修 bug 或上线前建议：

| Skill | 何时用 |
|-------|--------|
| `systematic-debugging` | 遇到测试通过但浏览器卡住、hydration、外键等异常时，先收集证据再改代码 |
| `verification-before-completion` | 声称「已修复 / 已通过」前必须跑 `npm test`，UI 改动还需 browser MCP |
| `test-driven-development` | 新功能或回归 bug 时先写失败测试再实现 |

### 内置 MCP（无需安装）

- **cursor-ide-browser**：多步 UI、hydration、门店档案 → 素材库流程的端到端验证
- **cursor-app-control**：工作区切换、打开文件等 IDE 操作

### 项目 Rules（`.cursor/rules/`）

| 文件 | 摘要 |
|------|------|
| `nextjs-hydration.mdc` | 禁止 `useState` 首屏读 localStorage；mount 后恢复；改 dashboard 后 browser 验证 |
| `react-hook-form-multistep.mdc` | `shouldUnregister: false`、分步 `trigger`、草稿与 `mergeStoreDraftWithDefaults` |
| `prisma-data-layer.mdc` | 内存/PG 分支、`ensureDemoUser`、repository 工厂与 seed |

### 领域 Skill

路径：`.cursor/skills/ai-video-assistant/SKILL.md`

含用户流程、API 地图、目录结构、环境变量与故障排查清单。

## 用户级 MCP（`~/.cursor/mcp.json`）

敏感信息通过**系统环境变量**注入，勿写入 git。

### GitHub MCP（已配置结构，待凭据）

使用官方 Docker 镜像 `ghcr.io/github/github-mcp-server`。

**你需要提供：**

1. [GitHub Personal Access Token](https://github.com/settings/tokens)（建议 `repo` + `read:org` + Actions 读权限）
2. 设为系统环境变量，例如 PowerShell 用户级：

   ```powershell
   [System.Environment]::SetEnvironmentVariable("GITHUB_TOKEN", "ghp_xxxx", "User")
   ```

3. **完全重启 Cursor**

**验证：** Settings → MCP 中 `github` 绿点；让 Agent 列出仓库 PR 或 CI workflow 状态。

> 本机未安装 `gh` CLI；配置不依赖 `gh auth`，仅需 `GITHUB_TOKEN` 环境变量。

### PostgreSQL MCP（已配置结构，待连接串）

使用 `@henkey/postgres-mcp-server`，连接串来自 `DATABASE_URL` 环境变量。

**开发库示例**（与 `.env.example` 一致，请按本机实际修改）：

```
postgresql://postgres:postgres@localhost:5432/ai_video_assistant
```

**你需要：**

1. 本地 PostgreSQL 运行且已 `npm run db:migrate` + `npm run db:seed`
2. 设置 `DATABASE_URL`（可写入本地 `.env`，**不要提交**；同时在用户环境变量中设置供 MCP 使用）
3. 重启 Cursor

**可排查：** `StoreProfile` 外键、`User` seed、`migration` 状态、表数据是否与 API 一致。

建议使用只读或受限 DB 账号。

## 待配置（可选 MCP）

| 工具 | 条件 | 需要提供的凭据 |
|------|------|----------------|
| Redis MCP | BullMQ 队列调试 | 本地 `REDIS_URL`（默认 `redis://localhost:6379`）；可选用 `@modelcontextprotocol/server-redis` 等 |
| Sentry MCP | 生产错误追踪 | 项目未集成 Sentry DSN，暂跳过 |
| Cloudflare MCP | Workers 部署/日志 | Cloudflare API Token + Account ID（`wrangler` 部署用） |

缺少凭据时不要硬编码；向维护者索取后再写入用户级 `mcp.json`。

## 浏览器验证约定

修改 `components/dashboard.tsx` 或门店档案 / 素材库流程后：

1. `npm run dev`
2. browser MCP：填完门店档案三步 →「完成设置」→ 确认素材库解锁

## 本地快速开始

```bash
cp .env.example .env   # 按需编辑 DATABASE_URL
npm install
npm run dev
npm test
```

## 修改 MCP 后

1. 保存 `~/.cursor/mcp.json`
2. **完全退出并重启 Cursor**
3. Settings → Tools & MCP 确认服务绿点
