import type { Job } from "bullmq";
import { getPrisma } from "@/lib/prisma";
import { hasDatabase } from "@/lib/env";
import { nowIso } from "@/lib/ids";

export async function quotaResetProcessor(job: Job): Promise<{ usersReset: number }> {
  const prisma = getPrisma();
  if (!prisma || !hasDatabase()) {
    console.log("[quota-reset] No database available — skipping quota reset");
    return { usersReset: 0 };
  }

  const now = nowIso();

  // Wrap both plan resets in a transaction so either both succeed or both roll back.
  const [freeResult, proResult] = await prisma.$transaction([
    prisma.user.updateMany({
      where: {
        plan: "free",
        quotaRemaining: { not: -1 },
      },
      data: {
        quotaRemaining: 10,
        lastQuotaReset: now,
      },
    }),
    prisma.user.updateMany({
      where: {
        plan: "pro",
        quotaRemaining: { not: -1 },
      },
      data: {
        quotaRemaining: 100,
        lastQuotaReset: now,
      },
    }),
  ]);

  // enterprise (-1) users are skipped by the `not: -1` filter above

  const totalReset = freeResult.count + proResult.count;
  console.log(`[quota-reset] Reset ${freeResult.count} free-plan users to 10`);
  console.log(`[quota-reset] Reset ${proResult.count} pro-plan users to 100`);
  console.log(`[quota-reset] Monthly quota reset complete. ${totalReset} users reset.`);
  return { usersReset: totalReset };
}
