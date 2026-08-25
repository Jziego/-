import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { MemoryAvatarRepository } from "@/lib/repositories/memory";
import { resetRuntimeStateForTests } from "@/lib/runtime-store";
import { nowIso } from "@/lib/ids";
import type { AvatarProfile } from "@/lib/types";

const savedDbUrl = process.env.DATABASE_URL;

function buildAvatar(overrides: Partial<AvatarProfile> = {}): AvatarProfile {
  const now = nowIso();
  return {
    id: "avatar_1",
    ownerId: "owner_1",
    storeId: "store_1",
    name: "店主本人",
    provider: "mock-avatar",
    providerAvatarId: undefined,
    providerVoiceId: undefined,
    providerGroupId: "group_1",
    consentStatus: "awaiting_user",
    trainingVideoAssetId: "asset_footage_1",
    statusReason: undefined,
    consentAcceptedAt: now,
    trainingStatus: "pending",
    fallbackMode: "tts_voiceover",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("AvatarRepository (memory)", () => {
  beforeEach(() => {
    delete process.env.DATABASE_URL;
    resetRuntimeStateForTests();
  });
  afterEach(() => {
    if (savedDbUrl) process.env.DATABASE_URL = savedDbUrl;
  });

  it("round-trips the Phase 3 fields (name/group/consent/footage/reason)", async () => {
    const repo = new MemoryAvatarRepository();
    await repo.create(buildAvatar());
    const loaded = await repo.findById("avatar_1");
    expect(loaded?.name).toBe("店主本人");
    expect(loaded?.providerGroupId).toBe("group_1");
    expect(loaded?.consentStatus).toBe("awaiting_user");
    expect(loaded?.trainingVideoAssetId).toBe("asset_footage_1");
  });

  it("update merges fields and preserves identity", async () => {
    const repo = new MemoryAvatarRepository();
    await repo.create(buildAvatar());
    const updated = await repo.update("avatar_1", {
      consentStatus: "approved",
      trainingStatus: "ready",
      providerAvatarId: "look_1",
      providerVoiceId: "voice_1",
    });
    expect(updated.consentStatus).toBe("approved");
    expect(updated.trainingStatus).toBe("ready");
    expect(updated.providerAvatarId).toBe("look_1");
    expect(updated.id).toBe("avatar_1");
    expect(updated.name).toBe("店主本人");
    expect((await repo.findById("avatar_1"))?.trainingStatus).toBe("ready");
  });

  it("update throws when the avatar does not exist", async () => {
    const repo = new MemoryAvatarRepository();
    await expect(repo.update("nope", { trainingStatus: "failed" })).rejects.toThrow();
  });

  it("legacy avatars without Phase 3 fields default sanely", async () => {
    const repo = new MemoryAvatarRepository();
    const legacy = buildAvatar();
    delete (legacy as Partial<AvatarProfile>).name;
    delete (legacy as Partial<AvatarProfile>).consentStatus;
    await repo.create(legacy as AvatarProfile);
    const loaded = await repo.findById("avatar_1");
    expect(loaded?.name).toBe("");
    expect(loaded?.consentStatus).toBe("approved");
  });
});
