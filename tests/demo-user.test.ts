import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureDemoUser } from "@/lib/demo-user";
import { demoOwnerId } from "@/lib/runtime-store";

describe("ensureDemoUser", () => {
  const upsert = vi.fn();

  beforeEach(() => {
    upsert.mockReset();
    upsert.mockResolvedValue({});
  });

  it("upserts the demo owner before store writes", async () => {
    await ensureDemoUser({ user: { upsert } } as never, demoOwnerId);

    expect(upsert).toHaveBeenCalledWith({
      where: { id: demoOwnerId },
      update: {},
      create: {
        id: demoOwnerId,
        email: "demo@example.com",
        plan: "free",
        quotaRemaining: 10
      }
    });
  });
});
