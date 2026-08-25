import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAvatarApi,
  fetchAvatarStatusApi,
  reissueAvatarConsentApi,
} from "@/lib/api-client";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function okJson(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("avatar api client (Phase 3)", () => {
  beforeEach(() => mockFetch.mockReset());

  it("createAvatarApi posts the footage contract and returns avatar + consentUrl", async () => {
    mockFetch.mockResolvedValueOnce(okJson({ avatar: { id: "avatar_1" }, consentUrl: "https://consent/x" }, 201));
    const result = await createAvatarApi({
      storeId: "store_1", footageAssetId: "asset_f1", name: "店主", consentAccepted: true,
    });
    expect(result.consentUrl).toBe("https://consent/x");
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/avatars");
    expect(JSON.parse(init.body as string)).toEqual({
      storeId: "store_1", footageAssetId: "asset_f1", name: "店主", consentAccepted: true,
    });
  });

  it("fetchAvatarStatusApi hits the status endpoint", async () => {
    mockFetch.mockResolvedValueOnce(okJson({ avatar: { id: "avatar_1", trainingStatus: "ready" } }));
    const r = await fetchAvatarStatusApi("avatar_1");
    expect(mockFetch.mock.calls[0][0]).toBe("/api/avatars/avatar_1/status");
    expect(r.avatar.trainingStatus).toBe("ready");
  });

  it("reissueAvatarConsentApi posts to the consent endpoint", async () => {
    mockFetch.mockResolvedValueOnce(okJson({ avatar: { id: "avatar_1" }, consentUrl: "https://consent/new" }));
    const r = await reissueAvatarConsentApi("avatar_1");
    expect(mockFetch.mock.calls[0][0]).toBe("/api/avatars/avatar_1/consent");
    expect(mockFetch.mock.calls[0][1].method).toBe("POST");
    expect(r.consentUrl).toBe("https://consent/new");
  });
});
