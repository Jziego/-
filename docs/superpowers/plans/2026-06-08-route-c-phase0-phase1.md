# Route C Phase 0 + Phase 1 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立上线护栏（CI、health、demo 模式），并将门店/素材/脚本/渲染数据持久化到 PostgreSQL，Dashboard 通过 API 读写服务端状态。

**Architecture:** 引入 Prisma 单例 + Repository 仓储层抽象持久化；`runtime-store` 仅在 `DATABASE_URL` 缺失时作为 dev fallback。Dashboard 用 React Query 调 BFF，门店表单草稿仍用 localStorage 做离线缓冲，提交时同步 API。

**Tech Stack:** Prisma 7、PostgreSQL、@tanstack/react-query、Vitest、GitHub Actions

**前置设计文档:** `docs/superpowers/specs/2026-06-08-route-c-production-launch-design.md`

---

## 文件结构预览

```
lib/
  prisma.ts                 # PrismaClient 单例
  env.ts                    # APP_MODE、DATABASE_URL 等 typed env
  repositories/
    index.ts                # getStoreRepository() 工厂
    types.ts                # Repository 接口
    prisma-store.ts         # PG 实现
    memory-store.ts         # runtime-store 适配
  api-client.ts             # 前端 fetch 封装
app/api/health/route.ts     # 健康检查
components/
  providers.tsx             # QueryClientProvider
  demo-badge.tsx            # APP_MODE=demo 角标
prisma/
  migrations/...            # 初始 migration
  seed.ts
.github/workflows/ci.yml
tests/
  repositories/store.test.ts
  api/store-profiles.test.ts
```

---

## Phase 0：护栏

### Task 0.1: 环境变量类型化

**Files:**
- Create: `lib/env.ts`
- Modify: `.env.example`

- [ ] **Step 1: 创建 env 模块**

```typescript
// lib/env.ts
export type AppMode = "demo" | "production";

export function getAppMode(): AppMode {
  const mode = process.env.APP_MODE ?? "demo";
  return mode === "production" ? "production" : "demo";
}

export function hasDatabase(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}

export function getDatabaseUrl(): string | undefined {
  return process.env.DATABASE_URL?.trim() || undefined;
}
```

- [ ] **Step 2: 更新 .env.example**

追加：
```
APP_MODE="demo"
```

- [ ] **Step 3: 运行 typecheck**

```bash
npm run typecheck
```
Expected: PASS

---

### Task 0.2: Health endpoint

**Files:**
- Create: `app/api/health/route.ts`
- Test: `tests/api/health.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// tests/api/health.test.ts
import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/health/route";

describe("GET /api/health", () => {
  it("returns ok status with mode", async () => {
    const response = await GET();
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data.status).toBeDefined();
    expect(body.data.mode).toMatch(/demo|production/);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npm test -- tests/api/health.test.ts
```
Expected: FAIL (module not found)

- [ ] **Step 3: 实现 health route**

```typescript
// app/api/health/route.ts
import { jsonOk } from "@/lib/api-response";
import { getAppMode, hasDatabase } from "@/lib/env";

export async function GET() {
  const checks = {
    database: hasDatabase() ? "configured" : "missing",
    redis: process.env.REDIS_URL ? "configured" : "missing"
  };
  const degraded = checks.database === "missing";

  return jsonOk(
    {
      status: degraded ? "degraded" : "ok",
      mode: getAppMode(),
      checks,
      timestamp: new Date().toISOString()
    },
    degraded ? 200 : 200
  );
}
```

- [ ] **Step 4: 运行测试**

```bash
npm test -- tests/api/health.test.ts
```
Expected: PASS

---

### Task 0.3: Demo 角标

**Files:**
- Create: `components/demo-badge.tsx`
- Modify: `app/layout.tsx`
- Modify: `next.config.ts`（暴露 `NEXT_PUBLIC_APP_MODE`）

- [ ] **Step 1: 在 next.config.ts 添加 env 透传**

```typescript
env: {
  NEXT_PUBLIC_APP_MODE: process.env.APP_MODE ?? "demo"
}
```

- [ ] **Step 2: 创建 DemoBadge 组件**

```tsx
// components/demo-badge.tsx
export function DemoBadge() {
  if (process.env.NEXT_PUBLIC_APP_MODE === "production") return null;
  return (
    <div className="demoBadge" role="status">
      演示版 · 数据可能重置
    </div>
  );
}
```

- [ ] **Step 3: 在 layout.tsx 引入 DemoBadge**

- [ ] **Step 4: 在 globals.css 添加 `.demoBadge` 样式**（右上角固定、半透明）

---

### Task 0.4: GitHub Actions CI

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: 创建 workflow**

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: npm
      - run: npm ci
      - run: npm test
      - run: npm run typecheck
      - run: npm run lint
      - run: npx prisma validate
      - run: npm run build
```

- [ ] **Step 2: 本地跑一遍相同命令确认通过**

---

## Phase 1：持久化

### Task 1.1: Prisma Client 单例

**Files:**
- Create: `lib/prisma.ts`

- [ ] **Step 1: 实现单例（开发环境 global 防热重载多实例）**

```typescript
// lib/prisma.ts
import { PrismaClient } from "@prisma/client";
import { hasDatabase } from "@/lib/env";

const globalForPrisma = globalThis as typeof globalThis & {
  __prisma?: PrismaClient;
};

export function getPrisma(): PrismaClient | null {
  if (!hasDatabase()) return null;
  if (!globalForPrisma.__prisma) {
    globalForPrisma.__prisma = new PrismaClient();
  }
  return globalForPrisma.__prisma;
}
```

- [ ] **Step 2: typecheck**

```bash
npm run typecheck
```

---

### Task 1.2: 初始 Migration

**Files:**
- Create: `prisma/migrations/`（通过 prisma migrate）
- Modify: `package.json`（添加 db 脚本）

- [ ] **Step 1: 添加 package.json scripts**

```json
"db:migrate": "prisma migrate dev",
"db:migrate:deploy": "prisma migrate deploy",
"db:seed": "prisma db seed",
"db:studio": "prisma studio"
```

- [ ] **Step 2: 配置 prisma seed**

在 `package.json` 添加：
```json
"prisma": {
  "seed": "npx tsx prisma/seed.ts"
}
```

- [ ] **Step 3: 创建 seed**

```typescript
// prisma/seed.ts
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  await prisma.user.upsert({
    where: { id: "demo_user" },
    update: {},
    create: {
      id: "demo_user",
      email: "demo@example.com",
      plan: "free",
      quotaRemaining: 10
    }
  });
}

main().finally(() => prisma.$disconnect());
```

- [ ] **Step 4: 本地有 PG 时执行 migrate**

```bash
npx prisma migrate dev --name init
npm run db:seed
```

无本地 PG 时：仅 `npx prisma migrate diff` 生成 SQL 文件提交，Zeabur 部署时 `migrate deploy`。

---

### Task 1.3: Repository 接口与 Prisma 实现

**Files:**
- Create: `lib/repositories/types.ts`
- Create: `lib/repositories/prisma-store.ts`
- Create: `lib/repositories/memory-store.ts`
- Create: `lib/repositories/index.ts`
- Test: `tests/repositories/store.test.ts`

- [ ] **Step 1: 定义 StoreRepository 接口**

```typescript
// lib/repositories/types.ts
import type { StoreProfile } from "@/lib/types";

export interface StoreRepository {
  listByOwner(ownerId: string): Promise<StoreProfile[]>;
  upsert(profile: StoreProfile): Promise<StoreProfile>;
  findById(id: string): Promise<StoreProfile | null>;
}
```

- [ ] **Step 2: 实现 memory-store（包装 runtime-store）**

映射 `StoreProfile` ↔ runtime store 数组，字段与 Prisma 一致。

- [ ] **Step 3: 实现 prisma-store**

`upsert` 用 `prisma.storeProfile.upsert`；`mainProducts` 等 `String[]` 直接存。

- [ ] **Step 4: 工厂函数**

```typescript
// lib/repositories/index.ts
export function getStoreRepository(): StoreRepository {
  const prisma = getPrisma();
  return prisma ? new PrismaStoreRepository(prisma) : new MemoryStoreRepository();
}
```

- [ ] **Step 5: 写 repository 单测**（memory 实现，无需 DB）

- [ ] **Step 6: 运行测试**

```bash
npm test -- tests/repositories/store.test.ts
```

---

### Task 1.4: 改造 store-profiles API

**Files:**
- Modify: `app/api/store-profiles/route.ts`
- Test: `tests/api/store-profiles.test.ts`

- [ ] **Step 1: 写 API 测试**（mock getStoreRepository 或使用 memory）

- [ ] **Step 2: 替换 getRuntimeState() 为 getStoreRepository()**

GET: `listByOwner(demoOwnerId)` — Phase 5 前仍用 demoOwnerId  
POST: `upsert(parsed.data)`

- [ ] **Step 3: 测试通过**

```bash
npm test -- tests/api/store-profiles.test.ts
```

---

### Task 1.5: 其余实体 Repository + API 改造

**按相同模式依次完成：**

| Repository | API routes |
|------------|------------|
| `AssetRepository` + `AssetAnalysisRepository` | `assets/`, `assets/analyze/`, `assets/upload-intent/` |
| `AvatarRepository` | `avatars/`, `avatars/talking-head/` |
| `ScriptRepository` | `script-drafts/` |
| `RenderRepository` + `JobRepository` | `render-projects/`, `jobs/` |

**每个实体 Task 结构：**
1. 接口定义
2. prisma + memory 实现
3. 单测（memory）
4. API route 替换
5. API 契约测试

**注意：** `upload-intent` 此阶段仍返回占位 URL（Phase 2 再改）；但 POST asset 应写入 DB。

---

### Task 1.6: 前端 API Client

**Files:**
- Create: `lib/api-client.ts`
- Create: `components/providers.tsx`
- Modify: `app/layout.tsx`

- [ ] **Step 1: api-client 封装**

```typescript
// lib/api-client.ts
import type { StoreProfile } from "@/lib/types";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers }
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? "Request failed");
  return json.data as T;
}

export async function fetchStores(): Promise<StoreProfile[]> {
  const data = await api<{ stores: StoreProfile[] }>("/api/store-profiles");
  return data.stores;
}

export async function saveStore(profile: StoreProfile): Promise<StoreProfile> {
  const data = await api<{ store: StoreProfile }>("/api/store-profiles", {
    method: "POST",
    body: JSON.stringify(profile)
  });
  return data.store;
}

// ... fetchAssets, saveAsset, analyzeAsset, createAvatar, createRenderProject, fetchJobs
```

- [ ] **Step 2: QueryClientProvider 包裹 app**

```tsx
// components/providers.tsx
"use client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(() => new QueryClient());
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
```

---

### Task 1.7: Dashboard 接入 API

**Files:**
- Modify: `components/dashboard.tsx`
- Modify: `tests/dashboard.test.tsx`

- [ ] **Step 1: 启动时 `useQuery` 拉取 store**

`queryKey: ["stores"]`，有数据时 `setStore(stores[0])`

- [ ] **Step 2: `submitCurrentStoreStep` 最后一步改为 `saveStore` API**

成功后 `queryClient.invalidateQueries({ queryKey: ["stores"] })`

- [ ] **Step 3: `simulateAssetUpload` → 调 API**

流程：`createUploadIntent` API → POST asset → POST analyze（或合并）

- [ ] **Step 4: `simulateAvatarClone` → POST avatars + talking-head API**

- [ ] **Step 5: `simulateOneClickRender` → POST script-drafts + render-projects API**

- [ ] **Step 6: Jobs 用 `useQuery` 轮询 `/api/jobs`（5s interval，有 pending 时）**

- [ ] **Step 7: 更新 dashboard.test.tsx**

Mock `fetch` 或使用 MSW；更新断言匹配新流程。

- [ ] **Step 8: 全量测试**

```bash
npm test
npm run typecheck
npm run build
```

---

### Task 1.8: Zeabur 部署配置

**Files:**
- Modify: `zbpack.json` 或 Zeabur 控制台文档
- Modify: `README.md`

- [ ] **Step 1: Zeabur 添加 PostgreSQL 插件**

绑定后自动注入 `DATABASE_URL`

- [ ] **Step 2: 添加 Build 后 migrate 命令**

Zeabur Pre-deploy 或 start script 包装：
```json
"start:prod": "prisma migrate deploy && npm run start"
```

- [ ] **Step 3: 设置 `APP_MODE=production`（内测时保持 demo）**

- [ ] **Step 4: README 补充 Zeabur + PG 步骤**

---

## Phase 1 验收清单

- [ ] 本地 `DATABASE_URL` 指向 PG，门店档案保存后刷新仍在
- [ ] 无 `DATABASE_URL` 时 dev 仍可用（memory fallback）
- [ ] Zeabur 重启后数据保留
- [ ] `GET /api/health` 返回 `database: configured`
- [ ] CI 全绿
- [ ] 现有 + 新增测试全绿
- [ ] Dashboard 不再硬编码 `store_demo` 为唯一持久化路径（ID 可由 API 返回）

---

## 后续计划（不在本计划范围）

- **Phase 2:** `docs/superpowers/plans/2026-06-08-route-c-phase2-storage.md`（待 Phase 1 完成后编写）
- **Phase 3:** Worker 服务
- **Phase 4:** 真实 AI
- **Phase 5:** Auth + 配额

---

## 常见坑与对策

| 坑 | 对策 |
|----|------|
| Prisma 7 + Next.js 热重载多连接 | `globalThis` 单例 |
| Zeabur build 无 DATABASE_URL | migrate 放 start 前，build 只 `prisma generate` |
| Dashboard 测试依赖 simulate | mock fetch，保留 UI 行为测试 |
| promotions 类型 drift | Repository 层 `?? []` 统一 |
| 双写 localStorage 与 API 冲突 | 提交成功后清 localStorage 草稿 |
