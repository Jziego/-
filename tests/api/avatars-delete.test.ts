import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { resetRuntimeStateForTests } from "@/lib/runtime-store";
import { getAvatarRepository } from "@/lib/repositories";
import { nowIso } from "@/lib/ids";
import type { AvatarProfile } from "@/lib/types";

import { DELETE } from "@/app/api/avatars/[id]/route";

const savedDbUrl = process.env.DATABASE_URL;

function seedAvatar(overrides: Partial<AvatarProfile> = {}): AvatarProfile {
  const now = nowIso();
  return {
    id: "avatar_1", ownerId: "demo_user", storeId: "store_1", name: "店主",
    provider: "mock-avatar", providerGroupId: "group_1",
    consentStatus: "awaiting_user", trainingStatus: "pending",
    trainingVideoAssetId: "asset_f1",
    consentAcceptedAt: now, fallbackMode: "tts_voiceover",
    createdAt: now, updatedAt: now, ...overrides,
  };
}

function del(id: string) {
  return DELETE(new Request(`http://localhost/api/avatars/${id}`, { method: "DELETE" }), {
    params: Promise.resolve({ id }),
  } as never);
}

describe("DELETE /api/avatars/[id]", () => {
  beforeEach(() => {
    delete process.env.DATABASE_URL;
    resetRuntimeStateForTests();
  });
  afterEach(() => { if (savedDbUrl) process.env.DATABASE_URL = savedDbUrl; });

  it("deletes the owner's avatar (200) and removes it from the repo", async () => {
    await getAvatarRepository().create(seedAvatar());
    const res = await del("avatar_1");
    expect(res.status).toBe(200);
    expect(await getAvatarRepository().findById("avatar_1")).toBeNull();
  });

  it("404s for an avatar owned by someone else (IDOR-safe, not deleted)", async () => {
    await getAvatarRepository().create(seedAvatar({ ownerId: "other" }));
    const res = await del("avatar_1");
    expect(res.status).toBe(404);
    expect(await getAvatarRepository().findById("avatar_1")).not.toBeNull();
  });

  it("404s for a missing id and for the synthetic platform avatar", async () => {
    expect((await del("avatar_missing")).status).toBe(404);
    // 平台公共形象是合成的、从不落库，天然 404
    expect((await del("avatar_platform")).status).toBe(404);
  });
});
