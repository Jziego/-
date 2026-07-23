import { describe, expect, it } from "vitest";
import { MemoryScriptRepository } from "@/lib/repositories/memory";
import type { ScriptDraft } from "@/lib/types";

function makeDraft(id: string): ScriptDraft {
  return {
    id,
    ownerId: "user_1",
    storeId: "store_1",
    purpose: "store_traffic",
    platform: "douyin",
    title: "t",
    hook: "h",
    scenes: [{ order: 1, text: "原文", durationSeconds: 4, assetHints: [], role: "presenter" }],
    voiceover: "v",
    captions: [],
    cta: "c",
    generationMode: "ai",
    complianceWarnings: [],
    createdAt: "2026-07-23T00:00:00.000Z",
  };
}

describe("MemoryScriptRepository.update", () => {
  it("merges partial scenes and persists", async () => {
    const repo = new MemoryScriptRepository();
    await repo.create(makeDraft("script_update_1"));
    const updated = await repo.update("script_update_1", {
      scenes: [{ order: 1, text: "改后", durationSeconds: 4, assetHints: [], role: "presenter" }],
    });
    expect(updated.scenes[0]?.text).toBe("改后");
    const refetched = await repo.findById("script_update_1");
    expect(refetched?.scenes[0]?.text).toBe("改后");
  });

  it("throws when draft not found", async () => {
    const repo = new MemoryScriptRepository();
    await expect(repo.update("script_missing", { scenes: [] })).rejects.toThrow();
  });

  it("preserves id and untouched fields", async () => {
    const repo = new MemoryScriptRepository();
    await repo.create(makeDraft("script_update_2"));
    const updated = await repo.update("script_update_2", {
      scenes: [{ order: 1, text: "x", durationSeconds: 4, assetHints: [], role: "presenter" }],
    });
    expect(updated.id).toBe("script_update_2");
    expect(updated.title).toBe("t");
    expect(updated.hook).toBe("h");
  });
});
