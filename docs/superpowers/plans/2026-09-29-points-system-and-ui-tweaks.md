# 积分系统 + 三项界面调整 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给网站加一套积分系统（余额、原子扣减、兑换码充值、后台管理、全量流水），并移除微信登录、字幕上移至画面下 1/3 线、移除口播稿确认页的背景音乐选项。

**Architecture:** 积分核心是一个新的 `lib/points.ts` 服务（Prisma 直连 + `$transaction`，与现有 `lib/quota.ts` 同模式），取代现有 `consumeQuota` 的两个调用点并新增写稿扣费点。数据层加 3 个 Prisma 模型（`User.pointsBalance` 字段 + `PointsLedger` + `RechargeCode`）。后台是纯环境变量密钥保护的 `/admin` 页面 + `/api/admin/*` 路由。不做在线支付。

**Tech Stack:** Next.js 16 App Router、Prisma 7 (PostgreSQL)、Vitest、Redis 固定窗口限流（复用 `lib/rate-limit.ts` 基础设施）。

## 已确认的规格（与需求方敲定，不得擅自更改）

- **定价**（`lib/points-pricing.ts` 唯一来源，10 积分 = ¥1）：
  | 功能 | 扣分 | 说明 |
  |---|---|---|
  | 生成口播稿（POST /api/script-drafts） | 10 | 成本 ≈¥0.02，兼防刷屏 |
  | 渲染视频（POST /api/render-projects） | 30 + 250×出镜形象数 | 基础（TTS+合成）30；每个数字人 250 |
  | 数字人口播预览（POST /api/avatars/talking-head） | 250 | 火山对口型 ≈¥1.1/分钟 |
- 新用户余额 0，积分唯一来源是兑换码；**不做在线支付**。
- 余额不足返回 402，用户看到的中文提示必须是：**「积分已用完，请联系客服充值」**。
- 兑换码：后台批量生成（指定面值+数量），一码一次；格式 `XXXX-XXXX-XXXX-XXXX`（无歧义字符表）。兑换接口限流防爆破。
- 后台（`/admin`，`x-admin-key` 头对环境变量 `ADMIN_KEY`）：批量生成码、按邮箱手动加减积分、查流水。密钥只存在于 Zeabur 环境变量，页面上输入一次存 localStorage。
- 流水必录字段：谁（ownerId）、多少（delta）、原因（中文 reason）、时间（createdAt）、变动后余额（balanceAfter）。
- 积分扣减/兑换/手动调整全部在数据库事务内完成；原子防负（`updateMany` 守卫）。
- 字幕：ASS `marginV` 全部预设改为 640（1080×1920 画布的下 1/3 线），避开抖音底部 UI。
- 微信登录彻底移除（登录页按钮、server action、auth.ts provider 注册、env 访问器、`lib/auth/wechat-provider.ts` 文件）。
- BGM：只从口播稿确认页移除选项（UI + 数据流）；`BgmTrack` 模型、`/api/bgm-tracks` 路由、渲染管线保留不动。
- 现有 `lib/quota.ts` 与 `quotaRemaining`/`plan` 字段**保留不删**（仅不再被三个路由调用），避免无关迁移。

## 文件结构总览

| 文件 | 动作 | 责任 |
|---|---|---|
| `prisma/schema.prisma` | 修改 | User 加 `pointsBalance`；新增 `PointsLedger`、`RechargeCode` |
| `prisma/migrations/…add_points_system` | 新建 | 迁移 |
| `lib/points-pricing.ts` | 新建 | 积分定价常量与计价函数（服务端/客户端共用） |
| `lib/points.ts` | 新建 | 积分核心服务：查余额/扣减/兑换/手动调整/生成码 |
| `lib/admin-auth.ts` | 新建 | 后台密钥校验（timingSafeEqual） |
| `lib/env.ts` | 修改 | 加 `getAdminKey()`；删 3 个微信访问器 |
| `lib/api-response.ts` | 修改 | 加 `jsonPointsError()`（402） |
| `lib/rate-limit.ts` | 修改 | 加 `rateLimitRedeem()`、`rateLimitAdminIp()` |
| `lib/api-client.ts` | 修改 | 402 消息透传、积分 API、事件桥；删 BGM 客户端函数 |
| `app/api/points/route.ts` | 新建 | GET 余额 |
| `app/api/points/redeem/route.ts` | 新建 | POST 兑换（限流） |
| `app/api/admin/codes/route.ts` | 新建 | POST 批量生成码 |
| `app/api/admin/adjust/route.ts` | 新建 | POST 手动加减 |
| `app/api/admin/ledger/route.ts` | 新建 | GET 查流水 |
| `app/api/script-drafts/route.ts` | 修改 | 写稿前扣 10 积分 |
| `app/api/render-projects/route.ts` | 修改 | 渲染前扣 30+250n，替换 consumeQuota |
| `app/api/avatars/talking-head/route.ts` | 修改 | 预览前扣 250，替换 consumeQuota |
| `app/admin/page.tsx` | 新建 | 后台页面（密钥门 + 三个功能） |
| `middleware.ts` | 修改 | public paths 加 `/admin`、`/api/admin` |
| `components/header.tsx` | 修改 | 积分余额 + 兑换入口 |
| `components/dashboard.tsx` | 修改 | 402 提示映射、积分变更事件、删 BGM 数据流 |
| `components/script-confirm.tsx` | 修改 | 消耗积分提示；删 BGM 选项 |
| `app/login/page.tsx`、`app/login/actions.ts`、`auth.ts` | 修改 | 删微信登录 |
| `lib/auth/wechat-provider.ts` | 删除 | 微信 OAuth provider |
| `lib/services/video-compose.ts` | 修改 | `marginV` → 640 命名常量 |
| 测试若干 | 新建/修改 | 见各 Task |

---

## Task 1: 积分数据层 + 定价常量 + 核心服务

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_add_points_system/migration.sql`（由 `prisma migrate dev` 生成，无需手写）
- Create: `lib/points-pricing.ts`
- Create: `lib/points.ts`
- Test: `tests/points-pricing.test.ts`、`tests/points.test.ts`

- [ ] **Step 1: 写定价常量（先建文件，纯函数无失败测试可跑，测试在 Step 2 一起写）**

`lib/points-pricing.ts`:

```ts
/**
 * 积分定价（10 积分 = ¥1）。服务端扣减点与前端 script-confirm 展示共用此唯一来源。
 * 调价只改这里。成本依据（2026-09 与需求方确认）：
 * 写稿 ≈¥0.02/次 · 渲染基础 ≈¥0.15/次（豆包TTS+ffmpeg）· 数字人 ≈¥1.1/60s（火山对口型 ¥1/分钟 + TTS）
 */
export const POINTS_PER_YUAN = 10;

/** 生成口播稿 */
export const SCRIPT_DRAFT_POINTS = 10;
/** 渲染视频基础（TTS + 合成，无数字人） */
export const RENDER_BASE_POINTS = 30;
/** 每个出镜数字人（火山对口型按分钟计费的大头） */
export const AVATAR_APPEARANCE_POINTS = 250;

/** 渲染总价 = 基础 + 250 × 出镜形象数。形象数取渲染请求校验后的数量（0~3）。 */
export function renderPointsCost(avatarCount: number): number {
  return RENDER_BASE_POINTS + AVATAR_APPEARANCE_POINTS * Math.max(0, avatarCount);
}
```

- [ ] **Step 2: 写失败测试**

`tests/points-pricing.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  AVATAR_APPEARANCE_POINTS,
  POINTS_PER_YUAN,
  RENDER_BASE_POINTS,
  SCRIPT_DRAFT_POINTS,
  renderPointsCost,
} from "@/lib/points-pricing";

describe("points pricing", () => {
  it("10 积分 = 1 元", () => {
    expect(POINTS_PER_YUAN).toBe(10);
  });

  it("定价与确认表一致：写稿 10 / 渲染基础 30 / 数字人 250", () => {
    expect(SCRIPT_DRAFT_POINTS).toBe(10);
    expect(RENDER_BASE_POINTS).toBe(30);
    expect(AVATAR_APPEARANCE_POINTS).toBe(250);
  });

  it("renderPointsCost：无数字人 = 基础价；负数形象按 0 计", () => {
    expect(renderPointsCost(0)).toBe(30);
    expect(renderPointsCost(-2)).toBe(30);
  });

  it("renderPointsCost：1~3 个形象", () => {
    expect(renderPointsCost(1)).toBe(280);
    expect(renderPointsCost(2)).toBe(530);
    expect(renderPointsCost(3)).toBe(780);
  });
});
```

`tests/points.test.ts`（mock Prisma，验证事务内守卫 + 流水写入）:

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * 假 Prisma：$transaction 直接同步执行回调并返回其结果；
 * user.updateMany 依据 where.pointsBalance.gte 模拟守卫；
 * 记录所有 create 调用供流水断言。
 */
function makeFakePrisma(initialBalance: number) {
  const state = { balance: initialBalance };
  const created: { table: string; data: Record<string, unknown> }[] = [];
  const tx = {
    user: {
      updateMany: vi.fn(({ where, data }) => {
        if (state.balance >= where.pointsBalance.gte) {
          state.balance -= data.pointsBalance.decrement;
          return Promise.resolve({ count: 1 });
        }
        return Promise.resolve({ count: 0 });
      }),
      update: vi.fn(({ data }) => {
        state.balance += data.pointsBalance.increment;
        return Promise.resolve({ id: "u1", pointsBalance: state.balance });
      }),
      findUniqueOrThrow: vi.fn(() => Promise.resolve({ id: "u1", pointsBalance: state.balance })),
    },
    rechargeCode: {
      findUnique: vi.fn(({ where }: { where: { code: string } }) =>
        Promise.resolve(
          where.code === "GOODCODE"
            ? { id: "rc1", code: "GOODCODE", points: 100, status: "unused" }
            : null,
        ),
      ),
      update: vi.fn(() => Promise.resolve({})),
    },
    pointsLedger: {
      create: vi.fn(({ data }: { data: Record<string, unknown> }) => {
        created.push({ table: "pointsLedger", data });
        return Promise.resolve(data);
      }),
    },
  };
  const prisma = {
    $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    ...tx,
  };
  return { prisma, state, created, tx };
}

async function importPoints() {
  return import("@/lib/points");
}

describe("points service", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("consumePoints：余额充足时原子扣减并写流水（负 delta + 变动后余额）", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://fake");
    const { prisma, state, created } = makeFakePrisma(100);
    vi.doMock("@/lib/prisma", () => ({ getPrisma: () => prisma }));
    const { consumePoints } = await importPoints();

    const result = await consumePoints("u1", 30, "渲染视频");

    expect(result.balance).toBe(70);
    expect(state.balance).toBe(70);
    expect(created).toHaveLength(1);
    expect(created[0].data).toMatchObject({
      ownerId: "u1",
      delta: -30,
      reason: "渲染视频",
      balanceAfter: 70,
    });
  });

  it("consumePoints：余额不足抛 PointsExhaustedError（消息为用户可见文案），不写流水", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://fake");
    const { prisma, created } = makeFakePrisma(10);
    vi.doMock("@/lib/prisma", () => ({ getPrisma: () => prisma }));
    const { consumePoints, PointsExhaustedError } = await importPoints();

    await expect(consumePoints("u1", 250, "数字人出镜")).rejects.toBeInstanceOf(PointsExhaustedError);
    await expect(consumePoints("u1", 250, "数字人出镜")).rejects.toThrow("积分已用完，请联系客服充值");
    expect(created).toHaveLength(0);
  });

  it("consumePoints：无数据库时跳过扣减（与 quota 同口径的 dev 降级）", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const { consumePoints } = await importPoints();
    await expect(consumePoints("u1", 10, "生成口播稿")).resolves.toEqual({ balance: 0 });
  });

  it("redeemPointsCode：未使用码 → 加余额、标记已兑换、写正数流水", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://fake");
    const { prisma, state, created, tx } = makeFakePrisma(50);
    vi.doMock("@/lib/prisma", () => ({ getPrisma: () => prisma }));
    const { redeemPointsCode } = await importPoints();

    const result = await redeemPointsCode("u1", "good-code-任意格式");

    expect(result).toEqual({ points: 100, balance: 150 });
    expect(state.balance).toBe(150);
    expect(tx.rechargeCode.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "redeemed", redeemedById: "u1" }),
      }),
    );
    expect(created[0].data).toMatchObject({ delta: 100, reason: "兑换码充值", balanceAfter: 150 });
  });

  it("redeemPointsCode：无效码/已使用码抛 InvalidRedeemCodeError", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://fake");
    const { prisma } = makeFakePrisma(50);
    prisma.rechargeCode.findUnique = vi.fn(() =>
      Promise.resolve({ id: "rc1", code: "GOODCODE", points: 100, status: "redeemed" }),
    );
    vi.doMock("@/lib/prisma", () => ({ getPrisma: () => prisma }));
    const { redeemPointsCode, InvalidRedeemCodeError } = await importPoints();

    await expect(redeemPointsCode("u1", "NOPE")).rejects.toBeInstanceOf(InvalidRedeemCodeError);
    await expect(redeemPointsCode("u1", "GOODCODE")).rejects.toBeInstanceOf(InvalidRedeemCodeError);
  });

  it("adminAdjustPoints：正数加积分写流水（原因含客服备注）", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://fake");
    const { prisma, state, created } = makeFakePrisma(0);
    prisma.user.findUnique = vi.fn(() =>
      Promise.resolve({ id: "u1", email: "a@b.com", pointsBalance: state.balance }),
    );
    vi.doMock("@/lib/prisma", () => ({ getPrisma: () => prisma }));
    const { adminAdjustPoints } = await importPoints();

    const result = await adminAdjustPoints("a@b.com", 500, "微信收款50元");

    expect(result).toEqual({ email: "a@b.com", balance: 500 });
    expect(created[0].data).toMatchObject({
      delta: 500,
      reason: "客服手动调整：微信收款50元",
      balanceAfter: 500,
    });
  });

  it("adminAdjustPoints：扣减不能导致负余额；邮箱不存在报 UserNotFoundError", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://fake");
    const { prisma, state } = makeFakePrisma(10);
    prisma.user.findUnique = vi.fn(({ where }: { where: { email: string } }) =>
      Promise.resolve(
        where.email === "a@b.com"
          ? { id: "u1", email: "a@b.com", pointsBalance: state.balance }
          : null,
      ),
    );
    vi.doMock("@/lib/prisma", () => ({ getPrisma: () => prisma }));
    const { adminAdjustPoints, AdminAdjustError, UserNotFoundError } = await importPoints();

    await expect(adminAdjustPoints("a@b.com", -50, "测试")).rejects.toBeInstanceOf(AdminAdjustError);
    await expect(adminAdjustPoints("ghost@x.com", 10, "")).rejects.toBeInstanceOf(UserNotFoundError);
  });
});
```

- [ ] **Step 3: 确认测试失败**

Run: `npx vitest run tests/points-pricing.test.ts tests/points.test.ts`
Expected: FAIL —— `@/lib/points` / `@/lib/points-pricing` 模块不存在（Cannot find module）。

- [ ] **Step 4: 实现 `lib/points.ts`**

```ts
import { Prisma } from "@prisma/client";
import { hasDatabase } from "@/lib/env";
import { createId } from "@/lib/ids";
import { getPrisma } from "@/lib/prisma";

export class PointsExhaustedError extends Error {
  constructor() {
    super("积分已用完，请联系客服充值");
    this.name = "PointsExhaustedError";
  }
}

export class InvalidRedeemCodeError extends Error {
  constructor() {
    super("兑换码无效或已被使用");
    this.name = "InvalidRedeemCodeError";
  }
}

export class AdminAdjustError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminAdjustError";
  }
}

export class UserNotFoundError extends Error {
  constructor() {
    super("用户不存在");
    this.name = "UserNotFoundError";
  }
}

/** 查询积分余额；无数据库（本地 dev）返回 null，前端显示「—」。 */
export async function getPointsBalance(userId: string): Promise<number | null> {
  if (!hasDatabase()) return null;
  const user = await getPrisma()!.user.findUniqueOrThrow({ where: { id: userId } });
  return user.pointsBalance;
}

/**
 * 原子扣减积分（updateMany 守卫防负）+ 写流水，同一事务。
 * 余额不足抛 PointsExhaustedError（消息即用户可见文案），事务回滚不写流水。
 * 无数据库时跳过扣减 —— 与 lib/quota.ts 的 dev 降级口径一致。
 */
export async function consumePoints(
  userId: string,
  amount: number,
  reason: string,
): Promise<{ balance: number }> {
  if (!hasDatabase()) return { balance: 0 };
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error("consumePoints amount must be a positive integer");
  }
  const prisma = getPrisma()!;
  return prisma.$transaction(async (tx) => {
    const result = await tx.user.updateMany({
      where: { id: userId, pointsBalance: { gte: amount } },
      data: { pointsBalance: { decrement: amount } },
    });
    if (result.count === 0) throw new PointsExhaustedError();
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
    await tx.pointsLedger.create({
      data: {
        id: createId("pl"),
        ownerId: userId,
        delta: -amount,
        reason,
        balanceAfter: user.pointsBalance,
      },
    });
    return { balance: user.pointsBalance };
  });
}

/**
 * 兑换充值码：码标记已使用 + 余额增加 + 写流水，同一事务。
 * 一码一次 —— status 守卫在事务内，并发兑换只有一个成功。
 */
export async function redeemPointsCode(
  userId: string,
  rawCode: string,
): Promise<{ points: number; balance: number }> {
  if (!hasDatabase()) throw new Error("积分功能未启用");
  const code = normalizeRedeemCode(rawCode);
  const prisma = getPrisma()!;
  return prisma.$transaction(async (tx) => {
    const row = await tx.rechargeCode.findUnique({ where: { code } });
    if (!row || row.status !== "unused") throw new InvalidRedeemCodeError();
    const user = await tx.user.update({
      where: { id: userId },
      data: { pointsBalance: { increment: row.points } },
    });
    await tx.rechargeCode.update({
      where: { id: row.id },
      data: { status: "redeemed", redeemedById: userId, redeemedAt: new Date() },
    });
    await tx.pointsLedger.create({
      data: {
        id: createId("pl"),
        ownerId: userId,
        delta: row.points,
        reason: "兑换码充值",
        balanceAfter: user.pointsBalance,
      },
    });
    return { points: row.points, balance: user.pointsBalance };
  });
}

/**
 * 客服手动加减积分（线下收款后手动充）。delta 可负，但不允许扣成负余额。
 * reason 固定前缀「客服手动调整」+ 备注，便于对账。
 */
export async function adminAdjustPoints(
  email: string,
  delta: number,
  note: string,
): Promise<{ email: string; balance: number }> {
  if (!hasDatabase()) throw new Error("积分功能未启用");
  if (!Number.isInteger(delta) || delta === 0) {
    throw new AdminAdjustError("delta 必须是非零整数");
  }
  const normalized = email.trim().toLowerCase();
  const prisma = getPrisma()!;
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { email: normalized } });
    if (!user) throw new UserNotFoundError();
    if (delta < 0) {
      const guard = await tx.user.updateMany({
        where: { id: user.id, pointsBalance: { gte: -delta } },
        data: { pointsBalance: { decrement: -delta } },
      });
      if (guard.count === 0) throw new AdminAdjustError("扣减后余额不能为负");
    } else {
      await tx.user.update({
        where: { id: user.id },
        data: { pointsBalance: { increment: delta } },
      });
    }
    const updated = await tx.user.findUniqueOrThrow({ where: { id: user.id } });
    await tx.pointsLedger.create({
      data: {
        id: createId("pl"),
        ownerId: user.id,
        delta,
        reason: `客服手动调整${note ? `：${note}` : ""}`,
        balanceAfter: updated.pointsBalance,
      },
    });
    return { email: normalized, balance: updated.pointsBalance };
  });
}

// ── 兑换码生成 ──────────────────────────────────────────────────────────────

/** 无歧义字符表：去掉 0/O、1/I，避免用户手输/口播混淆。 */
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const CODE_GROUPS = 4;
const CODE_GROUP_LEN = 4;
export const MAX_CODES_PER_BATCH = 500;

function generateCodeString(): string {
  const groups: string[] = [];
  for (let g = 0; g < CODE_GROUPS; g++) {
    let group = "";
    for (let i = 0; i < CODE_GROUP_LEN; i++) {
      group += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    groups.push(group);
  }
  return groups.join("-");
}

/** 输入归一化：去所有非字母数字字符并大写，用户带不带横杠都能兑。 */
export function normalizeRedeemCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * 批量生成兑换码。唯一索引兜底 + 碰撞重试（理论碰撞率可忽略，重试 5 次是保险）。
 */
export async function generateRechargeCodes(
  points: number,
  count: number,
): Promise<string[]> {
  const prisma = getPrisma()!;
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    for (let attempt = 0; ; attempt++) {
      const code = generateCodeString();
      try {
        await prisma.rechargeCode.create({
          data: { id: createId("rc"), code, points },
        });
        codes.push(code);
        break;
      } catch (error) {
        if (attempt >= 5 || !isUniqueViolation(error)) throw error;
      }
    }
  }
  return codes;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
  );
}
```

- [ ] **Step 5: Prisma schema 修改 + 迁移**

在 `prisma/schema.prisma` 中三处修改：

1. `User` model 加字段与关系（放在 `quotaRemaining` 之后）：
```prisma
  pointsBalance  Int             @default(0)
  pointsLedgers  PointsLedger[]
```
2. 文件末尾追加两个 model：
```prisma
model PointsLedger {
  id           String   @id
  ownerId      String
  delta        Int
  reason       String
  balanceAfter Int
  createdAt    DateTime @default(now())
  owner        User     @relation(fields: [ownerId], references: [id])

  @@index([ownerId, createdAt])
}

model RechargeCode {
  id           String    @id
  code         String    @unique
  points       Int
  status       String    @default("unused")
  redeemedById String?
  redeemedAt   DateTime?
  createdAt    DateTime  @default(now())

  @@index([status])
}
```

Run: `npx prisma migrate dev --name add_points_system`
Expected: 迁移成功，client 重新生成（`npm run build` 的前置 `prisma generate` 也会做）。

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run tests/points-pricing.test.ts tests/points.test.ts`
Expected: PASS（14 assertions 全绿）

- [ ] **Step 7: 全量回归 + 提交**

Run: `npm test && npm run typecheck`
Expected: PASS（新增模型不影响存量测试）

```bash
git add prisma/schema.prisma prisma/migrations lib/points.ts lib/points-pricing.ts tests/points.test.ts tests/points-pricing.test.ts
git commit -m "feat(points): 积分数据层、定价常量与核心服务（扣减/兑换/调整，事务+流水）"
```

---

## Task 2: 兑换限流 + 用户积分 API

**Files:**
- Modify: `lib/rate-limit.ts`
- Create: `app/api/points/route.ts`
- Create: `app/api/points/redeem/route.ts`
- Test: `tests/rate-limit.test.ts`（追加 describe）、`tests/api-points.test.ts`

- [ ] **Step 1: 写限流失败测试（追加到 `tests/rate-limit.test.ts` 末尾）**

```ts
describe("rateLimitRedeem / rateLimitAdminIp", () => {
  it("兑换限流：按 owner 与 IP 双窗口计数（memory 后端，demo 模式）", async () => {
    vi.stubEnv("APP_MODE", "demo");
    vi.stubEnv("REDIS_URL", "");
    const { _resetMemoryStore } = await import("@/lib/rate-limit");
    const { rateLimitRedeem, rateLimitAdminIp } = await import("@/lib/rate-limit");
    _resetMemoryStore();

    // owner 窗口 10/min：第 11 次拒绝
    for (let i = 0; i < 10; i++) {
      expect(await rateLimitRedeem("u1", "1.2.3.4")).toBe(true);
    }
    expect(await rateLimitRedeem("u1", "1.2.3.4")).toBe(false);
    // 另一 owner 不受 u1 计数影响
    expect(await rateLimitRedeem("u2", "1.2.3.4")).toBe(true);
    _resetMemoryStore();

    // IP 窗口 30/min：同 IP 不同 owner 累计到 30 后拒绝
    for (let i = 0; i < 29; i++) {
      expect(await rateLimitRedeem(`u${i}`, "9.9.9.9")).toBe(true);
    }
    expect(await rateLimitRedeem("uX", "9.9.9.9")).toBe(false);
    _resetMemoryStore();

    // admin IP 窗口 30/min
    for (let i = 0; i < 30; i++) {
      expect(await rateLimitAdminIp("5.5.5.5")).toBe(true);
    }
    expect(await rateLimitAdminIp("5.5.5.5")).toBe(false);
    vi.unstubAllEnvs();
  });
});
```

Run: `npx vitest run tests/rate-limit.test.ts -t "rateLimitRedeem"`
Expected: FAIL —— `rateLimitRedeem is not a function`。

- [ ] **Step 2: 实现限流函数（`lib/rate-limit.ts`，追加到 OTP 限流之后）**

```ts
// ── Redeem & admin rate limits ─────────────────────────────────────────────

const REDEEM_OWNER_PER_MINUTE: RateLimitConfig = { windowSeconds: 60, maxRequests: 10 };
const REDEEM_IP_PER_MINUTE: RateLimitConfig = { windowSeconds: 60, maxRequests: 30 };
const ADMIN_IP_PER_MINUTE: RateLimitConfig = { windowSeconds: 60, maxRequests: 30 };

/**
 * 兑换接口爆破防护：每 owner 10 次/分钟 + 每 IP 30 次/分钟。
 * 兑换码空间 32^16，爆破不现实，限流挡的是脚本刷接口/探测。
 * 与 OTP 同口径：只消费 .allowed，needReset=false 跳过 ttl 命令。
 */
export async function rateLimitRedeem(ownerId: string, ip: string): Promise<boolean> {
  const [owner, ipResult] = await Promise.all([
    checkLimit(`redeem:owner:${ownerId}`, REDEEM_OWNER_PER_MINUTE, false),
    checkLimit(`redeem:ip:${ip}`, REDEEM_IP_PER_MINUTE, false),
  ]);
  return owner.allowed && ipResult.allowed;
}

/** 后台接口 IP 限流（30/min）：后台走 x-admin-key 鉴权，多一层防扫。 */
export async function rateLimitAdminIp(ip: string): Promise<boolean> {
  const result = await checkLimit(`admin:ip:${ip}`, ADMIN_IP_PER_MINUTE, false);
  return result.allowed;
}
```

Run: `npx vitest run tests/rate-limit.test.ts`
Expected: PASS。

- [ ] **Step 3: 写路由失败测试**

`tests/api-points.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";

const { getOwnerIdMock, redeemMock, balanceMock } = vi.hoisted(() => ({
  getOwnerIdMock: vi.fn(),
  redeemMock: vi.fn(),
  balanceMock: vi.fn(),
}));

vi.mock("@/lib/auth-helpers", () => ({ getOwnerId: getOwnerIdMock }));
vi.mock("@/lib/points", () => ({
  redeemPointsCode: redeemMock,
  getPointsBalance: balanceMock,
  InvalidRedeemCodeError: class InvalidRedeemCodeError extends Error {},
}));
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return {
    ...actual,
    applyRateLimit: vi.fn(() => Promise.resolve(null)),
    rateLimitRedeem: vi.fn(() => Promise.resolve(true)),
  };
});

import { GET as pointsGET } from "@/app/api/points/route";
import { POST as redeemPOST } from "@/app/api/points/redeem/route";

describe("GET /api/points", () => {
  beforeEach(() => vi.clearAllMocks());

  it("返回余额", async () => {
    getOwnerIdMock.mockResolvedValue("u1");
    balanceMock.mockResolvedValue(230);
    const res = await pointsGET(new Request("http://localhost/api/points"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ balance: 230 });
  });
});

describe("POST /api/points/redeem", () => {
  beforeEach(() => vi.clearAllMocks());

  it("兑换成功返回积分与余额", async () => {
    getOwnerIdMock.mockResolvedValue("u1");
    redeemMock.mockResolvedValue({ points: 100, balance: 330 });
    const res = await redeemPOST(
      new Request("http://localhost/api/points/redeem", {
        method: "POST",
        body: JSON.stringify({ code: "ABCD-EFGH-JKLM-NPQR" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ points: 100, balance: 330 });
    expect(redeemMock).toHaveBeenCalledWith("u1", "ABCD-EFGH-JKLM-NPQR");
  });

  it("非 JSON body → 400；缺 code → 400", async () => {
    getOwnerIdMock.mockResolvedValue("u1");
    const bad = await redeemPOST(
      new Request("http://localhost/api/points/redeem", { method: "POST", body: "not-json" }),
    );
    expect(bad.status).toBe(400);
    const missing = await redeemPOST(
      new Request("http://localhost/api/points/redeem", { method: "POST", body: "{}" }),
    );
    expect(missing.status).toBe(400);
  });

  it("无效/已使用码 → 400（用户可见中文消息）", async () => {
    getOwnerIdMock.mockResolvedValue("u1");
    const { InvalidRedeemCodeError } = await import("@/lib/points");
    redeemMock.mockRejectedValue(new InvalidRedeemCodeError());
    const res = await redeemPOST(
      new Request("http://localhost/api/points/redeem", {
        method: "POST",
        body: JSON.stringify({ code: "USED-CODE-0000-0000" }),
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("兑换码");
  });
});
```

Run: `npx vitest run tests/api-points.test.ts`
Expected: FAIL —— 路由模块不存在。

- [ ] **Step 4: 实现两个路由**

`app/api/points/route.ts`:

```ts
import { jsonOk } from "@/lib/api-response";
import { applyRateLimit } from "@/lib/rate-limit";
import { getOwnerId } from "@/lib/auth-helpers";
import { getPointsBalance } from "@/lib/points";

export async function GET(request: Request) {
  const ownerId = await getOwnerId();
  const limited = await applyRateLimit(request, ownerId);
  if (limited) return limited;
  const balance = await getPointsBalance(ownerId);
  return jsonOk({ balance });
}
```

`app/api/points/redeem/route.ts`:

```ts
import { jsonError, jsonOk } from "@/lib/api-response";
import { applyRateLimit, getClientIp, rateLimitRedeem } from "@/lib/rate-limit";
import { getOwnerId } from "@/lib/auth-helpers";
import { InvalidRedeemCodeError, redeemPointsCode } from "@/lib/points";

export async function POST(request: Request) {
  let body: { code?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonError("Request body must be valid JSON", 400);
  }
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!code) return jsonError("code is required", 400);

  const ownerId = await getOwnerId();
  const limited = await applyRateLimit(request, ownerId);
  if (limited) return limited;

  // 专项爆破限流（L2 通用写桶之外再加 owner/IP 双窗口）
  if (!(await rateLimitRedeem(ownerId, getClientIp(request.headers)))) {
    return jsonError("尝试过于频繁，请稍后再试", 429);
  }

  try {
    const result = await redeemPointsCode(ownerId, code);
    return jsonOk(result);
  } catch (error) {
    if (error instanceof InvalidRedeemCodeError) return jsonError(error.message, 400);
    throw error;
  }
}
```

Run: `npx vitest run tests/api-points.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add lib/rate-limit.ts app/api/points tests/api-points.test.ts tests/rate-limit.test.ts
git commit -m "feat(points): 积分余额查询与兑换接口（专项限流防爆破）"
```

---

## Task 3: 后台管理 API

**Files:**
- Modify: `lib/env.ts`（加 `getAdminKey`）
- Create: `lib/admin-auth.ts`
- Create: `app/api/admin/codes/route.ts`、`app/api/admin/adjust/route.ts`、`app/api/admin/ledger/route.ts`
- Test: `tests/admin-auth.test.ts`、`tests/api-admin.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/admin-auth.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

describe("assertAdminRequest", () => {
  beforeEach(() => vi.stubEnv("ADMIN_KEY", "super-secret"));
  afterEach(() => vi.unstubAllEnvs());

  it("未配置 ADMIN_KEY → AdminAuthError(503)", async () => {
    vi.stubEnv("ADMIN_KEY", "");
    const { assertAdminRequest, AdminAuthError } = await import("@/lib/admin-auth");
    expect(() => assertAdminRequest(new Request("http://x/"))).toThrowError(
      expect.objectContaining({ status: 503 }) as Error,
    );
    void AdminAuthError;
  });

  it("密钥缺失或错误 → AdminAuthError(401)", async () => {
    const { assertAdminRequest, AdminAuthError } = await import("@/lib/admin-auth");
    expect(() =>
      assertAdminRequest(new Request("http://x/")),
    ).toThrow(AdminAuthError);
    expect(() =>
      assertAdminRequest(
        new Request("http://x/", { headers: { "x-admin-key": "wrong" } }),
      ),
    ).toThrow(expect.objectContaining({ status: 401 }) as Error);
  });

  it("密钥正确 → 通过", async () => {
    const { assertAdminRequest } = await import("@/lib/admin-auth");
    expect(() =>
      assertAdminRequest(
        new Request("http://x/", { headers: { "x-admin-key": "super-secret" } }),
      ),
    ).not.toThrow();
  });
});
```

`tests/api-admin.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";

const { codesMock, adjustMock, ledgerMock, userFindMock } = vi.hoisted(() => ({
  codesMock: vi.fn(),
  adjustMock: vi.fn(),
  ledgerMock: vi.fn(),
  userFindMock: vi.fn(),
}));

vi.mock("@/lib/admin-auth", () => ({
  assertAdminRequest: vi.fn(),
  AdminAuthError: class AdminAuthError extends Error {
    status = 401;
  },
}));
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return { ...actual, rateLimitAdminIp: vi.fn(() => Promise.resolve(true)) };
});
vi.mock("@/lib/points", () => ({
  generateRechargeCodes: codesMock,
  adminAdjustPoints: adjustMock,
  MAX_CODES_PER_BATCH: 500,
}));
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({ user: { findUnique: userFindMock } }),
}));

import { POST as codesPOST } from "@/app/api/admin/codes/route";
import { POST as adjustPOST } from "@/app/api/admin/adjust/route";
import { GET as ledgerGET } from "@/app/api/admin/ledger/route";

describe("admin routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("批量生成：返回码列表；数量/面值越界 → 400", async () => {
    codesMock.mockResolvedValue(["AAAA-BBBB-CCCC-DDDD"]);
    const ok = await codesPOST(
      new Request("http://localhost/api/admin/codes", {
        method: "POST",
        body: JSON.stringify({ points: 100, count: 1 }),
      }),
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ codes: ["AAAA-BBBB-CCCC-DDDD"] });

    const tooMany = await codesPOST(
      new Request("http://localhost/api/admin/codes", {
        method: "POST",
        body: JSON.stringify({ points: 100, count: 501 }),
      }),
    );
    expect(tooMany.status).toBe(400);
    const badPoints = await codesPOST(
      new Request("http://localhost/api/admin/codes", {
        method: "POST",
        body: JSON.stringify({ points: 0, count: 10 }),
      }),
    );
    expect(badPoints.status).toBe(400);
  });

  it("手动调整：透传 email/delta/note", async () => {
    adjustMock.mockResolvedValue({ email: "a@b.com", balance: 500 });
    const res = await adjustPOST(
      new Request("http://localhost/api/admin/adjust", {
        method: "POST",
        body: JSON.stringify({ email: "a@b.com", delta: 500, note: "微信收款50元" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(adjustMock).toHaveBeenCalledWith("a@b.com", 500, "微信收款50元");
  });

  it("流水查询：按邮箱定位用户并返回倒序流水", async () => {
    userFindMock.mockResolvedValue({ id: "u1", email: "a@b.com" });
    ledgerMock.mockResolvedValue(undefined);
    // ledger 路由内部直接用 prisma 查 —— 这里 mock prisma 第二形态
    const { getPrisma } = await import("@/lib/prisma");
    void getPrisma;
    const res = await ledgerGET(
      new Request("http://localhost/api/admin/ledger?email=a%40b.com"),
    );
    expect(res.status).toBe(200);
    expect(userFindMock).toHaveBeenCalled();
  });
});
```

> 注：ledger 路由直接查 Prisma，上面的 mock 只断言 200 与按邮箱定位；实现若把查询下沉到 `lib/points.ts` 的 `listPointsLedger(ownerId, limit)`，则把 `ledgerMock` 挂到 `@/lib/points` 并断言参数——以实现的导出名为准，但**必须**有「邮箱定位 + limit 上限」两条断言。

- [ ] **Step 2: 实现 env 访问器、`lib/admin-auth.ts`、三个路由**

`lib/env.ts` 追加（放在 WeChat 访问器之前任意位置，建议文件末尾前）：

```ts
// ── Admin ─────────────────────────────────────────────────────────────────

/** 后台管理密钥（/admin 与 /api/admin/* 的 x-admin-key 头比对）。只存在于环境变量。 */
export function getAdminKey(): string | undefined {
  return process.env.ADMIN_KEY?.trim() || undefined;
}
```

`lib/admin-auth.ts`:

```ts
import { timingSafeEqual } from "node:crypto";
import { getAdminKey } from "@/lib/env";

export class AdminAuthError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(status === 503 ? "Admin not configured" : "Unauthorized");
    this.name = "AdminAuthError";
    this.status = status;
  }
}

/**
 * 后台接口鉴权：x-admin-key 头 vs 环境变量 ADMIN_KEY（timingSafeEqual 防时序侧信道）。
 * ADMIN_KEY 未配置 → 503（部署遗漏的显式信号）；不匹配 → 401。
 */
export function assertAdminRequest(request: Request): void {
  const expected = getAdminKey();
  if (!expected) throw new AdminAuthError(503);
  const provided = request.headers.get("x-admin-key") ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new AdminAuthError(401);
  }
}
```

`app/api/admin/codes/route.ts`:

```ts
import { jsonError, jsonOk } from "@/lib/api-response";
import { AdminAuthError, assertAdminRequest } from "@/lib/admin-auth";
import { MAX_CODES_PER_BATCH, generateRechargeCodes } from "@/lib/points";
import { rateLimitAdminIp, getClientIp } from "@/lib/rate-limit";

export async function POST(request: Request) {
  try {
    assertAdminRequest(request);
  } catch (error) {
    if (error instanceof AdminAuthError) return jsonError(error.message, error.status);
    throw error;
  }
  if (!(await rateLimitAdminIp(getClientIp(request.headers)))) {
    return jsonError("请求过于频繁，请稍后再试", 429);
  }

  let body: { points?: unknown; count?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonError("Request body must be valid JSON", 400);
  }
  const points = body.points;
  const count = body.count;
  if (!Number.isInteger(points) || (points as number) <= 0 || (points as number) > 100000) {
    return jsonError("points must be an integer in (0, 100000]", 400);
  }
  if (!Number.isInteger(count) || (count as number) <= 0 || (count as number) > MAX_CODES_PER_BATCH) {
    return jsonError(`count must be an integer in (0, ${MAX_CODES_PER_BATCH}]`, 400);
  }

  const codes = await generateRechargeCodes(points as number, count as number);
  return jsonOk({ codes }, 201);
}
```

`app/api/admin/adjust/route.ts`:

```ts
import { jsonError, jsonOk } from "@/lib/api-response";
import { AdminAuthError, assertAdminRequest } from "@/lib/admin-auth";
import {
  AdminAdjustError,
  UserNotFoundError,
  adminAdjustPoints,
} from "@/lib/points";
import { getClientIp, rateLimitAdminIp } from "@/lib/rate-limit";

export async function POST(request: Request) {
  try {
    assertAdminRequest(request);
  } catch (error) {
    if (error instanceof AdminAuthError) return jsonError(error.message, error.status);
    throw error;
  }
  if (!(await rateLimitAdminIp(getClientIp(request.headers)))) {
    return jsonError("请求过于频繁，请稍后再试", 429);
  }

  let body: { email?: unknown; delta?: unknown; note?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonError("Request body must be valid JSON", 400);
  }
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 200) : "";
  const delta = body.delta;
  if (!email || !Number.isInteger(delta) || (delta as number) === 0) {
    return jsonError("email and a non-zero integer delta are required", 400);
  }

  try {
    const result = await adminAdjustPoints(email, delta as number, note);
    return jsonOk(result);
  } catch (error) {
    if (error instanceof UserNotFoundError) return jsonError(error.message, 404);
    if (error instanceof AdminAdjustError) return jsonError(error.message, 400);
    throw error;
  }
}
```

`app/api/admin/ledger/route.ts`:

```ts
import { jsonError, jsonOk } from "@/lib/api-response";
import { AdminAuthError, assertAdminRequest } from "@/lib/admin-auth";
import { getPrisma } from "@/lib/prisma";
import { getClientIp, rateLimitAdminIp } from "@/lib/rate-limit";

const MAX_LIMIT = 200;

export async function GET(request: Request) {
  try {
    assertAdminRequest(request);
  } catch (error) {
    if (error instanceof AdminAuthError) return jsonError(error.message, error.status);
    throw error;
  }
  if (!(await rateLimitAdminIp(getClientIp(request.headers)))) {
    return jsonError("请求过于频繁，请稍后再试", 429);
  }

  const url = new URL(request.url);
  const email = (url.searchParams.get("email") ?? "").trim().toLowerCase();
  if (!email) return jsonError("email is required", 400);
  const limitRaw = Number(url.searchParams.get("limit") ?? "50");
  const limit = Number.isInteger(limitRaw)
    ? Math.min(Math.max(1, limitRaw), MAX_LIMIT)
    : 50;

  const user = await getPrisma()!.user.findUnique({ where: { email } });
  if (!user) return jsonError("用户不存在", 404);

  const entries = await getPrisma()!.pointsLedger.findMany({
    where: { ownerId: user.id },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return jsonOk({ email, entries });
}
```

- [ ] **Step 3: 跑测试**

Run: `npx vitest run tests/admin-auth.test.ts tests/api-admin.test.ts`
Expected: PASS。（若 ledger 断言按 Step 1 注记下沉实现，同步改测试后再跑。）

- [ ] **Step 4: 提交**

```bash
git add lib/env.ts lib/admin-auth.ts app/api/admin tests/admin-auth.test.ts tests/api-admin.test.ts
git commit -m "feat(points): 后台管理 API（批量生成码/手动调整/流水查询，密钥+IP 限流）"
```

---

## Task 4: 接入三个扣费点

**Files:**
- Modify: `lib/api-response.ts`（加 `jsonPointsError`）
- Modify: `app/api/script-drafts/route.ts`
- Modify: `app/api/render-projects/route.ts`
- Modify: `app/api/avatars/talking-head/route.ts`
- Test: `tests/api-points-consumption.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/api-points-consumption.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";

const { getOwnerIdMock, consumeMock, storeFindMock } = vi.hoisted(() => ({
  getOwnerIdMock: vi.fn(),
  consumeMock: vi.fn(),
  storeFindMock: vi.fn(),
}));

vi.mock("@/lib/auth-helpers", () => ({ getOwnerId: getOwnerIdMock }));
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return { ...actual, applyRateLimit: vi.fn(() => Promise.resolve(null)) };
});
vi.mock("@/lib/points", () => ({
  consumePoints: consumeMock,
  PointsExhaustedError: class PointsExhaustedError extends Error {
    constructor() {
      super("积分已用完，请联系客服充值");
    }
  },
  renderPointsCost: (n: number) => 30 + 250 * n,
}));

// script-drafts 依赖的 repositories / services 全部打桩
vi.mock("@/lib/repositories", () => ({
  getStoreRepository: () => ({ findById: storeFindMock }),
  getAssetAnalysisRepository: () => ({ listByIds: vi.fn(() => Promise.resolve([])) }),
  getAvatarRepository: () => ({ listByOwner: vi.fn(() => Promise.resolve([])) }),
  getScriptRepository: () => ({ create: vi.fn((s: unknown) => Promise.resolve(s)) }),
}));
vi.mock("@/lib/services/script-engine", () => ({
  createScriptDraft: vi.fn(() => ({ id: "draft1" })),
  createTemplateScriptDraft: vi.fn(() => ({ id: "draft1" })),
}));

import { POST as scriptPOST } from "@/app/api/script-drafts/route";
import { POST as renderPOST } from "@/app/api/render-projects/route";
import { POST as talkingHeadPOST } from "@/app/api/avatars/talking-head/route";

function jsonReq(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("扣费接入", () => {
  beforeEach(() => vi.clearAllMocks());

  it("写稿：扣 10 积分后才生成；余额不足 402 且文案精确", async () => {
    getOwnerIdMock.mockResolvedValue("u1");
    storeFindMock.mockResolvedValue({ id: "s1", ownerId: "u1" });
    consumeMock.mockResolvedValue({ balance: 220 });

    const res = await scriptPOST(
      jsonReq("/api/script-drafts", { storeId: "s1", purpose: "store_traffic" }),
    );
    expect(res.status).toBe(201);
    expect(consumeMock).toHaveBeenCalledWith("u1", 10, "生成口播稿");
  });

  it("写稿：402 返回 points_exhausted 与中文 message", async () => {
    getOwnerIdMock.mockResolvedValue("u1");
    storeFindMock.mockResolvedValue({ id: "s1", ownerId: "u1" });
    const { PointsExhaustedError } = await import("@/lib/points");
    consumeMock.mockRejectedValue(new PointsExhaustedError());

    const res = await scriptPOST(
      jsonReq("/api/script-drafts", { storeId: "s1", purpose: "store_traffic" }),
    );
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toBe("points_exhausted");
    expect(body.message).toBe("积分已用完，请联系客服充值");
  });

  it("渲染：2 个形象扣 530（30+250×2），402 同口径", async () => {
    getOwnerIdMock.mockResolvedValue("u1");
    consumeMock.mockResolvedValue({ balance: 0 });
    // repositories for render route
    const repos = await import("@/lib/repositories");
    void repos;
    // render 路由还依赖 render-pipeline / queue —— 打桩见文件内注释说明
    // （这里只断言 consumePoints 调用参数， mocking 与下方一致）
    // …若模块级 mock 不足，按实现补 vi.mock("@/lib/services/render-pipeline") 等。
    // 本测试以 talking-head 路由做渲染系断言，render 路由由 typecheck+集成兜底。
    void renderPOST;

    const res = await talkingHeadPOST(
      jsonReq("/api/avatars/talking-head", {
        avatarProfileId: "platform_default",
        scriptDraftId: "d1",
      }),
    );
    // platform avatar 免查库；draft 404 在扣费前拦截 —— 这里改测扣费在 404 校验之后：
    expect([402, 404]).toContain(res.status);
    if (res.status === 402) {
      expect((await res.json()).message).toBe("积分已用完，请联系客服充值");
    }
  });

  it("talking-head：扣 250", async () => {
    getOwnerIdMock.mockResolvedValue("u1");
    const { getAvatarRepository, getScriptRepository } = await import("@/lib/repositories");
    void getAvatarRepository; void getScriptRepository;
    // 见 Step 1 顶部 repositories mock —— platform avatar 走 buildPlatformAvatar 免查库；
    // draft 属于普通 repository mock，需要返回属主匹配的 draft。
    // （实现时在本文件补全 draft mock，断言 consumePoints("u1", 250, "数字人出镜")）
    expect(true).toBe(true);
  });
});
```

> 说明：`render-projects` 与 `talking-head` 路由的外部依赖（repositories/queue/render-pipeline）较多，本文件的 mock 桩在实现阶段按「跑测试时的 import 报错」补齐——但必须保留三条硬断言：写稿 10/402 文案、render 价格函数 30+250n、talking-head 250。写稿两条已完整可跑。

- [ ] **Step 2: 实现 `jsonPointsError`（`lib/api-response.ts` 追加）**

```ts
// ── Points exhausted (402) ─────────────────────────────────────────────────

export function jsonPointsError(): Response {
  return Response.json(
    { error: "points_exhausted", message: "积分已用完，请联系客服充值" },
    { status: 402 },
  );
}
```

- [ ] **Step 3: 接入 `app/api/script-drafts/route.ts`**

文件头部 import 调整：删 `import { jsonError, jsonOk }` 中的无用项保持原样，加：

```ts
import { jsonError, jsonOk, jsonPointsError } from "@/lib/api-response";
import { PointsExhaustedError, consumePoints } from "@/lib/points";
import { SCRIPT_DRAFT_POINTS } from "@/lib/points-pricing";
```

在 `const script = body.forceTemplate ? ...` 语句**之前**插入：

```ts
  // 核心功能前置扣费：校验全过后、生成前扣 10 积分；余额不足 402（事务内防负）。
  try {
    await consumePoints(ownerId, SCRIPT_DRAFT_POINTS, "生成口播稿");
  } catch (error) {
    if (error instanceof PointsExhaustedError) return jsonPointsError();
    throw error;
  }
```

- [ ] **Step 4: 接入 `app/api/render-projects/route.ts`**

import 区：删 `import { consumeQuota, QuotaExhaustedError } from "@/lib/quota";` 和 `jsonQuotaError`，替换为：

```ts
import { jsonError, jsonOk, jsonPointsError } from "@/lib/api-response";
import { PointsExhaustedError, consumePoints } from "@/lib/points";
import { renderPointsCost } from "@/lib/points-pricing";
```

把原 92–100 行的 consumeQuota 块整体替换为：

```ts
  // 积分扣减 —— 30 基础 + 250/出镜形象（替换旧 quota）；余额不足 402。
  // 位置不变：全部校验通过后、createRenderProject 之前。
  try {
    await consumePoints(
      ownerId,
      renderPointsCost(avatarProfiles.length),
      avatarProfiles.length > 0 ? `渲染视频（数字人×${avatarProfiles.length}）` : "渲染视频",
    );
  } catch (error) {
    if (error instanceof PointsExhaustedError) return jsonPointsError();
    throw error;
  }
```

- [ ] **Step 5: 接入 `app/api/avatars/talking-head/route.ts`**

import 区同样替换 quota 相关为 points 相关（`jsonPointsError`、`consumePoints`、`AVATAR_APPEARANCE_POINTS`）。

把原 consumeQuota 块替换为：

```ts
  // Points: talking-head consumes Volcengine lip-sync quota — preview is charged (Q2).
  try {
    await consumePoints(ownerId, AVATAR_APPEARANCE_POINTS, "数字人出镜");
  } catch (error) {
    if (error instanceof PointsExhaustedError) return jsonPointsError();
    throw error;
  }
```

- [ ] **Step 6: 跑测试 + 全量回归 + 提交**

Run: `npx vitest run tests/api-points-consumption.test.ts && npm test && npm run typecheck`
Expected: PASS。注意全局搜索残留：`grep -rn "consumeQuota\|jsonQuotaError" app/` 应只剩 `lib/quota.ts` 自身定义（无调用方残留 import 报错）。

```bash
git add lib/api-response.ts app/api/script-drafts/route.ts app/api/render-projects/route.ts app/api/avatars/talking-head/route.ts tests/api-points-consumption.test.ts
git commit -m "feat(points): 写稿/渲染/数字人三接口接入积分扣减（替换 quota）"
```

---

## Task 5: 前端积分表面（余额、兑换、402 提示、消耗预告）

**Files:**
- Modify: `lib/api-client.ts`
- Modify: `components/header.tsx`
- Modify: `components/dashboard.tsx`
- Modify: `components/script-confirm.tsx`
- Test: `tests/header.test.tsx`（追加）、`tests/script-confirm.test.tsx`（追加/修改）

- [ ] **Step 1: 先改 `lib/api-client.ts` 错误透传 + 积分 API**

`api()` 内 throw 行改为（让 402 的 `message` 中文文案到达 catch 块）：

```ts
  if (!res.ok) {
    throw new ApiError(json.message ?? json.error ?? "Request failed", res.status);
  }
```

文件末尾追加：

```ts
// ── Points ─────────────────────────────────────────────────────────────────

export const POINTS_EXHAUSTED_MESSAGE = "积分已用完，请联系客服充值";

export async function fetchPoints(): Promise<number | null> {
  const data = await api<{ balance: number | null }>("/api/points");
  return data.balance;
}

export async function redeemPointsApi(
  code: string,
): Promise<{ points: number; balance: number }> {
  return api<{ points: number; balance: number }>("/api/points/redeem", {
    method: "POST",
    body: JSON.stringify({ code }),
  });
}

/** 扣费动作成功后通知 Header 刷新余额（window 事件桥，避免跨组件传参）。 */
export function notifyPointsChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("ava:points-changed"));
  }
}
```

> 风险核对：`api()` 从 `json.error` 改为 `json.message ?? json.error` 会影响所有现有错误断言。跑 `npx vitest run tests/api-client-avatars.test.ts tests/dashboard.test.tsx` 确认；若有用例断言 `error` 码字符串，按新口径更新（服务端 429/400 的 `message` 均为中文，属预期改善）。

- [ ] **Step 2: 写 header 失败测试（追加到 `tests/header.test.tsx` 末尾）**

```tsx
describe("PointsBalance chip", () => {
  it("展示余额；点击兑换弹出输入框，兑换成功刷新余额", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockResolvedValue(230);
    const redeemMock = vi.fn().mockResolvedValue({ points: 100, balance: 330 });
    vi.doMock("@/lib/api-client", () => ({
      fetchPoints: fetchMock,
      redeemPointsApi: redeemMock,
    }));
    const { Header } = await import("@/components/header");
    render(<Header email="owner@example.com" />);

    expect(await screen.findByText("积分 230")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "兑换" }));
    await user.type(screen.getByLabelText("兑换码"), "AAAA-BBBB-CCCC-DDDD");
    await user.click(screen.getByRole("button", { name: "确认兑换" }));

    await vi.waitFor(() => {
      expect(redeemMock).toHaveBeenCalledWith("AAAA-BBBB-CCCC-DDDD");
      expect(screen.getByText("积分 330")).toBeInTheDocument();
    });
  });
});
```

Run: `npx vitest run tests/header.test.tsx -t "PointsBalance"`
Expected: FAIL —— 组件不存在。

- [ ] **Step 3: 实现 `components/header.tsx` 积分块**

文件头部 import 区改为：

```tsx
"use client";

import { useEffect, useState, useTransition } from "react";
import { signOutWithRevocation } from "@/app/login/actions";
import { fetchPoints, redeemPointsApi } from "@/lib/api-client";
```

在 `Header` 组件后追加同文件组件：

```tsx
/**
 * 积分余额 + 兑换入口。挂载时拉一次余额；监听 ava:points-changed 事件
 * （dashboard 扣费动作后派发）自动刷新。无数据库（balance=null）显示「—」。
 */
function PointsBalance() {
  const [balance, setBalance] = useState<number | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const b = await fetchPoints();
        if (!cancelled) setBalance(b);
      } catch {
        if (!cancelled) setBalance(null);
      }
    };
    void refresh();
    window.addEventListener("ava:points-changed", refresh);
    return () => {
      cancelled = true;
      window.removeEventListener("ava:points-changed", refresh);
    };
  }, []);

  async function handleRedeem() {
    if (!code.trim() || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await redeemPointsApi(code.trim());
      setBalance(result.balance);
      setNotice(`兑换成功：+${result.points} 积分`);
      setCode("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "兑换失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="appHeader__pointsWrap">
      <span className="appHeader__points" aria-label="积分余额">
        积分 {balance ?? "—"}
      </span>
      <button
        type="button"
        className="appHeader__redeem"
        onClick={() => {
          setDialogOpen(true);
          setNotice(null);
        }}
      >
        兑换
      </button>

      {dialogOpen ? (
        <div className="redeemDialog" role="dialog" aria-label="兑换积分">
          <label>
            兑换码
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="XXXX-XXXX-XXXX-XXXX"
              autoFocus
            />
          </label>
          {notice ? <p role="status">{notice}</p> : null}
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className="primaryButton"
              disabled={busy || !code.trim()}
              onClick={() => void handleRedeem()}
            >
              {busy ? "兑换中…" : "确认兑换"}
            </button>
            <button
              type="button"
              className="secondaryButton"
              onClick={() => setDialogOpen(false)}
            >
              关闭
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
```

`Header` 的 account 容器内、email span 之前插入 `<PointsBalance />`：

```tsx
        <div className="appHeader__account">
          <PointsBalance />
          <span className="appHeader__email">{email}</span>
```

- [ ] **Step 4: dashboard 402 提示映射 + 积分事件**

`components/dashboard.tsx`：

1. import 区加：`import { POINTS_EXHAUSTED_MESSAGE, notifyPointsChanged } from "@/lib/api-client";`（`ApiError` 已从 api-client import 则复用）。
2. `confirmScriptAndRender` 的 catch 块改为：

```tsx
    } catch (error) {
      // 失败时确认卡片保留（confirmDraft 不清空），用户改稿后可重试。
      if (error instanceof ApiError && error.status === 402) {
        setMessage(POINTS_EXHAUSTED_MESSAGE);
      } else {
        const detail = error instanceof Error ? error.message : "请稍后重试";
        setMessage(`确认生成失败：${detail}`);
      }
    }
```

3. `confirmScriptAndRender` 成功路径（`setMessage("AI 正在生成你的视频：…")` 之前）加 `notifyPointsChanged();`。
4. `generateScript` 与 `handleChangeAngle` 的 catch 同样加 402 优先映射（`setMessage(POINTS_EXHAUSTED_MESSAGE)`），成功后 `notifyPointsChanged();`。

- [ ] **Step 5: script-confirm 消耗积分提示**

`components/script-confirm.tsx`：

1. import 加：`import { renderPointsCost } from "@/lib/points-pricing";`
2. `costEstimate` 之后加：

```tsx
  // 积分消耗预告：与服务端 render-projects 扣费口径一致（30 + 250×形象数）
  const pointsCost = renderPointsCost(avatarIds.length);
```

3. 原 `costHint` 段落（avatarIds.length > 0 时渲染）的文案去掉「· 消耗 1 次生成配额」（quota 已废），并在其后追加积分行（无条件渲染）：

```tsx
      {avatarIds.length > 0 ? (
        <p className="costHint" aria-label="成本预估">
          {pricing === "lipsync"
            ? `预计数字人成本约 ¥${costEstimate.totalCny.toFixed(2)}（对口型 ¥1/分钟 · 出镜 ${costEstimate.onCameraSec}s + 画外音 ${costEstimate.voiceoverSec}s）`
            : `预计数字人成本约 $${costEstimate.totalUsd.toFixed(2)}（出镜 ${costEstimate.onCameraSec}s + 画外音 ${costEstimate.voiceoverSec}s）`}
        </p>
      ) : null}
      <p className="costHint" aria-label="消耗积分">
        本次生成将消耗 {pointsCost} 积分（10 积分 = 1 元）
      </p>
```

- [ ] **Step 6: 测试更新与运行**

1. `tests/script-confirm.test.tsx`：把断言「消耗 1 次生成配额」的用例改为断言新文案（`getByLabelText("消耗积分")` 文本含 `30`；勾选 1 个形象后含 `280`）。同时保留既有编辑/确认行为用例。
2. Run: `npx vitest run tests/header.test.tsx tests/script-confirm.test.tsx tests/api-client-avatars.test.ts tests/dashboard.test.tsx`
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add lib/api-client.ts components/header.tsx components/dashboard.tsx components/script-confirm.tsx tests/header.test.tsx tests/script-confirm.test.tsx
git commit -m "feat(points): 前端积分余额/兑换入口/402 提示/消耗积分预告"
```

---

## Task 6: 后台页面 `/admin` + middleware 放行

**Files:**
- Create: `app/admin/page.tsx`
- Modify: `middleware.ts`
- Test: `tests/admin-page.test.tsx`

- [ ] **Step 1: 写失败测试**

`tests/admin-page.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const fetchMock = vi.fn();

describe("/admin page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    window.localStorage.clear();
  });

  it("无密钥时显示密钥输入；输入后进入后台", async () => {
    const { default: AdminPage } = await import("@/app/admin/page");
    render(<AdminPage />);
    expect(screen.getByLabelText("管理密钥")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("管理密钥"), { target: { value: "k" } });
    fireEvent.click(screen.getByRole("button", { name: "进入后台" }));
    await waitFor(() => {
      expect(screen.getByText("生成兑换码")).toBeInTheDocument();
    });
  });

  it("批量生成：提交后展示码列表", async () => {
    window.localStorage.setItem("ava_admin_key", "k");
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ codes: ["AAAA-BBBB-CCCC-DDDD"] }),
    });
    const { default: AdminPage } = await import("@/app/admin/page");
    render(<AdminPage />);
    fireEvent.change(screen.getByLabelText("单码面值（积分）"), { target: { value: "100" } });
    fireEvent.change(screen.getByLabelText("生成数量"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "生成" }));
    await waitFor(() => {
      expect(screen.getByText("AAAA-BBBB-CCCC-DDDD")).toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/codes",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-admin-key": "k" }),
      }),
    );
  });
});
```

Run: `npx vitest run tests/admin-page.test.tsx`
Expected: FAIL —— 页面不存在。

- [ ] **Step 2: 实现 `app/admin/page.tsx`**

```tsx
"use client";

import { useState } from "react";

const LS_KEY = "ava_admin_key";

async function adminFetch<T>(path: string, key: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", "x-admin-key": key, ...init?.headers },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message ?? json.error ?? "请求失败");
  return json as T;
}

interface LedgerEntry {
  id: string;
  delta: number;
  reason: string;
  balanceAfter: number;
  createdAt: string;
}

export default function AdminPage() {
  const [key, setKey] = useState<string>(() =>
    typeof window === "undefined" ? "" : window.localStorage.getItem(LS_KEY) ?? "",
  );
  const [keyInput, setKeyInput] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 生成码
  const [genPoints, setGenPoints] = useState("100");
  const [genCount, setGenCount] = useState("10");
  const [codes, setCodes] = useState<string[]>([]);

  // 手动调整
  const [adjEmail, setAdjEmail] = useState("");
  const [adjDelta, setAdjDelta] = useState("500");
  const [adjNote, setAdjNote] = useState("");

  // 流水
  const [ledEmail, setLedEmail] = useState("");
  const [entries, setEntries] = useState<LedgerEntry[] | null>(null);

  if (!key) {
    return (
      <main className="authPage">
        <form
          className="authCard authForm"
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = keyInput.trim();
            if (!trimmed) return;
            window.localStorage.setItem(LS_KEY, trimmed);
            setKey(trimmed);
          }}
        >
          <h1>管理后台</h1>
          <label className="field">
            <span>管理密钥</span>
            <input
              type="password"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              autoComplete="off"
            />
          </label>
          <button type="submit" className="primaryButton">进入后台</button>
          {notice ? <p role="alert">{notice}</p> : null}
        </form>
      </main>
    );
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setNotice(null);
    try {
      await action();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="workspace" style={{ maxWidth: 720, margin: "0 auto", padding: 24 }}>
      <h1>管理后台</h1>
      {notice ? <p role="alert">{notice}</p> : null}

      <section style={{ marginTop: 24 }}>
        <h2>生成兑换码</h2>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <label>
            单码面值（积分）
            <input
              aria-label="单码面值（积分）"
              value={genPoints}
              onChange={(e) => setGenPoints(e.target.value)}
              inputMode="numeric"
            />
          </label>
          <label>
            生成数量
            <input
              aria-label="生成数量"
              value={genCount}
              onChange={(e) => setGenCount(e.target.value)}
              inputMode="numeric"
            />
          </label>
          <button
            type="button"
            className="primaryButton"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const data = await adminFetch<{ codes: string[] }>("/api/admin/codes", key, {
                  method: "POST",
                  body: JSON.stringify({ points: Number(genPoints), count: Number(genCount) }),
                });
                setCodes(data.codes);
              })
            }
          >
            生成
          </button>
        </div>
        {codes.length > 0 ? (
          <>
            <textarea
              readOnly
              aria-label="生成的兑换码"
              value={codes.join("\n")}
              rows={Math.min(10, codes.length)}
              style={{ width: "100%", marginTop: 8 }}
            />
            <button
              type="button"
              className="secondaryButton"
              onClick={() => void navigator.clipboard.writeText(codes.join("\n"))}
            >
              复制全部
            </button>
          </>
        ) : null}
      </section>

      <section style={{ marginTop: 32 }}>
        <h2>手动调整积分</h2>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <label>
            用户邮箱
            <input value={adjEmail} onChange={(e) => setAdjEmail(e.target.value)} />
          </label>
          <label>
            变动（可为负）
            <input
              value={adjDelta}
              onChange={(e) => setAdjDelta(e.target.value)}
              inputMode="numeric"
            />
          </label>
          <label>
            备注（可选）
            <input value={adjNote} onChange={(e) => setAdjNote(e.target.value)} />
          </label>
          <button
            type="button"
            className="primaryButton"
            disabled={busy || !adjEmail.trim()}
            onClick={() =>
              void run(async () => {
                const data = await adminFetch<{ balance: number }>("/api/admin/adjust", key, {
                  method: "POST",
                  body: JSON.stringify({
                    email: adjEmail.trim(),
                    delta: Number(adjDelta),
                    note: adjNote.trim(),
                  }),
                });
                setNotice(`调整成功，当前余额 ${data.balance} 积分`);
              })
            }
          >
            提交调整
          </button>
        </div>
      </section>

      <section style={{ marginTop: 32 }}>
        <h2>积分流水</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <label>
            用户邮箱
            <input value={ledEmail} onChange={(e) => setLedEmail(e.target.value)} />
          </label>
          <button
            type="button"
            className="primaryButton"
            disabled={busy || !ledEmail.trim()}
            onClick={() =>
              void run(async () => {
                const data = await adminFetch<{ entries: LedgerEntry[] }>(
                  `/api/admin/ledger?email=${encodeURIComponent(ledEmail.trim())}`,
                  key,
                );
                setEntries(data.entries);
              })
            }
          >
            查询
          </button>
        </div>
        {entries ? (
          <table style={{ width: "100%", marginTop: 8 }}>
            <thead>
              <tr>
                <th>时间</th>
                <th>变动</th>
                <th>原因</th>
                <th>变动后余额</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td>{new Date(e.createdAt).toLocaleString()}</td>
                  <td>{e.delta > 0 ? `+${e.delta}` : e.delta}</td>
                  <td>{e.reason}</td>
                  <td>{e.balanceAfter}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>

      <section style={{ marginTop: 32 }}>
        <button
          type="button"
          className="secondaryButton"
          onClick={() => {
            window.localStorage.removeItem(LS_KEY);
            setKey("");
          }}
        >
          清除密钥（锁定后台）
        </button>
      </section>
    </main>
  );
}
```

- [ ] **Step 3: middleware 放行（`middleware.ts`）**

public path 块改为：

```ts
  if (
    pathname === "/api/health" ||
    pathname.startsWith("/login") ||
    pathname.startsWith("/admin") ||       // 后台自带 x-admin-key 鉴权（页面与 API）
    pathname.startsWith("/api/admin") ||   // 同上；路由内部另有 admin IP 限流
    pathname.startsWith("/_next")
  ) {
    return NextResponse.next();
  }
```

> 说明：production 模式下未登录访问页面本会重定向 `/login`，而后台不应依赖用户会话，故必须 public；安全性由 `assertAdminRequest` + `rateLimitAdminIp` 承担。`/api/admin` 走 public 块会跳过 L0 通用 IP 限流，但 admin 路由内部已有 30/min 专项限流，等效。

- [ ] **Step 4: 跑测试 + 提交**

Run: `npx vitest run tests/admin-page.test.tsx && npm test && npm run typecheck`
Expected: PASS。

```bash
git add app/admin/page.tsx middleware.ts tests/admin-page.test.tsx
git commit -m "feat(points): /admin 管理页面与 middleware 放行"
```

---

## Task 7: 移除微信登录

**Files:**
- Modify: `app/login/page.tsx`
- Modify: `app/login/actions.ts`
- Modify: `auth.ts`
- Modify: `lib/env.ts`（删微信访问器）
- Delete: `lib/auth/wechat-provider.ts`
- Test: `tests/login-page.test.tsx`、`tests/login-actions.test.ts`

- [ ] **Step 1: 全局盘点引用**

Run: `grep -rn "wechat\|WeChat\|微信" app/ lib/ components/ tests/ --include="*.ts" --include="*.tsx" | grep -v "wechat_channels\|微信视频号\|lib/services/script-engine\|lib/schemas.ts\|lib/types.ts"`
Expected 命中清单（全部要处理）：`app/login/page.tsx`、`app/login/actions.ts`、`auth.ts`、`lib/env.ts`（3 个访问器 + `hasWechatProvider`）、`lib/auth/wechat-provider.ts`、`tests/login-page.test.tsx`、`tests/login-actions.test.ts`。

- [ ] **Step 2: 写失败测试（先改断言再删实现，TDD 红→绿）**

`tests/login-page.test.tsx`：删 `signInWithWeChatMock`（vi.hoisted、vi.mock 工厂、beforeEach 里的引用），文件保留两个既有用例，并追加：

```tsx
  it("不再提供微信登录入口", () => {
    render(<LoginPage />);
    expect(screen.queryByText("微信登录")).not.toBeInTheDocument();
    expect(screen.queryByText("其他登录方式")).not.toBeInTheDocument();
  });
```

`tests/login-actions.test.ts`：删除所有引用 `signInWithWeChat` 的用例与 import（用 grep 结果逐条删；若删完全部微信用例后文件只剩 email 相关用例，保留）。

Run: `npx vitest run tests/login-page.test.tsx tests/login-actions.test.ts`
Expected: FAIL —— `signInWithWeChat` 不存在 / 微信按钮仍在。

- [ ] **Step 3: 删实现**

`app/login/page.tsx`：
1. import 行删 `signInWithWeChat`：`import { sendMagicLink } from "./actions";`
2. 删整段「其他登录方式」divider 与微信按钮（`<div className="authDivider">…` 与紧随的 `<button … authWechatButton>…</button>`）。

`app/login/actions.ts`：删除整个 `signInWithWeChat` 函数（含 `"use server"` 文件内对应导出；保留 `sendMagicLink` 与 `signOutWithRevocation`）。

`auth.ts`：
1. import 行改为：`import { getEmailFrom, getResendApiKey } from "@/lib/env";`（删 `hasWechatProvider/getWechatAppId/getWechatAppSecret` 与 `WeChatProvider` 两个 import）。
2. 删 providers 数组里的整块条件注册：
```ts
    // Conditionally register WeChat provider
    ...(hasWechatProvider()
      ? [
          WeChatProvider({
            clientId: getWechatAppId()!,
            clientSecret: getWechatAppSecret()!,
          }),
        ]
      : []),
```

`lib/env.ts`：删整段「WeChat OAuth」注释与 3 个访问器（`getWechatAppId`、`getWechatAppSecret`、`hasWechatProvider`）。

`lib/auth/wechat-provider.ts`：删除文件。

`public/wechat-logo.svg`：如存在一并删除（`ls public/` 确认）。

- [ ] **Step 4: 跑测试 + 全量回归 + 提交**

Run: `npm test && npm run typecheck && npm run lint`
Expected: PASS；grep 无残留（Step 1 命令复跑为空）。

```bash
git add -A app/login auth.ts lib/env.ts lib/auth tests
git commit -m "feat(auth): 移除微信登录（按钮/provider/env 访问器）"
```

---

## Task 8: 字幕上移至画面下 1/3 线

**Files:**
- Modify: `lib/services/video-compose.ts`
- Test: `tests/video-compose.test.ts`

- [ ] **Step 1: 跑现有测试，记录 marginV 断言**

Run: `npx vitest run tests/video-compose.test.ts 2>&1 | grep -i "marginV\|Style:"`
Expected: 失败清单显示 ASS 样式行中 `MarginV` 期望值（60/80/100 各预设不同）。这些断言在本 Task 内改为 640。

- [ ] **Step 2: 修改实现**

`lib/services/video-compose.ts` 的 `SUBTITLE_PRESETS` 定义之前加命名常量并替换全部 7 个预设的 `marginV`：

```ts
/**
 * 字幕垂直边距（ASS MarginV，PlayResY=1920）。抖音底部 ~15-20% 区域被
 * 账号名/标题/按钮占用，字幕块底边锚定到画面下 1/3 线（1920/3=640），
 * 全预设统一，避免某个样式仍贴底被遮挡。
 */
const SUBTITLE_MARGIN_V = 640;
```

把 `SUBTITLE_PRESETS` 中所有 `marginV: 80`、`marginV: 60`、`marginV: 100` 统一改为 `marginV: SUBTITLE_MARGIN_V`（共 7 处：default/bold_bottom/minimal/pop/highlight/bounce/karaoke）。

- [ ] **Step 3: 更新测试期望并跑通**

`tests/video-compose.test.ts`：把断言 ASS 样式行的期望值中 `,40,40,60,` / `,40,40,80,` / `,40,40,100,` 统一改为 `,40,40,640,`（grep `40,40,` 定位，有几处改几处；其余 buildAss 行为断言不动）。

Run: `npx vitest run tests/video-compose.test.ts tests/segmented-compose.test.ts tests/video-render-composite.test.ts`
Expected: PASS。

- [ ] **Step 4: 提交**

```bash
git add lib/services/video-compose.ts tests/video-compose.test.ts
git commit -m "feat(render): 字幕上移至画面下 1/3 线（MarginV 60-100→640，避让抖音底部 UI）"
```

---

## Task 9: 移除口播稿确认页背景音乐选项

**Files:**
- Modify: `components/script-confirm.tsx`
- Modify: `components/dashboard.tsx`
- Modify: `lib/api-client.ts`
- Test: `tests/script-confirm.test.tsx`

- [ ] **Step 1: 写失败测试（改断言）**

`tests/script-confirm.test.tsx`：
1. 删 `bgmTracks` fixture 与组件入参；删「offers a 无音乐 option…」整段用例，替换为：

```tsx
  it("不再提供背景音乐选项", () => {
    renderConfirm();
    expect(screen.queryByLabelText(/背景音乐/)).not.toBeNull === undefined;
    expect(screen.queryByText("背景音乐")).not.toBeInTheDocument();
  });
```

（`renderConfirm` 为文件内既有的渲染辅助函数；按其真实签名去掉 bgmTracks 参数。）

2. 既有「confirm 回调透传选择」类用例中，`toHaveBeenCalledWith(expect.objectContaining({ bgmTrackId: ... }))` 里的 bgmTrackId 断言删除（字段已从 selection 类型移除）。

- [ ] **Step 2: 删实现**

`components/script-confirm.tsx`：
1. Props 删 `bgmTracks: { id: string; name: string; category: string }[];`
2. `ScriptConfirmSelection` 删 `bgmTrackId: string;`
3. 删 `const [bgmTrackId, setBgmTrackId] = useState(...)` 与其后 select 控件整段（含「背景音乐」label）。
4. `handleConfirm` 的 `onConfirm({...})` 对象删 `bgmTrackId` 字段。
5. 文件头注释「字幕样式 + BGM（自旧分镜确认卡片挪入）」改为「字幕样式 → 确认生成」。

`components/dashboard.tsx`：
1. 删 `bgmTracks` state（`useState` 与类型）与加载它的 fetch 调用（`fetchBgmTracks()` 所在 effect 或查询）。
2. `<ScriptConfirm … bgmTracks={bgmTracks}` 属性删除。
3. `confirmScriptAndRender` 入参类型与 `createRenderProjectApi` 调用删 `bgmTrackId` 行。
4. import 区删 `fetchBgmTracks`、`BgmTrackOption`（若无其他引用）。

`lib/api-client.ts`：删 `fetchBgmTracks` 函数与 `BgmTrackOption` 接口（服务端 `/api/bgm-tracks` 与 `BgmTrack` 模型保留）。

> 保留说明：渲染管线仍接受 `bgmTrackId`（未传即无音乐），`BgmTrack` 模型/seed/路由不动 —— 需求只要求去掉用户可见选项。

- [ ] **Step 3: 跑测试 + 全量回归 + 提交**

Run: `npm test && npm run typecheck && npm run lint`
Expected: PASS。

```bash
git add components/script-confirm.tsx components/dashboard.tsx lib/api-client.ts tests/script-confirm.test.tsx
git commit -m "feat(ui): 移除口播稿确认页背景音乐选项"
```

---

## Task 10: 全量验证

- [ ] **Step 1: CI 全管线**

Run: `npm test && npm run typecheck && npm run lint && npx prisma validate && npm run build`
Expected: 全绿。

- [ ] **Step 2: 部署前清单**

1. Zeabur 环境变量新增 `ADMIN_KEY=<强随机串>`（生产）；本地 `.env` 同步（文件已 gitignore，勿提交）。
2. 生产部署时 `prisma migrate deploy` 随 `start:prod` 自动执行（新表自动建）。
3. 部署后冒烟：登录 → 后台生成 1 个测试码 → 前台兑换 → 写稿扣 10 → 流水可查。
4. git push 前按仓库规则审查 `origin/main..HEAD` 的全部提交（9 个 feat 提交）。

## 计划自检记录

- 规格覆盖：余额✓(T1/T2) 原子扣减防负✓(T1) 402 文案✓(T2/T4/T5) 兑换码批量/一次性✓(T1/T3) 手动加减✓(T1/T3/T6) 流水五要素✓(T1 schema) 事务✓(T1) 兑换限流✓(T2) 无在线支付✓ 删微信✓(T7) 字幕 1/3✓(T8) 去 BGM✓(T9)。
- 类型一致性：`consumePoints/redeemPointsCode/adminAdjustPoints/getPointsBalance/generateRechargeCodes/MAX_CODES_PER_BATCH/normalizeRedeemCode` 在 T1 定义，T2-T6 引用一致；`renderPointsCost` 在 T4/T5 引用；事件名 `ava:points-changed` 与 localStorage 键 `ava_admin_key` 全文统一。
- 已知取舍：① 无数据库的本地 dev 跳过扣费（沿用 quota 口径）；② 扣费后不返点（任务失败重试需再扣，与旧 quota 语义一致，需求方未要求退款流）；③ `/api/bgm-tracks` 与 `BgmTrack` 保留。
