import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/assets/confirm/route";
import * as env from "@/lib/env";
import * as repositories from "@/lib/repositories";
import { MemoryAssetRepository, MemoryStoreRepository } from "@/lib/repositories/memory";
import { resetRuntimeStateForTests } from "@/lib/runtime-store";
import * as storage from "@/lib/storage";

const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// MP3 (0xFF 0xFB) — recognized as audio/mpeg. Claiming it as image/png is a
// category mismatch the server must reject. (Unrecognized bytes — e.g. HTML —
// would yield detectedMime=null and be allowed by design, so we use bytes that
// resolve to a DIFFERENT top-level category than the claim.)
const MP3_MAGIC = new Uint8Array([0xff, 0xfb, 0x50, 0xc0]);

describe("POST /api/assets/confirm — server-side MIME verification", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetRuntimeStateForTests();
    vi.spyOn(env, "hasObjectStorage").mockReturnValue(true);
    vi.spyOn(repositories, "getStoreRepository").mockImplementation(() => new MemoryStoreRepository());
    vi.spyOn(repositories, "getAssetRepository").mockImplementation(() => new MemoryAssetRepository());
  });

  async function seedStore(storeId = "store_1") {
    const storeRepo = new MemoryStoreRepository();
    const now = new Date().toISOString();
    await storeRepo.upsert({
      id: storeId,
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
      updatedAt: now,
    });
    return storeRepo;
  }

  function req(body: unknown): Request {
    return new Request("http://localhost/api/assets/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects upload whose magic bytes don't match declared content type (audio bytes, image claim)", async () => {
    await seedStore();
    // Client claims image/png but the actual bytes are MP3 audio.
    vi.spyOn(storage, "headObject").mockResolvedValue({
      exists: true,
      contentLength: 100,
      contentType: "image/png",
    });
    const getFirstBytesSpy = vi
      .spyOn(storage, "getFirstBytes")
      .mockResolvedValue(MP3_MAGIC);
    const deleteSpy = vi
      .spyOn(storage, "deleteObject")
      .mockResolvedValue(undefined);

    const res = await POST(
      req({
        assetId: "asset_evil",
        storeId: "store_1",
        storageKey: "stores/store_1/assets/asset_evil-evil.png",
        originalFilename: "evil.html",
        mimeType: "image/png",
        type: "image",
        sizeBytes: 100,
      })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/mime|content|match/i);
    // The mismatched object must be cleaned up.
    expect(getFirstBytesSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledWith("stores/store_1/assets/asset_evil-evil.png");
    // And the asset must NOT be persisted.
    const assetRepo = new MemoryAssetRepository();
    expect(await assetRepo.findById("asset_evil")).toBeNull();
  });

  it("accepts upload whose magic bytes match the declared type (valid PNG)", async () => {
    await seedStore();
    vi.spyOn(storage, "headObject").mockResolvedValue({
      exists: true,
      contentLength: 100,
      contentType: "image/png",
    });
    vi.spyOn(storage, "getFirstBytes").mockResolvedValue(PNG_MAGIC);
    const deleteSpy = vi.spyOn(storage, "deleteObject").mockResolvedValue(undefined);

    const res = await POST(
      req({
        assetId: "asset_ok",
        storeId: "store_1",
        storageKey: "stores/store_1/assets/asset_ok-ok.png",
        originalFilename: "ok.png",
        mimeType: "image/png",
        type: "image",
        sizeBytes: 100,
      })
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.asset.mimeType).toBe("image/png");
    // No cleanup should happen for a valid upload.
    expect(deleteSpy).not.toHaveBeenCalled();
  });
});
