import { randomInt } from "node:crypto";
import { Prisma, type PointsLedger } from "@prisma/client";
import { hasDatabase, getAppMode } from "@/lib/env";
import { createId } from "@/lib/ids";
import { getPrisma } from "@/lib/prisma";
import { demoOwnerId } from "@/lib/runtime-store";

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

export class PointsUnavailableError extends Error {
  constructor() {
    super("积分功能未启用");
    this.name = "PointsUnavailableError";
  }
}

/** 查询积分余额；无数据库（本地 dev）或 demo 用户返回 null，前端显示「—」。 */
export async function getPointsBalance(userId: string): Promise<number | null> {
  if (!hasDatabase()) return null;
  // 演示用户豁免 —— 与 lib/quota.ts 同口径：demo/dev 不拦功能、不写流水
  if (userId === demoOwnerId && getAppMode() === "demo") return null;
  const user = await getPrisma()!.user.findUnique({ where: { id: userId } });
  return user?.pointsBalance ?? null;
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
  // 演示用户豁免 —— 与 lib/quota.ts 同口径：demo/dev 不拦功能、不写流水
  if (userId === demoOwnerId && getAppMode() === "demo") return { balance: 0 };
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
    // updateMany 守卫（count=1）已保证行存在，同事务内 findUnique 必命中
    const user = await tx.user.findUnique({ where: { id: userId } });
    await tx.pointsLedger.create({
      data: {
        id: createId("pl"),
        ownerId: userId,
        delta: -amount,
        reason,
        balanceAfter: user!.pointsBalance,
      },
    });
    return { balance: user!.pointsBalance };
  });
}

/**
 * 同一门店 24h 窗口内已生成的口播稿数（重写收费规则的计数依据）。无库抛 PointsUnavailableError。
 */
export async function countRecentScriptDrafts(
  ownerId: string,
  storeId: string,
  since: Date,
): Promise<number> {
  if (!hasDatabase()) throw new PointsUnavailableError();
  return getPrisma()!.scriptDraft.count({
    where: { ownerId, storeId, createdAt: { gte: since } },
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
  if (!hasDatabase()) throw new PointsUnavailableError();
  const code = normalizeRedeemCode(rawCode);
  const prisma = getPrisma()!;
  return prisma.$transaction(async (tx) => {
    const row = await tx.rechargeCode.findUnique({ where: { code } });
    if (!row || row.status !== "unused") throw new InvalidRedeemCodeError();
    const user = await tx.user.update({
      where: { id: userId },
      data: { pointsBalance: { increment: row.points } },
    });
    const guard = await tx.rechargeCode.updateMany({
      where: { id: row.id, status: "unused" },
      data: { status: "redeemed", redeemedById: userId, redeemedAt: new Date() },
    });
    if (guard.count === 0) throw new InvalidRedeemCodeError();
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
  if (!hasDatabase()) throw new PointsUnavailableError();
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
      group += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
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
  if (!hasDatabase()) throw new PointsUnavailableError();
  const prisma = getPrisma()!;
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    for (let attempt = 0; ; attempt++) {
      // 入库前归一化（去横杠大写），与 redeemPointsCode 的查询口径一致
      const code = normalizeRedeemCode(generateCodeString());
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

/**
 * 后台按邮箱查流水。无库抛 PointsUnavailableError；邮箱未注册抛 UserNotFoundError。
 */
export async function getAdminLedgerByEmail(
  email: string,
  limit: number,
): Promise<{ email: string; entries: PointsLedger[] }> {
  if (!hasDatabase()) throw new PointsUnavailableError();
  const normalized = email.trim().toLowerCase();
  const prisma = getPrisma()!;
  const user = await prisma.user.findUnique({ where: { email: normalized } });
  if (!user) throw new UserNotFoundError();
  const entries = await prisma.pointsLedger.findMany({
    where: { ownerId: user.id },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return { email: normalized, entries };
}
