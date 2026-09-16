import { describe, expect, it, vi, afterEach } from "vitest";
import { synthesizeDoubaoSpeech } from "@/lib/services/doubao-tts";

/** 构造 V3 chunked 响应体：音频帧 + 字幕帧 + 结束帧，逐行 JSON。 */
function chunkedBody(frames: object[]): string {
  return frames.map((f) => JSON.stringify(f)).join("\n");
}

function okResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
}

const audioFrame = (text: string) => ({ code: 0, message: "", data: Buffer.from(text).toString("base64") });
const subtitleFrame = {
  code: 0,
  data: null,
  sentence: {
    text: "大家好",
    words: [
      { word: "大", startTime: 0.0, endTime: 0.2, confidence: 0.9 },
      { word: "家", startTime: 0.2, endTime: 0.4, confidence: 0.9 },
      { word: "好", startTime: 0.4, endTime: 0.65, confidence: 0.9 },
    ],
  },
};
const endFrame = { code: 20000000, message: "ok", data: null, usage: { text_words: 3 } };

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    fetchImpl: vi.fn(async () => okResponse(chunkedBody([audioFrame("fake-mp3-bytes"), subtitleFrame, endFrame]))),
    probeDuration: vi.fn(async () => 0.72),
    putObject: vi.fn(async () => undefined),
    makeTmpDir: vi.fn(() => "C:/fake-tmp"),
    removeDir: vi.fn(),
    writeFileFn: vi.fn(async () => undefined),
    apiKey: "test-tts-key",
    ...overrides,
  };
}

describe("synthesizeDoubaoSpeech", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("posts to the V3 unidirectional endpoint with subtitle enabled and assembles audio + word timeline", async () => {
    const deps = makeDeps();
    const result = await synthesizeDoubaoSpeech({ text: "大家好", voice: "voice_x" }, deps);

    const [url, init] = (deps.fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://openspeech.bytedance.com/api/v3/tts/unidirectional");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Api-Key"]).toBe("test-tts-key");
    expect(headers["X-Api-Resource-Id"]).toBe("seed-tts-2.0");
    expect(headers["X-Api-Request-Id"]).toBeTruthy();
    const body = JSON.parse(String(init.body));
    expect(body.req_params.text).toBe("大家好");
    expect(body.req_params.speaker).toBe("voice_x");
    expect(body.req_params.audio_params).toMatchObject({ format: "mp3", enable_subtitle: true });

    // 音频拼装 → R2；时长来自 ffprobe 实测；字幕归一化为秒级 WordTimestamp。
    expect(deps.putObject).toHaveBeenCalledWith(
      expect.stringMatching(/^voices\/tts_.+\.mp3$/),
      new Uint8Array(Buffer.from("fake-mp3-bytes")),
      "audio/mpeg",
    );
    expect(result.durationSeconds).toBe(0.72);
    expect(result.words).toEqual([
      { word: "大", startSec: 0.0, endSec: 0.2 },
      { word: "家", startSec: 0.2, endSec: 0.4 },
      { word: "好", startSec: 0.4, endSec: 0.65 },
    ]);
    expect(result.audioStorageKey).toMatch(/^voices\//);
  });

  it("falls back to the env default voice when none is passed", async () => {
    vi.stubEnv("DOUBAO_TTS_VOICE", "zh_female_vv_uranus_bigtts");
    const deps = makeDeps();
    await synthesizeDoubaoSpeech({ text: "大家好" }, deps);
    const [, init] = (deps.fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).req_params.speaker).toBe("zh_female_vv_uranus_bigtts");
  });

  it("throws with the provider message on an error frame", async () => {
    const deps = makeDeps({
      fetchImpl: vi.fn(async () =>
        okResponse(chunkedBody([{ code: 3001, message: "speaker not found" }]))),
    });
    await expect(synthesizeDoubaoSpeech({ text: "大家好" }, deps)).rejects.toThrow(/3001.*speaker not found/);
  });

  it("throws on HTTP non-2xx with a truncated body excerpt", async () => {
    const deps = makeDeps({
      fetchImpl: vi.fn(async () => new Response("Unauthorized", { status: 401 })),
    });
    await expect(synthesizeDoubaoSpeech({ text: "大家好" }, deps)).rejects.toThrow(/401/);
  });

  it("throws when the stream ends without the terminal frame (audio may be truncated)", async () => {
    const deps = makeDeps({
      fetchImpl: vi.fn(async () => okResponse(chunkedBody([audioFrame("partial")]))),
    });
    await expect(synthesizeDoubaoSpeech({ text: "大家好" }, deps)).rejects.toThrow(/结束帧/);
  });

  it("throws when no audio frames are present", async () => {
    const deps = makeDeps({
      fetchImpl: vi.fn(async () => okResponse(chunkedBody([subtitleFrame, endFrame]))),
    });
    await expect(synthesizeDoubaoSpeech({ text: "大家好" }, deps)).rejects.toThrow(/无音频/);
  });

  it("falls back to the last word timestamp when ffprobe cannot measure duration", async () => {
    const deps = makeDeps({ probeDuration: vi.fn(async () => 0) });
    const result = await synthesizeDoubaoSpeech({ text: "大家好" }, deps);
    expect(result.durationSeconds).toBe(0.65); // 字幕末词 endSec
  });

  it("rejects over-long text before spending an API call", async () => {
    const deps = makeDeps();
    await expect(synthesizeDoubaoSpeech({ text: "长".repeat(1200) }, deps)).rejects.toThrow(/超长/);
    expect(deps.fetchImpl).not.toHaveBeenCalled();
  });

  it("throws when DOUBAO_TTS_API_KEY is not configured", async () => {
    vi.stubEnv("DOUBAO_TTS_API_KEY", "");
    await expect(synthesizeDoubaoSpeech({ text: "大家好" })).rejects.toThrow(/DOUBAO_TTS_API_KEY/);
  });
});
