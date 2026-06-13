import { getPrisma } from "@/lib/prisma";
import { hasDatabase } from "@/lib/env";
import { demoOwnerId } from "@/lib/runtime-store";

const UNLIMITED = -1;

export class QuotaExhaustedError extends Error {
  public plan: string;

  constructor(plan: string) {
    super("Quota exhausted");
    this.name = "QuotaExhaustedError";
    this.plan = plan;
  }
}

/**
 * Read-only quota display (Dashboard use).
 */
export async function getQuotaInfo(userId: string) {
  if (!hasDatabase()) return { plan: "free" as const, remaining: 10 };

  const prisma = getPrisma()!;
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  return { plan: user.plan, remaining: user.quotaRemaining };
}

/**
 * Atomically consume one quota unit.
 *
 * Behavior by context:
 * - demoOwnerId         → skip (no-op, returns free/10)
 * - !hasDatabase()      → skip (returns free/10)
 * - quotaRemaining = -1 → skip (unlimited, returns plan/UNLIMITED)
 * - quotaRemaining > 0  → atomic decrement, returns updated plan/remaining
 * - quotaRemaining = 0  → throws QuotaExhaustedError
 */
export async function consumeQuota(
  userId: string,
): Promise<{ plan: string; remaining: number }> {
  // Demo user: never deduct
  if (userId === demoOwnerId) return { plan: "free", remaining: 10 };

  // No database: skip deduction
  if (!hasDatabase()) return { plan: "free", remaining: 10 };

  const prisma = getPrisma()!;

  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

  // Unlimited users: skip deduction
  if (user.quotaRemaining === UNLIMITED) {
    return { plan: user.plan, remaining: UNLIMITED };
  }

  // Atomic deduction with guard condition (prevents race)
  const result = await prisma.user.updateMany({
    where: { id: userId, quotaRemaining: { gt: 0 } },
    data: { quotaRemaining: { decrement: 1 } },
  });

  if (result.count === 0) {
    throw new QuotaExhaustedError(user.plan);
  }

  const updated = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  return { plan: updated.plan, remaining: updated.quotaRemaining };
}
