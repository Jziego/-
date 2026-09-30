import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * 假 Prisma：$transaction 直接同步执行回调并返回其结果；
 * user.updateMany 依据 where.pointsBalance.gte 模拟守卫；
 * 记录所有 create 调用供流水断言。
 */
/** 测试辅助：无横杠码按 4-4-4-4 加横杠，模拟用户从后台复制/手输带横杠版本。 */
function insertDashes(code: string): string {
  return code.replace(/(.{4})(?=.)/g, "$1-");
}

function makeFakePrisma(initialBalance: number) {
  const state = { balance: initialBalance };
  const created: { table: string; data: Record<string, unknown> }[] = [];
  const rcState = { status: "unused" };
  const rcCreated: { id: string; code: string; points: number }[] = [];
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
      // 默认按 id 查询返回当前余额（consumePoints / getPointsBalance 读此桩）；
      // 声明参数保留 { where: { email } } 形状以兼容按邮箱覆盖的既有用例（Mock 类型参数需同形）
      findUnique: vi.fn((_args: { where: { email: string } }) =>
        Promise.resolve<{ id: string; pointsBalance: number } | null>({ id: "u1", pointsBalance: state.balance }),
      ),
      // adminAdjustPoints（本次修复范围外）仍读 findUniqueOrThrow，保留同名桩
      findUniqueOrThrow: vi.fn(() => Promise.resolve({ id: "u1", pointsBalance: state.balance })),
    },
    rechargeCode: {
      create: vi.fn(({ data }: { data: { id: string; code: string; points: number } }) => {
        rcCreated.push(data);
        return Promise.resolve(data);
      }),
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
      findMany: vi.fn((): Promise<unknown[]> => Promise.resolve([])),
    },
  };
  const prisma = {
    $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    ...tx,
  };
  return { prisma, state, created, tx, rcCreated };
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

  it("consumePoints：demo 用户豁免——不查库、不写流水", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://fake");
    vi.stubEnv("APP_MODE", "demo");
    const { prisma, created } = makeFakePrisma(0);
    vi.doMock("@/lib/prisma", () => ({ getPrisma: () => prisma }));
    const { demoOwnerId } = await import("@/lib/runtime-store");
    const { consumePoints } = await importPoints();

    await expect(consumePoints(demoOwnerId, 10, "生成口播稿")).resolves.toEqual({ balance: 0 });
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
  });

  it("getPointsBalance：用户行不存在返回 null（demo+PG 未建行前不 500）", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://fake");
    const { prisma } = makeFakePrisma(0);
    prisma.user.findUnique = vi.fn(() => Promise.resolve(null));
    vi.doMock("@/lib/prisma", () => ({ getPrisma: () => prisma }));
    const { getPointsBalance } = await importPoints();

    await expect(getPointsBalance("ghost-user")).resolves.toBeNull();
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

  it("generateRechargeCodes：入库与返回均为无横杠格式（库存与 redeem 归一化口径一致）", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://fake");
    const { prisma, rcCreated } = makeFakePrisma(0);
    vi.doMock("@/lib/prisma", () => ({ getPrisma: () => prisma }));
    const { generateRechargeCodes } = await importPoints();

    const codes = await generateRechargeCodes(100, 3);

    expect(codes).toHaveLength(3);
    for (const code of codes) {
      expect(code).not.toContain("-");
      expect(code).toHaveLength(16);
    }
    expect(rcCreated.map((r) => r.code)).toEqual(codes);
    for (const row of rcCreated) expect(row.code).not.toContain("-");
  });

  it("redeemPointsCode：带横杠输入可兑换——与库存无横杠格式归一化匹配", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://fake");
    const { prisma, state, created, tx } = makeFakePrisma(0);
    // 以 create 落入的假库存模拟真实 DB：findUnique 按归一化后的无横杠码精确命中
    const stored: { id: string; code: string; points: number; status: string }[] = [];
    tx.rechargeCode.create.mockImplementation(
      ({ data }: { data: { id: string; code: string; points: number } }) => {
        stored.push({ ...data, status: "unused" });
        return Promise.resolve(data);
      },
    );
    tx.rechargeCode.findUnique.mockImplementation(({ where }: { where: { code: string } }) =>
      Promise.resolve(stored.find((s) => s.code === where.code) ?? null),
    );
    tx.rechargeCode.updateMany.mockImplementation(
      ({ where, data }: { where: { id: string; status: string }; data: { status: string } }) => {
        const row = stored.find((s) => s.id === where.id && s.status === where.status);
        if (!row) return Promise.resolve({ count: 0 });
        row.status = data.status;
        return Promise.resolve({ count: 1 });
      },
    );
    vi.doMock("@/lib/prisma", () => ({ getPrisma: () => prisma }));
    const { generateRechargeCodes, redeemPointsCode } = await importPoints();

    const [generated] = await generateRechargeCodes(100, 1);
    const dashed = insertDashes(generated);
    expect(dashed).toContain("-");

    await expect(redeemPointsCode("u1", dashed)).resolves.toEqual({ points: 100, balance: 100 });
    expect(state.balance).toBe(100);
    expect(created[0].data).toMatchObject({ delta: 100, reason: "兑换码充值", balanceAfter: 100 });
  });

  it("getAdminLedgerByEmail：返回倒序流水；邮箱不存在抛 UserNotFoundError", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://fake");
    const { prisma } = makeFakePrisma(0);
    const entries = [{ id: "pl1" }];
    prisma.user.findUnique = vi.fn(({ where }: { where: { email: string } }) =>
      Promise.resolve(
        where.email === "a@b.com"
          ? { id: "u1", email: "a@b.com", pointsBalance: 0 }
          : null,
      ),
    );
    prisma.pointsLedger.findMany = vi.fn(() => Promise.resolve(entries));
    vi.doMock("@/lib/prisma", () => ({ getPrisma: () => prisma }));
    const { getAdminLedgerByEmail, UserNotFoundError } = await importPoints();

    const ok = await getAdminLedgerByEmail("A@B.com", 50);
    expect(ok.entries).toBe(entries);
    expect(prisma.pointsLedger.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { ownerId: "u1" }, orderBy: { createdAt: "desc" }, take: 50 }),
    );

    await expect(getAdminLedgerByEmail("ghost@x.com", 50)).rejects.toBeInstanceOf(UserNotFoundError);
  });
});
