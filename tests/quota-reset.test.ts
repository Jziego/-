import { describe, it, expect, vi } from "vitest";

// Mock dependencies
vi.mock("@/lib/prisma", () => ({
  getPrisma: vi.fn(),
}));
vi.mock("@/lib/env", () => ({
  hasDatabase: vi.fn(),
}));

import { quotaResetProcessor } from "@/worker/processors/quota-reset";
import { getPrisma } from "@/lib/prisma";
import { hasDatabase } from "@/lib/env";

describe("quotaResetProcessor", () => {
  it("skips when no database is available", async () => {
    vi.mocked(hasDatabase).mockReturnValue(false);

    const result = await quotaResetProcessor({
      data: {},
    } as any);

    expect(result).toEqual({ usersReset: 0 });
  });

  it("resets free plan users to 10 and pro to 100", async () => {
    const mockUpdateMany = vi.fn()
      .mockResolvedValueOnce({ count: 3 }) // free users
      .mockResolvedValueOnce({ count: 1 }); // pro users

    vi.mocked(hasDatabase).mockReturnValue(true);
    vi.mocked(getPrisma).mockReturnValue({
      user: { updateMany: mockUpdateMany },
      $transaction: vi.fn((queries: Promise<any>[]) => Promise.all(queries)),
    } as any);

    const result = await quotaResetProcessor({
      data: {},
    } as any);

    expect(result.usersReset).toBe(4);
    expect(mockUpdateMany).toHaveBeenCalledTimes(2);

    // First call: free plan
    expect(mockUpdateMany).toHaveBeenNthCalledWith(1, {
      where: { plan: "free", quotaRemaining: { not: -1 } },
      data: { quotaRemaining: 10, lastQuotaReset: expect.any(String) },
    });

    // Second call: pro plan
    expect(mockUpdateMany).toHaveBeenNthCalledWith(2, {
      where: { plan: "pro", quotaRemaining: { not: -1 } },
      data: { quotaRemaining: 100, lastQuotaReset: expect.any(String) },
    });
  });

  it("does not reset enterprise (-1) users", async () => {
    const mockUpdateMany = vi.fn()
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 });

    vi.mocked(hasDatabase).mockReturnValue(true);
    vi.mocked(getPrisma).mockReturnValue({
      user: { updateMany: mockUpdateMany },
      $transaction: vi.fn((queries: Promise<any>[]) => Promise.all(queries)),
    } as any);

    const result = await quotaResetProcessor({
      data: {},
    } as any);

    // Enterprise users with quotaRemaining: -1 are excluded by `not: -1` filter
    expect(result.usersReset).toBe(0);
  });
});
