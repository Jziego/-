import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { resetRuntimeStateForTests } from "@/lib/runtime-store";
import { getAssetRepository, getStoreRepository } from "@/lib/repositories";
import { createMockProvider } from "@/lib/services/providers/mock";
import { nowIso } from "@/lib/ids";
import type { Asset, StoreProfile } from "@/lib/types";

// 用可控 mock provider 替换 env 工厂
vi.mock("@/lib/services/providers", () => ({
  createProviderFromEnv: () => createMockProvider(),
}));
// 不触真 S3：presign 直接返回假 URL
vi.mock("@/lib/storage", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/storage")>();
  return { ...original, createPresignedGetUrl: vi.fn(async () => "https://cdn.example.com/presigned.mp4") };
});

import { POST } from "@/app/api/avatars/route";

const savedDbUrl = process.env.DATABASE_URL;

function seedStoreAndFootage(category: "material" | "avatar_footage") {
  const now = nowIso();
  const store: StoreProfile = {
    id: "store_1", ownerId: "demo_user", name: "测试店", industry: "餐饮",
    mainProducts: ["蛋糕"], targetCustomers: ["白领"], sellingPoints: ["现做"],
    brandTone: "亲切", forbiddenWords: [], createdAt: now, updatedAt: now,
  };
  const footage: Asset = {
    id: "asset_footage_1", ownerId: "demo_user", storeId: "store_1", type: "video",
    originalFilename: "me.mp4", storageKey: "stores/store_1/assets/asset_footage_1-me.mp4",
    mimeType: "video/mp4", sizeBytes: 1024, tags: [], businessTags: [],
    status: "ready", category, createdAt: now,
  };
  return { store, footage };
}

function post(body: unknown) {
  return POST(new Request("http://localhost/api/avatars", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }));
}

describe("POST /api/avatars (digital twin)", () => {
  beforeEach(async () => {
    delete process.env.DATABASE_URL;
    resetRuntimeStateForTests();
    const { store, footage } = seedStoreAndFootage("avatar_footage");
    await getStoreRepository().upsert(store);
    await getAssetRepository().create(footage);
  });
  afterEach(() => { if (savedDbUrl) process.env.DATABASE_URL = savedDbUrl; });

  it("creates a pending avatar with consent url (201)", async () => {
    const res = await post({ storeId: "store_1", footageAssetId: "asset_footage_1", name: "店主本人", consentAccepted: true });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.consentUrl).toContain("http");
    expect(json.avatar).toMatchObject({
      name: "店主本人",
      trainingStatus: "pending",
      consentStatus: "awaiting_user",
      trainingVideoAssetId: "asset_footage_1",
    });
    expect(json.avatar.providerGroupId).toBeTruthy();
    // providerAvatarId 此刻必须为空——ready 前不得有可合成 id
    expect(json.avatar.providerAvatarId).toBeUndefined();
  });

  it("rejects when consent not accepted", async () => {
    const res = await post({ storeId: "store_1", footageAssetId: "asset_footage_1", name: "x", consentAccepted: false });
    expect(res.status).toBe(400);
  });

  it("404s when the footage asset belongs to someone else / is material", async () => {
    const foreign: Asset = { ...seedStoreAndFootage("avatar_footage").footage, id: "asset_x", ownerId: "other" };
    await getAssetRepository().create(foreign);
    expect((await post({ storeId: "store_1", footageAssetId: "asset_x", name: "x", consentAccepted: true })).status).toBe(404);

    const material: Asset = { ...seedStoreAndFootage("material").footage, id: "asset_m" };
    await getAssetRepository().create(material);
    expect((await post({ storeId: "store_1", footageAssetId: "asset_m", name: "x", consentAccepted: true })).status).toBe(404);
  });

  it("400s on missing fields and overlong names", async () => {
    expect((await post({ storeId: "store_1", name: "x", consentAccepted: true })).status).toBe(400);
    expect((await post({ storeId: "store_1", footageAssetId: "asset_footage_1", name: "很".repeat(21), consentAccepted: true })).status).toBe(400);
  });
});
