import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { resetRuntimeStateForTests } from "@/lib/runtime-store";
import { getAvatarRepository } from "@/lib/repositories";
import { nowIso } from "@/lib/ids";
import type { AvatarProfile } from "@/lib/types";
import { deleteCosyVoice } from "@/lib/services/cosyvoice-enrollment";

import { DELETE } from "@/app/api/avatars/[id]/route";

vi.mock("@/lib/services/cosyvoice-enrollment");

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
    vi.mocked(deleteCosyVoice).mockReset();
    vi.mocked(deleteCosyVoice).mockResolvedValue(undefined);
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

  it("删除对口型形象时同步释放百炼克隆音色", async () => {
    await getAvatarRepository().create(
      seedAvatar({ provider: "volcengine-lipsync", providerVoiceId: "cosyvoice-v3.5-plus-av1-x" }),
    );
    const res = await del("avatar_1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(deleteCosyVoice).toHaveBeenCalledWith("cosyvoice-v3.5-plus-av1-x");
  });

  it("音色删除失败不阻塞形象删除（log warn）", async () => {
    vi.mocked(deleteCosyVoice).mockRejectedValueOnce(new Error("bailian down"));
    await getAvatarRepository().create(
      seedAvatar({ provider: "volcengine-lipsync", providerVoiceId: "cosyvoice-v3.5-plus-av1-x" }),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await del("avatar_1");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ deleted: true });
      expect(warnSpy).toHaveBeenCalledOnce();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("HeyGen 形象 / 无克隆音色 → 不调 deleteCosyVoice", async () => {
    await getAvatarRepository().create(
      seedAvatar({ provider: "heygen", providerVoiceId: "heygen_voice_x" }),
    );
    expect((await del("avatar_1")).status).toBe(200);
    expect(deleteCosyVoice).not.toHaveBeenCalled();

    await getAvatarRepository().create(
      seedAvatar({ id: "avatar_2", provider: "volcengine-lipsync" }),
    );
    expect((await del("avatar_2")).status).toBe(200);
    expect(deleteCosyVoice).not.toHaveBeenCalled();
  });
});
