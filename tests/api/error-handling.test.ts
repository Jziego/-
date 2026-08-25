import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as createAvatar } from "@/app/api/avatars/route";
import { POST as createAsset } from "@/app/api/assets/route";
import { POST as createScriptDraft } from "@/app/api/script-drafts/route";
import { GET as listStoreProfiles } from "@/app/api/store-profiles/route";
import * as repositories from "@/lib/repositories";
import { MemoryScriptRepository, MemoryStoreRepository } from "@/lib/repositories/memory";
import { resetRuntimeStateForTests } from "@/lib/runtime-store";

function jsonRequest(url: string, body?: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? "{ invalid json" : JSON.stringify(body)
  });
}

describe("API error handling", () => {
  beforeEach(() => {
    resetRuntimeStateForTests();
    vi.restoreAllMocks();
  });

  it("returns 404 when script draft store is missing", async () => {
    const response = await createScriptDraft(
      jsonRequest("http://localhost/api/script-drafts", { storeId: "missing-store" })
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBe("Store profile not found");
  });

  it("whitelists targetDurationSec to the 30/45/60 slots (3600 never reaches the engine)", async () => {
    const stores = new MemoryStoreRepository();
    await stores.upsert({
      id: "store_slot", ownerId: "demo_user", name: "n", industry: "i",
      mainProducts: [], targetCustomers: [], sellingPoints: [], brandTone: "t",
      forbiddenWords: [], createdAt: "2026-08-16T00:00:00.000Z", updatedAt: "2026-08-16T00:00:00.000Z",
    });
    vi.spyOn(repositories, "getStoreRepository").mockImplementation(() => stores);
    vi.spyOn(repositories, "getScriptRepository").mockImplementation(() => new MemoryScriptRepository());

    const rejected = await createScriptDraft(
      jsonRequest("http://localhost/api/script-drafts", { storeId: "store_slot", forceTemplate: true, targetDurationSec: 3600 })
    );
    expect(rejected.status).toBe(201);
    expect((await rejected.json()).script.targetDurationSec).toBeUndefined();

    const accepted = await createScriptDraft(
      jsonRequest("http://localhost/api/script-drafts", { storeId: "store_slot", forceTemplate: true, targetDurationSec: 45 })
    );
    expect(accepted.status).toBe(201);
    expect((await accepted.json()).script.targetDurationSec).toBe(45);
  });

  it("returns 400 when asset schema validation fails", async () => {
    const response = await createAsset(
      jsonRequest("http://localhost/api/assets", {
        storeId: "store_1",
        type: "not-a-real-type"
      })
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBeDefined();
    expect(typeof body.error).toBe("string");
  });

  it("returns 500 with a generic message when repository throws", async () => {
    vi.spyOn(repositories, "getStoreRepository").mockReturnValue({
      listByOwner: vi.fn().mockRejectedValue(new Error("database connection failed")),
      upsert: vi.fn(),
      findById: vi.fn()
    });

    const response = await listStoreProfiles(new Request("http://localhost/api/store-profiles"));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("Failed to list store profiles");
    expect(body.error).not.toContain("database connection failed");
  });

  it("returns 400 for malformed JSON on avatars POST", async () => {
    const response = await createAvatar(jsonRequest("http://localhost/api/avatars"));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Request body must be valid JSON");
  });
});
