import { describe, it, expect, beforeEach, vi } from "vitest";
import * as authHelpers from "@/lib/auth-helpers";
import * as rateLimit from "@/lib/rate-limit";
import * as aiClient from "@/lib/services/ai-client";
import { resetRuntimeStateForTests } from "@/lib/runtime-store";
import {
  MemoryAssetRepository,
  MemoryAssetAnalysisRepository,
  MemoryStoreRepository
} from "@/lib/repositories/memory";
import * as repositories from "@/lib/repositories";
import { POST } from "@/app/api/assets/[id]/reanalyze/route";
import type { Asset, StoreProfile } from "@/lib/types";

const baseAsset: Asset = {
  id: "asset_a",
  ownerId: "demo_user",
  storeId: "store_1",
  type: "image",
  originalFilename: "p.png",
  storageKey: "uploads/p.png",
  mimeType: "image/png",
  sizeBytes: 10,
  tags: [],
  businessTags: [],
  status: "uploaded",
  createdAt: "2026-01-01T00:00:00.000Z"
} as unknown as Asset;

const baseStore: StoreProfile = {
  id: "store_1",
  ownerId: "demo_user",
  name: "阿姨面馆",
  industry: "餐饮",
  mainProducts: ["牛肉面"],
  targetCustomers: ["上班族"],
  sellingPoints: ["现熬"],
  brandTone: "亲切接地气",
  forbiddenWords: [],
  promotions: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
} as unknown as StoreProfile;

function newRequest(id: string) {
  return new Request(`http://localhost/api/assets/${id}/reanalyze`, { method: "POST" });
}

describe("POST /api/assets/[id]/reanalyze", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetRuntimeStateForTests();
    vi.spyOn(authHelpers, "getOwnerId").mockResolvedValue("demo_user");
    vi.spyOn(rateLimit, "applyRateLimit").mockResolvedValue(null);
    vi.spyOn(repositories, "getAssetRepository").mockReturnValue(new MemoryAssetRepository());
    vi.spyOn(repositories, "getAssetAnalysisRepository").mockReturnValue(new MemoryAssetAnalysisRepository());
    vi.spyOn(repositories, "getStoreRepository").mockReturnValue(new MemoryStoreRepository());
  });

  it("returns 404 for a missing or foreign asset", async () => {
    const res = await POST(newRequest("asset_missing"), { params: Promise.resolve({ id: "asset_missing" }) });
    expect(res.status).toBe(404);
  });

  it("returns 503 when AI is not configured", async () => {
    const assetRepo = new MemoryAssetRepository();
    await assetRepo.create(baseAsset);
    vi.spyOn(repositories, "getAssetRepository").mockReturnValue(assetRepo);
    vi.spyOn(aiClient, "hasAI").mockReturnValue(false);
    const res = await POST(newRequest("asset_a"), { params: Promise.resolve({ id: "asset_a" }) });
    expect(res.status).toBe(503);
  });

  it("updates an existing analysis and returns 200 with succeeded status", async () => {
    const assetRepo = new MemoryAssetRepository();
    const analysisRepo = new MemoryAssetAnalysisRepository();
    const storeRepo = new MemoryStoreRepository();
    await assetRepo.create(baseAsset);
    await storeRepo.upsert(baseStore);
    vi.spyOn(repositories, "getAssetRepository").mockReturnValue(assetRepo);
    vi.spyOn(repositories, "getAssetAnalysisRepository").mockReturnValue(analysisRepo);
    vi.spyOn(repositories, "getStoreRepository").mockReturnValue(storeRepo);
    vi.spyOn(aiClient, "hasAI").mockReturnValue(true);
    vi.spyOn(aiClient, "chatCompletionJSON").mockResolvedValue({
      businessTags: ["新品推荐"],
      keywords: ["牛肉面"],
      recommendedUses: ["new_product"],
      reasoning: "x"
    });
    const res = await POST(newRequest("asset_a"), { params: Promise.resolve({ id: "asset_a" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.analysis.analysisStatus).toBe("succeeded");
    expect(body.analysis.businessTags).toContain("新品推荐");
  });

  it("records failed status (with fallback tags) when AI returns empty", async () => {
    const assetRepo = new MemoryAssetRepository();
    const analysisRepo = new MemoryAssetAnalysisRepository();
    const storeRepo = new MemoryStoreRepository();
    await assetRepo.create(baseAsset);
    await storeRepo.upsert(baseStore);
    vi.spyOn(repositories, "getAssetRepository").mockReturnValue(assetRepo);
    vi.spyOn(repositories, "getAssetAnalysisRepository").mockReturnValue(analysisRepo);
    vi.spyOn(repositories, "getStoreRepository").mockReturnValue(storeRepo);
    vi.spyOn(aiClient, "hasAI").mockReturnValue(true);
    vi.spyOn(aiClient, "chatCompletionJSON").mockResolvedValue(null);
    const res = await POST(newRequest("asset_a"), { params: Promise.resolve({ id: "asset_a" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.analysis.analysisStatus).toBe("failed");
  });
});
