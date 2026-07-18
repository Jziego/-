import { beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE } from "@/app/api/assets/[id]/route";
import * as repositories from "@/lib/repositories";
import { MemoryAssetRepository } from "@/lib/repositories/memory";
import { resetRuntimeStateForTests } from "@/lib/runtime-store";
import * as storage from "@/lib/storage";
import type { Asset } from "@/lib/types";

function sampleAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: "asset_1",
    ownerId: "demo_user",
    storeId: "store_1",
    type: "video",
    originalFilename: "demo.mp4",
    storageKey: "stores/store_1/assets/asset_1-demo.mp4",
    mimeType: "video/mp4",
    sizeBytes: 5000,
    tags: [],
    businessTags: [],
    status: "uploaded",
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

function callDelete(id: string): Promise<Response> {
  const req = new Request(`http://localhost/api/assets/${id}`, { method: "DELETE" });
  return DELETE(req, { params: Promise.resolve({ id }) });
}

describe("DELETE /api/assets/[id]", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetRuntimeStateForTests();
    vi.spyOn(repositories, "getAssetRepository").mockImplementation(() => new MemoryAssetRepository());
    vi.spyOn(storage, "deleteObject").mockResolvedValue(undefined);
  });

  it("returns 404 when the asset does not exist", async () => {
    const res = await callDelete("asset_missing");
    expect(res.status).toBe(404);
  });

  it("returns 404 when the asset belongs to another owner (IDOR guard)", async () => {
    const repo = new MemoryAssetRepository();
    await repo.create(sampleAsset({ id: "asset_foreign", ownerId: "other_user" }));

    const res = await callDelete("asset_foreign");
    expect(res.status).toBe(404);
    expect(await repo.findById("asset_foreign")).not.toBeNull();
  });

  it("deletes the owner's asset and best-effort cleans storage", async () => {
    const repo = new MemoryAssetRepository();
    await repo.create(sampleAsset({ id: "asset_mine" }));

    const res = await callDelete("asset_mine");

    expect(res.status).toBe(200);
    expect(await repo.findById("asset_mine")).toBeNull();
    expect(storage.deleteObject).toHaveBeenCalledWith("stores/store_1/assets/asset_1-demo.mp4");
  });
});
