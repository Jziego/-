import { beforeEach, describe, expect, it } from "vitest";
import { MemoryAssetAnalysisRepository, MemoryAssetRepository } from "@/lib/repositories/memory";
import { resetRuntimeStateForTests } from "@/lib/runtime-store";
import type { Asset, AssetAnalysis } from "@/lib/types";

function sampleAsset(id: string, ownerId = "demo_user"): Asset {
  return {
    id,
    ownerId,
    storeId: "store_1",
    type: "video",
    originalFilename: `${id}.mp4`,
    storageKey: `stores/store_1/assets/${id}-demo.mp4`,
    mimeType: "video/mp4",
    sizeBytes: 5000,
    tags: [],
    businessTags: [],
    status: "uploaded",
    createdAt: new Date().toISOString()
  };
}

function sampleAnalysis(assetId: string, overrides: Partial<AssetAnalysis> = {}): AssetAnalysis {
  return {
    id: `analysis_${assetId}`,
    assetId,
    visualTags: ["food"],
    businessTags: ["新品推荐"],
    keywords: ["面"],
    confidence: 0.8,
    recommendedUses: ["new_product"],
    createdAt: new Date().toISOString(),
    analysisStatus: "succeeded",
    ...overrides
  };
}

describe("MemoryAssetRepository.deleteById", () => {
  beforeEach(() => {
    resetRuntimeStateForTests();
  });

  it("removes the asset and returns true when it existed", async () => {
    const repo = new MemoryAssetRepository();
    await repo.create(sampleAsset("asset_a"));

    const removed = await repo.deleteById("asset_a");

    expect(removed).toBe(true);
    expect(await repo.findById("asset_a")).toBeNull();
  });

  it("returns false and is a no-op when the asset is missing", async () => {
    const repo = new MemoryAssetRepository();

    const removed = await repo.deleteById("asset_missing");

    expect(removed).toBe(false);
  });

  it("also removes the asset's analysis (cascade cleanup)", async () => {
    const assetRepo = new MemoryAssetRepository();
    const analysisRepo = new MemoryAssetAnalysisRepository();
    await assetRepo.create(sampleAsset("asset_b"));
    await analysisRepo.create(sampleAnalysis("asset_b"));

    await assetRepo.deleteById("asset_b");

    expect(await analysisRepo.findByAssetId("asset_b")).toBeNull();
  });

  it("persists and returns analysisStatus via the memory repo", async () => {
    resetRuntimeStateForTests();
    const repo = new MemoryAssetAnalysisRepository();
    const analysis = sampleAnalysis("asset_a", { analysisStatus: "failed" });
    await repo.create(analysis);
    const found = await repo.findByAssetId("asset_a");
    expect(found?.analysisStatus).toBe("failed");
  });
});
