import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

// Mock putObjectFromBuffer so tests never touch real S3.
const { putObjectFromBufferMock } = vi.hoisted(() => ({
  putObjectFromBufferMock: vi.fn(),
}));
vi.mock("@/lib/storage", () => ({
  putObjectFromBuffer: putObjectFromBufferMock,
}));

// Mock global fetch (HeyGen API + video download).
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("heygen provider", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("AVATAR_PROVIDER_API_KEY", "hk_test_key");
    vi.stubEnv("HEYGEN_POLL_INTERVAL_MS", "1"); // keep tests fast (must be > 0)
    vi.stubEnv("HEYGEN_POLL_MAX_ATTEMPTS", "60");
    putObjectFromBufferMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("createAvatar uses HEYGEN_AVATAR_TEMPLATE_ID + HEYGEN_VOICE_ID when set", async () => {
    vi.stubEnv("HEYGEN_AVATAR_TEMPLATE_ID", "tpl_123");
    vi.stubEnv("HEYGEN_VOICE_ID", "v_42");

    const { createHeyGenProvider } = await import("@/lib/services/providers/heygen");
    const provider = createHeyGenProvider();

    const result = await provider.createAvatar({
      trainingVideoAssetId: "asset_1",
      ownerId: "owner_1",
    });

    expect(result).toEqual({ providerAvatarId: "tpl_123", providerVoiceId: "v_42" });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("generateTalkingHead creates via v3, polls, downloads, uploads to R2", async () => {
    vi.stubEnv("HEYGEN_AVATAR_TEMPLATE_ID", "tpl_123");
    vi.stubEnv("HEYGEN_VOICE_ID", "v_42");

    // 1) POST /v3/videos -> video_id
    // 2) GET /v3/videos/{id} -> processing
    // 3) GET /v3/videos/{id} -> completed (video_url + duration)
    // 4) GET video_url -> binary bytes
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ data: { video_id: "vid_abc" } }))
      .mockResolvedValueOnce(jsonResponse({ data: { status: "processing" } }))
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            status: "completed",
            video_url: "https://cdn.heygen.com/v.mp4",
            duration: 12,
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }),
      );

    const { createHeyGenProvider } = await import("@/lib/services/providers/heygen");
    const provider = createHeyGenProvider();

    const result = await provider.generateTalkingHead({
      providerAvatarId: "avatar_1",
      providerVoiceId: "voice_1",
      scriptText: "欢迎光临本店",
    });

    // Create call: v3 endpoint, flat body, X-Api-Key header.
    const createCall = mockFetch.mock.calls[0];
    expect(createCall[0]).toBe("https://api.heygen.com/v3/videos");
    expect(createCall[1]).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({ "X-Api-Key": "hk_test_key" }),
    });
    const createBody = JSON.parse(createCall[1].body as string);
    expect(createBody).toMatchObject({
      type: "avatar",
      avatar_id: "avatar_1",
      voice_id: "voice_1",
      script: "欢迎光临本店",
    });

    // Status poll used GET on the v3 video resource.
    const pollCall = mockFetch.mock.calls[1];
    expect(pollCall[0]).toBe("https://api.heygen.com/v3/videos/vid_abc");
    expect(pollCall[1]).toMatchObject({ method: "GET" });

    // Downloaded bytes were uploaded to our R2, and we return our storage key.
    expect(putObjectFromBufferMock).toHaveBeenCalledTimes(1);
    const [storageKey, bytes, contentType] = putObjectFromBufferMock.mock.calls[0];
    expect(storageKey).toMatch(/^avatars\//);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(contentType).toBe("video/mp4");
    expect(result.videoAssetId).toBe(storageKey);
    expect(result.durationSeconds).toBe(12);
  });

  it("throws when HeyGen reports status failed (no upload)", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ data: { video_id: "vid_fail" } }))
      .mockResolvedValueOnce(
        jsonResponse({
          data: { status: "failed", failure_message: "invalid avatar" },
        }),
      );

    const { createHeyGenProvider } = await import("@/lib/services/providers/heygen");
    const provider = createHeyGenProvider();

    await expect(
      provider.generateTalkingHead({ providerAvatarId: "bad", scriptText: "x" }),
    ).rejects.toThrow("invalid avatar");

    expect(putObjectFromBufferMock).not.toHaveBeenCalled();
  });

  it("throws on polling timeout (max attempts exceeded while processing)", async () => {
    vi.stubEnv("HEYGEN_POLL_MAX_ATTEMPTS", "3");

    // Same body for create (reads video_id) and every poll (reads status).
    // mockImplementation so each call gets a fresh Response (bodies are single-use).
    mockFetch.mockImplementation(async () =>
      jsonResponse({ data: { video_id: "vid_t", status: "processing" } }),
    );

    const { createHeyGenProvider } = await import("@/lib/services/providers/heygen");
    const provider = createHeyGenProvider();

    await expect(
      provider.generateTalkingHead({ providerAvatarId: "a", scriptText: "x" }),
    ).rejects.toThrow(/timed out|timeout/i);

    expect(putObjectFromBufferMock).not.toHaveBeenCalled();
  });

  it("throws on API error response from create", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ error: { message: "Invalid avatar_id" } }, 400),
    );

    const { createHeyGenProvider } = await import("@/lib/services/providers/heygen");
    const provider = createHeyGenProvider();

    await expect(
      provider.generateTalkingHead({ providerAvatarId: "bad_id", scriptText: "test" }),
    ).rejects.toThrow("Invalid avatar_id");
  });
});
