import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * 假 Prisma：$transaction 直接同步执行回调并返回其结果；
 * user.updateMany 依据 where.pointsBalance.gte 模拟守卫；
 * 记录所有 create 调用供流水断言。
 */
function makeFakePrisma(initialBalance: number) {
  const state = { balance: initialBalance };
  const created: { table: string; data: Record<string, unknown> }[] = [];
  const rcState = { status: "unused" };
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
      findUnique: (_args: { where: { email: string } }) =>
        Promise.resolve<{ id: string; email: string; pointsBalance: number } | null>(null),
      findUniqueOrThrow: vi.fn(() => Promise.resolve({ id: "u1", pointsBalance: state.balance })),
    },
    rechargeCode: {
      findUnique: vi.fn(({ where }: { where: { code: string } }) =>
        Promise.resolve(
          where.code === "GOODCODE"
            ? { id: "rc1", code: "GOODCODE", points: 100, status: rcState.status }
            : null,
        ),
      ),
      updateMany: vi.fn(({ where, data }: { where: { id: string; status: string }; data: { status: string } }) => {
        if (where.status === "unused" && rcState.status === "unused") {
          rcState.status = data.status;
          return Promise.resolve({ count: 1 });
        }
        return Promise.resolve({ count: 0 });
      }),
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
    expect(tx.rechargeCode.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "rc1", status: "unused" }),
        data: expect.objectContaining({ status: "redeemed", redeemedById: "u1" }),
      }),
    );
    expect(created[0].data).toMatchObject({ delta: 100, reason: "兑换码充值", balanceAfter: 150 });
  });

  it("redeemPointsCode：无效码/已使用码抛 InvalidRedeemCodeError", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://fake");
    const { prisma } = makeFakePrisma(50);
    prisma.rechargeCode.findUnique = vi.fn(({ where }: { where: { code: string } }) =>
      Promise.resolve(
        where.code === "GOODCODE"
          ? { id: "rc1", code: "GOODCODE", points: 100, status: "redeemed" }
          : null,
      ),
    );
    vi.doMock("@/lib/prisma", () => ({ getPrisma: () => prisma }));
    const { redeemPointsCode, InvalidRedeemCodeError } = await importPoints();

    await expect(redeemPointsCode("u1", "NOPE")).rejects.toBeInstanceOf(InvalidRedeemCodeError);
    await expect(redeemPointsCode("u1", "GOODCODE")).rejects.toBeInstanceOf(InvalidRedeemCodeError);
  });

  it("redeemPointsCode：同一码不能兑换两次（第二次抛 InvalidRedeemCodeError，只写一条流水）", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://fake");
    const { prisma, state, created } = makeFakePrisma(0);
    vi.doMock("@/lib/prisma", () => ({ getPrisma: () => prisma }));
    const { redeemPointsCode, InvalidRedeemCodeError } = await importPoints();

    await expect(redeemPointsCode("u1", "GOODCODE")).resolves.toEqual({ points: 100, balance: 100 });
    await expect(redeemPointsCode("u2", "GOODCODE")).rejects.toBeInstanceOf(InvalidRedeemCodeError);
    expect(state.balance).toBe(100); // 第二次兑换的余额增量被守卫拦下并回滚
    expect(created).toHaveLength(1); // 只有一条流水
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
