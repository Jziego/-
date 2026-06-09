import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/assets/confirm/route";
import * as env from "@/lib/env";
import * as repositories from "@/lib/repositories";
import { MemoryAssetRepository, MemoryStoreRepository } from "@/lib/repositories/memory";
import { resetRuntimeStateForTests } from "@/lib/runtime-store";
import * as storage from "@/lib/storage";

describe("POST /api/assets/confirm", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetRuntimeStateForTests();
    vi.spyOn(env, "hasObjectStorage").mockReturnValue(true);
    vi.spyOn(repositories, "getStoreRepository").mockImplementation(() => new MemoryStoreRepository());
    vi.spyOn(repositories, "getAssetRepository").mockImplementation(() => new MemoryAssetRepository());
  });

  async function seedStore() {
    const storeRepo = new MemoryStoreRepository();
    const now = new Date().toISOString();
    await storeRepo.upsert({
      id: "store_1",
      ownerId: "demo_user",
      name: "测试小店",
      industry: "餐饮",
      location: "上海",
      mainProducts: ["牛肉面"],
      targetCustomers: ["上班族"],
      sellingPoints: ["现熬牛骨汤"],
      promotions: [],
      brandTone: "亲切接地气",
      forbiddenWords: [],
      createdAt: now,
      updatedAt: now
    });
    return storeRepo;
  }

  it("returns 503 when object storage is not configured", async () => {
    vi.spyOn(env, "hasObjectStorage").mockReturnValue(false);

    const response = await POST(
      new Request("http://localhost/api/assets/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      })
    );

    expect(response.status).toBe(503);
  });

  it("creates an asset after HeadObject succeeds", async () => {
    await seedStore();
    vi.spyOn(storage, "headObject").mockResolvedValue({
      exists: true,
      contentLength: 5000,
      contentType: "video/mp4"
    });

    const response = await POST(
      new Request("http://localhost/api/assets/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assetId: "asset_1",
          storeId: "store_1",
          storageKey: "stores/store_1/assets/asset_1-demo.mp4",
          originalFilename: "demo.mp4",
          mimeType: "video/mp4",
          type: "video",
          sizeBytes: 5000
        })
      })
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.asset.storageKey).toBe("stores/store_1/assets/asset_1-demo.mp4");
    expect(body.asset.status).toBe("uploaded");
    expect(body.asset.sizeBytes).toBe(5000);
  });

  it("returns 404 when the uploaded object is missing", async () => {
    await seedStore();
    vi.spyOn(storage, "headObject").mockResolvedValue({ exists: false });

    const response = await POST(
      new Request("http://localhost/api/assets/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assetId: "asset_2",
          storeId: "store_1",
          storageKey: "stores/store_1/assets/asset_2-demo.mp4",
          originalFilename: "demo.mp4",
          mimeType: "video/mp4",
          type: "video"
        })
      })
    );

    expect(response.status).toBe(404);
  });

  it("returns 409 when the asset was already confirmed", async () => {
    await seedStore();
    vi.spyOn(storage, "headObject").mockResolvedValue({
      exists: true,
      contentLength: 5000,
      contentType: "video/mp4"
    });

    const payload = {
      assetId: "asset_3",
      storeId: "store_1",
      storageKey: "stores/store_1/assets/asset_3-demo.mp4",
      originalFilename: "demo.mp4",
      mimeType: "video/mp4",
      type: "video" as const
    };

    const first = await POST(
      new Request("http://localhost/api/assets/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      })
    );
    expect(first.status).toBe(201);

    const second = await POST(
      new Request("http://localhost/api/assets/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      })
    );
    expect(second.status).toBe(409);
  });
});
