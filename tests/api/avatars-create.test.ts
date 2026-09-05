import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { resetRuntimeStateForTests } from "@/lib/runtime-store";
import { getAssetRepository, getAvatarRepository, getStoreRepository } from "@/lib/repositories";
import { createMockProvider } from "@/lib/services/providers/mock";
import { nowIso } from "@/lib/ids";
import type { Asset, StoreProfile } from "@/lib/types";

// 用可控 mock provider 替换 env 工厂；必须 importOriginal 展开真实导出——
// 路由里的 instanceof AvatarProviderNotConfiguredError 需要拿到真实错误类。
const { factoryMode } = vi.hoisted(() => ({
  factoryMode: { value: "mock" as "mock" | "unconfigured" },
}));
vi.mock("@/lib/services/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/services/providers")>();
  return {
    ...actual,
    createProviderFromEnv: () => {
      if (factoryMode.value === "unconfigured") {
        throw new actual.AvatarProviderNotConfiguredError();
      }
      return createMockProvider();
    },
  };
});
// 不触真 S3：presign 直接返回假 URL
vi.mock("@/lib/storage", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/storage")>();
  return { ...original, createPresignedGetUrl: vi.fn(async () => "https://cdn.example.com/presigned.mp4") };
});

import { GET, POST } from "@/app/api/avatars/route";

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
    factoryMode.value = "mock";
    const { store, footage } = seedStoreAndFootage("avatar_footage");
    await getStoreRepository().upsert(store);
    await getAssetRepository().create(footage);
  });
  afterEach(() => { if (savedDbUrl) process.env.DATABASE_URL = savedDbUrl; });

  it("returns 503 instead of a fake consent url when the provider is not configured", async () => {
    factoryMode.value = "unconfigured";
    const res = await post({ storeId: "store_1", footageAssetId: "asset_footage_1", name: "店主本人", consentAccepted: true });
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toContain("数字人服务未配置");
    // 不得落库假分身档案
    const avatars = await getAvatarRepository().listByOwner("demo_user");
    expect(avatars).toHaveLength(0);
  });

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

  it("400s when the footage exceeds the 30MB cap (legacy oversized asset)", async () => {
    // 闸门上线的之前上传的素材可能超过 HeyGen 32MB 硬上限——创建时明确 400，
    // 不再让 HeyGen 的 400 变成用户看不懂的 502（2026-09-05 生产事故）。
    const oversized: Asset = {
      ...seedStoreAndFootage("avatar_footage").footage,
      id: "asset_big",
      sizeBytes: 94 * 1024 * 1024,
    };
    await getAssetRepository().create(oversized);

    const res = await post({ storeId: "store_1", footageAssetId: "asset_big", name: "店主", consentAccepted: true });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("30MB");
    // 不落库、不 presign（不触 provider）
    expect(await getAvatarRepository().listByOwner("demo_user")).toHaveLength(0);
  });

  it("400s on missing fields and overlong names", async () => {
    expect((await post({ storeId: "store_1", name: "x", consentAccepted: true })).status).toBe(400);
    expect((await post({ storeId: "store_1", footageAssetId: "asset_footage_1", name: "很".repeat(21), consentAccepted: true })).status).toBe(400);
  });
});

describe("GET /api/avatars (platform fallback)", () => {
  beforeEach(() => {
    delete process.env.DATABASE_URL;
    resetRuntimeStateForTests();
  });
  afterEach(() => { if (savedDbUrl) process.env.DATABASE_URL = savedDbUrl; });

  it("GET appends the platform avatar only when the owner has no ready avatar", async () => {
    // 无形象 → 列表含平台兜底
    let res = await GET(new Request("http://localhost/api/avatars"));
    let json = await res.json();
    expect(json.avatars.some((a: { id: string }) => a.id === "avatar_platform")).toBe(true);

    // 创建一个 ready 形象后 → 平台兜底消失
    const now = new Date().toISOString();
    await getAvatarRepository().create({
      id: "avatar_ready", ownerId: "demo_user", storeId: "store_1", name: "店主",
      provider: "mock-avatar", providerAvatarId: "look_1", providerVoiceId: "voice_1",
      consentStatus: "approved", consentAcceptedAt: now, trainingStatus: "ready",
      fallbackMode: "tts_voiceover", createdAt: now, updatedAt: now,
    });
    res = await GET(new Request("http://localhost/api/avatars"));
    json = await res.json();
    expect(json.avatars.some((a: { id: string }) => a.id === "avatar_platform")).toBe(false);
  });
});
