import { describe, expect, it, afterEach, vi } from "vitest";
import { hasLipSyncProvider } from "@/lib/env";

describe("lipsync env accessors", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("hasLipSyncProvider requires both MEDIKIT_API_KEY and DOUBAO_TTS_API_KEY", () => {
    vi.stubEnv("MEDIKIT_API_KEY", "mk_key");
    vi.stubEnv("DOUBAO_TTS_API_KEY", "tts_key");
    expect(hasLipSyncProvider()).toBe(true);

    vi.stubEnv("DOUBAO_TTS_API_KEY", "");
    expect(hasLipSyncProvider()).toBe(false);
  });

  it("hasLipSyncProvider is false when both unset", () => {
    vi.stubEnv("MEDIKIT_API_KEY", "");
    vi.stubEnv("DOUBAO_TTS_API_KEY", "");
    expect(hasLipSyncProvider()).toBe(false);
  });
});
