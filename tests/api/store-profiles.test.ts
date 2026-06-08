import { beforeEach, describe, expect, it } from "vitest";
import { GET, POST } from "@/app/api/store-profiles/route";
import { resetRuntimeStateForTests } from "@/lib/runtime-store";

describe("store-profiles API", () => {
  beforeEach(() => {
    resetRuntimeStateForTests();
  });

  it("creates and lists store profiles", async () => {
    const now = new Date().toISOString();
    const createResponse = await POST(
      new Request("http://localhost/api/store-profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "测试小店",
          industry: "餐饮",
          location: "上海",
          mainProducts: ["牛肉面"],
          targetCustomers: ["上班族"],
          sellingPoints: ["现熬牛骨汤"],
          brandTone: "亲切接地气",
          forbiddenWords: [],
          createdAt: now,
          updatedAt: now
        })
      })
    );

    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();
    expect(created.store.name).toBe("测试小店");

    const listResponse = await GET();
    const listed = await listResponse.json();
    expect(listed.stores).toHaveLength(1);
    expect(listed.stores[0]?.id).toBe(created.store.id);
  });
});
