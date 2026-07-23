import { beforeEach, describe, expect, it, vi } from "vitest";
import { PATCH } from "@/app/api/script-drafts/[id]/route";
import * as repositories from "@/lib/repositories";
import { MemoryScriptRepository, MemoryAssetRepository } from "@/lib/repositories/memory";
import { resetRuntimeStateForTests } from "@/lib/runtime-store";
import type { Asset, ScriptDraft } from "@/lib/types";

function draftRow(id: string, ownerId: string): ScriptDraft {
  return {
    id, ownerId, storeId: "store_1", purpose: "store_traffic", platform: "douyin",
    title: "t", hook: "h",
    scenes: [
      { order: 1, text: "镜1", durationSeconds: 4, assetHints: ["招牌"], role: "presenter", matchedAssetId: null },
      { order: 2, text: "镜2", durationSeconds: 5, assetHints: ["产品"], role: "broll", matchedAssetId: null },
    ],
    voiceover: "v", captions: [], cta: "c", generationMode: "ai", complianceWarnings: [],
    createdAt: "2026-07-23T00:00:00.000Z",
  };
}

function assetRow(id: string, ownerId: string): Asset {
  return {
    id, ownerId, storeId: "store_1", type: "image", originalFilename: "a.jpg",
    storageKey: "k", mimeType: "image/jpeg", sizeBytes: 1, tags: [], businessTags: [],
    status: "ready", createdAt: "2026-07-23T00:00:00.000Z",
  };
}

function req(body: unknown, id: string): [Request, { params: Promise<{ id: string }> }] {
  return [
    new Request(`http://localhost/api/script-drafts/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  ];
}

describe("PATCH /api/script-drafts/[id]", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetRuntimeStateForTests();
    vi.spyOn(repositories, "getScriptRepository").mockImplementation(() => new MemoryScriptRepository());
    vi.spyOn(repositories, "getAssetRepository").mockImplementation(() => new MemoryAssetRepository());
  });

  it("updates scene text and matchedAssetId, returns updated draft", async () => {
    const scripts = new MemoryScriptRepository();
    const assets = new MemoryAssetRepository();
    await scripts.create(draftRow("script_patch", "demo_user"));
    await assets.create(assetRow("asset_own", "demo_user"));

    const [request, ctx] = req(
      { scenes: [{ order: 1, text: "改后文案", matchedAssetId: "asset_own" }] },
      "script_patch",
    );
    const res = await PATCH(request, ctx);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.script.scenes[0].text).toBe("改后文案");
    expect(json.script.scenes[0].matchedAssetId).toBe("asset_own");
    expect(json.script.scenes[1].text).toBe("镜2"); // 未提交的镜保持不变
  });

  it("returns 404 for a draft owned by someone else (no existence leak)", async () => {
    const scripts = new MemoryScriptRepository();
    await scripts.create(draftRow("script_other", "user_other"));
    const [request, ctx] = req({ scenes: [] }, "script_other");
    const res = await PATCH(request, ctx);
    expect(res.status).toBe(404);
  });

  it("returns 404 when matchedAssetId belongs to another owner", async () => {
    const scripts = new MemoryScriptRepository();
    const assets = new MemoryAssetRepository();
    await scripts.create(draftRow("script_patch", "demo_user"));
    await assets.create(assetRow("asset_foreign", "user_other"));
    const [request, ctx] = req(
      { scenes: [{ order: 1, matchedAssetId: "asset_foreign" }] },
      "script_patch",
    );
    const res = await PATCH(request, ctx);
    expect(res.status).toBe(404);
  });

  it("returns 400 when body is not valid JSON", async () => {
    const scripts = new MemoryScriptRepository();
    await scripts.create(draftRow("script_patch", "demo_user"));

    const request = new Request("http://localhost/api/script-drafts/script_patch", {
      method: "PATCH",
      body: "not json",
    });
    const ctx = { params: Promise.resolve({ id: "script_patch" }) };
    const res = await PATCH(request, ctx);
    expect(res.status).toBe(400);
  });
});
