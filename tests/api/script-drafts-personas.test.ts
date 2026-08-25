import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetRuntimeStateForTests } from "@/lib/runtime-store";
import { getAvatarRepository, getStoreRepository } from "@/lib/repositories";
import type { AvatarProfile, StoreProfile } from "@/lib/types";

import { POST } from "@/app/api/script-drafts/route";

const savedDbUrl = process.env.DATABASE_URL;

function seedStore(): StoreProfile {
  const now = "2026-08-25T00:00:00.000Z";
  return {
    id: "store_1", ownerId: "demo_user", name: "测试店", industry: "餐饮",
    mainProducts: ["蛋糕"], targetCustomers: ["白领"], sellingPoints: ["现做"],
    brandTone: "亲切", forbiddenWords: [], createdAt: now, updatedAt: now,
  };
}

function seedAvatar(overrides: Partial<AvatarProfile> & { id: string }): AvatarProfile {
  const now = "2026-08-25T00:00:00.000Z";
  return {
    ownerId: "demo_user", storeId: "store_1", name: "", provider: "mock-avatar",
    consentStatus: "approved", consentAcceptedAt: now, trainingStatus: "ready",
    fallbackMode: "tts_voiceover", createdAt: now, updatedAt: now,
    ...overrides,
  };
}

describe("POST /api/script-drafts — avatar personas (Phase 3)", () => {
  beforeEach(async () => {
    delete process.env.DATABASE_URL;
    resetRuntimeStateForTests();
    await getStoreRepository().upsert(seedStore());
  });
  afterEach(() => { if (savedDbUrl) process.env.DATABASE_URL = savedDbUrl; });

  it("persists speakerAvatarIds from the store's ready avatars (createdAt order)", async () => {
    // 先插 late 再插 early：断言必须反映 createdAt 排序而非插入顺序
    await getAvatarRepository().create(seedAvatar({
      id: "avatar_late", name: "店长小姐姐", createdAt: "2026-08-02T00:00:00.000Z",
    }));
    await getAvatarRepository().create(seedAvatar({
      id: "avatar_early", name: "店主", createdAt: "2026-08-01T00:00:00.000Z",
    }));
    // pending 形象与别店 ready 形象都必须被排除
    await getAvatarRepository().create(seedAvatar({ id: "avatar_pending", trainingStatus: "pending" }));
    await getAvatarRepository().create(seedAvatar({ id: "avatar_other_store", storeId: "store_2" }));

    const res = await POST(new Request("http://localhost/api/script-drafts", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ storeId: "store_1", purpose: "store_traffic", forceTemplate: true }),
    }));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.script.speakerAvatarIds).toEqual(["avatar_early", "avatar_late"]);
  });
});
