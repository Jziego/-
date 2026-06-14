import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as createAvatar } from "@/app/api/avatars/route";
import { POST as createAsset } from "@/app/api/assets/route";
import { POST as createScriptDraft } from "@/app/api/script-drafts/route";
import { GET as listStoreProfiles } from "@/app/api/store-profiles/route";
import * as repositories from "@/lib/repositories";
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
    expect(body.error).toBe("Invalid JSON body");
  });
});
