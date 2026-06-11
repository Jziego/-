import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("heygen provider", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("AVATAR_PROVIDER_API_KEY", "hk_test_key");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("generateTalkingHead calls HeyGen API with correct payload", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ data: { video_id: "vid_abc", duration: 10 } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const { createHeyGenProvider } = await import(
      "@/lib/services/providers/heygen"
    );
    const provider = createHeyGenProvider();

    const result = await provider.generateTalkingHead({
      providerAvatarId: "avatar_1",
      scriptText: "欢迎光临本店",
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.heygen.com/v2/video/generate",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "X-Api-Key": "hk_test_key",
        }),
      }),
    );
    expect(result.videoAssetId).toBe("vid_abc");
    expect(result.durationSeconds).toBe(10);
  });

  it("throws on API error response", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { message: "Invalid avatar_id" } }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const { createHeyGenProvider } = await import(
      "@/lib/services/providers/heygen"
    );
    const provider = createHeyGenProvider();

    await expect(
      provider.generateTalkingHead({
        providerAvatarId: "bad_id",
        scriptText: "test",
      }),
    ).rejects.toThrow("Invalid avatar_id");
  });
});
