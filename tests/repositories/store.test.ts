import { beforeEach, describe, expect, it } from "vitest";
import { MemoryStoreRepository } from "@/lib/repositories/memory";
import { resetRuntimeStateForTests } from "@/lib/runtime-store";
import type { StoreProfile } from "@/lib/types";

function sampleStore(overrides: Partial<StoreProfile> = {}): StoreProfile {
  const now = new Date().toISOString();
  return {
    id: "store_test",
    ownerId: "demo_user",
    name: "测试门店",
    industry: "餐饮",
    mainProducts: ["牛肉面"],
    targetCustomers: ["上班族"],
    sellingPoints: ["现熬牛骨汤"],
    brandTone: "亲切接地气",
    forbiddenWords: [],
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

describe("MemoryStoreRepository", () => {
  beforeEach(() => {
    resetRuntimeStateForTests();
  });

  it("upserts and lists stores by owner", async () => {
    const repo = new MemoryStoreRepository();
    const store = sampleStore();

    await repo.upsert(store);
    const stores = await repo.listByOwner("demo_user");

    expect(stores).toHaveLength(1);
    expect(stores[0]?.name).toBe("测试门店");
  });

  it("updates an existing store on upsert", async () => {
    const repo = new MemoryStoreRepository();
    await repo.upsert(sampleStore());
    await repo.upsert(sampleStore({ name: "更新后的门店" }));

    const store = await repo.findById("store_test");
    expect(store?.name).toBe("更新后的门店");
  });
});
