// tests/cosyvoice-tts.test.ts
import { describe, expect, it, vi } from "vitest";
import { synthesizeCosyVoiceSpeech, type CosyvoiceTtsDeps } from "@/lib/services/cosyvoice-tts";

// 请求体断言依赖默认模型——屏蔽开发者 shell 里 export 的 COSYVOICE_MODEL。
vi.stubEnv("COSYVOICE_MODEL", "cosyvoice-v3.5-plus");

function sseBody(events: object[]): string {
  return events.map((e) => `data:${JSON.stringify(e)}`).join("\n\n") + "\n\n";
}

const AUDIO_FRAME = {
  request_id: "r1",
  output: {
    finish_reason: "null",
    type: "sentence-synthesis",
    sentence: {
      index: 0,
      words: [
        { text: "大", begin_index: 0, end_index: 1, begin_time: 0, end_time: 250 },
        { text: "家", begin_index: 1, end_index: 2, begin_time: 250, end_time: 520 },
      ],
    },
    audio: { data: Buffer.from("fake-mp3-audio").toString("base64") },
  },
};
const STOP_FRAME = { request_id: "r1", output: { finish_reason: "stop", type: "sentence-end", sentence: { index: 0, words: [] } }, usage: { characters: 2 } };

function makeDeps(body: string, status = 200, probeSeconds = 0.52) {
  const stored: { key?: string } = {};
  const deps: CosyvoiceTtsDeps = {
    fetchImpl: (async () => new Response(body, { status })) as unknown as typeof fetch,
    probeDuration: async () => probeSeconds,
    putObject: async (key) => { stored.key = key; },
    makeTmpDir: () => "/tmp/tts-test",
    removeDir: () => {},
    writeFileFn: async () => {},
    apiKey: "sk-test",
    baseUrl: "https://api.test/api/v1",
  };
  return { deps, stored };
}

describe("synthesizeCosyVoiceSpeech", () => {
  it("SSE 流解析：音频拼接 + 字戳毫秒→秒 + 时长 ffprobe 实测", async () => {
    const { deps, stored } = makeDeps(sseBody([AUDIO_FRAME, STOP_FRAME]));
    const result = await synthesizeCosyVoiceSpeech({ text: "大家", voice: "cosyvoice-v3.5-plus-av1-x" }, deps);
    expect(result.words).toEqual([
      { word: "大", startSec: 0, endSec: 0.25 },
      { word: "家", startSec: 0.25, endSec: 0.52 },
    ]);
    expect(result.durationSeconds).toBe(0.52);
    expect(stored.key).toMatch(/^voices\/.+\.mp3$/);
    expect(result.audioBytes.length).toBeGreaterThan(0);
  });

  it("sentence-synthesis 重复携带 words → 按句:index:begin_index 去重；音频帧不去重、顺序拼接", async () => {
    // 第二帧重复携带第一帧的 words（协议行为），audio 数据不同。
    const frameB = {
      ...AUDIO_FRAME,
      output: { ...AUDIO_FRAME.output, audio: { data: Buffer.from("fake-mp3-audio-2").toString("base64") } },
    };
    const { deps } = makeDeps(sseBody([AUDIO_FRAME, frameB, STOP_FRAME]));
    const result = await synthesizeCosyVoiceSpeech({ text: "大家", voice: "v" }, deps);
    expect(result.words.length).toBe(2);
    // 协议关键不对称性：words 去重，audio 全部拼接（丢帧即破音）。
    expect(Buffer.from(result.audioBytes).toString()).toBe("fake-mp3-audiofake-mp3-audio-2");
  });

  it("非法 base64 音频帧 → 解码零字节抛无音频（不落地存储）", async () => {
    const badAudio = { request_id: "r", output: { finish_reason: "null", type: "sentence-synthesis", sentence: { index: 0, words: [] }, audio: { data: "!!!" } } };
    const { deps, stored } = makeDeps(sseBody([badAudio, STOP_FRAME]));
    await expect(synthesizeCosyVoiceSpeech({ text: "大家", voice: "v" }, deps)).rejects.toThrow(/无音频/);
    expect(stored.key).toBeUndefined();
  });

  it("时长 fallback：ffprobe 为 0 → 取字幕末词 endSec", async () => {
    const { deps } = makeDeps(sseBody([AUDIO_FRAME, STOP_FRAME]), 200, 0);
    const result = await synthesizeCosyVoiceSpeech({ text: "大家", voice: "v" }, deps);
    expect(result.durationSeconds).toBe(0.52); // AUDIO_FRAME 末词 end_time 520ms
  });

  it("时长 fallback 链末端：无字幕 → 按字数/语速估算", async () => {
    const audioNoWords = { request_id: "r", output: { finish_reason: "null", type: "sentence-synthesis", sentence: { index: 0, words: [] }, audio: { data: Buffer.from("fake-mp3-audio").toString("base64") } } };
    const { deps } = makeDeps(sseBody([audioNoWords, STOP_FRAME]), 200, 0);
    const result = await synthesizeCosyVoiceSpeech({ text: "大家好", voice: "v" }, deps);
    expect(result.durationSeconds).toBeCloseTo(3 / 4.5, 4); // 3字 / 4.5字每秒 ≈ 0.6667
  });

  it("请求体带 word_timestamp_enabled + SSE 头", async () => {
    let sentBody = "";
    let sseHeader = "";
    const { deps } = makeDeps(sseBody([AUDIO_FRAME, STOP_FRAME]));
    deps.fetchImpl = (async (_url: string, init?: RequestInit) => {
      sentBody = String(init?.body ?? "");
      sseHeader = String((init?.headers as Record<string, string>)?.["X-DashScope-SSE"] ?? "");
      return new Response(sseBody([AUDIO_FRAME, STOP_FRAME]), { status: 200 });
    }) as unknown as typeof fetch;
    await synthesizeCosyVoiceSpeech({ text: "大家", voice: "v" }, deps);
    expect(sentBody).toContain('"word_timestamp_enabled":true');
    expect(sentBody).toContain('"model":"cosyvoice-v3.5-plus"');
    expect(sseHeader).toBe("enable");
  });

  it("缺 stop 帧 → 抛音频截断", async () => {
    const { deps } = makeDeps(sseBody([AUDIO_FRAME]));
    await expect(synthesizeCosyVoiceSpeech({ text: "大家", voice: "v" }, deps)).rejects.toThrow(/截断|结束/);
  });

  it("无音频数据 → 抛错", async () => {
    const noAudio = { request_id: "r", output: { finish_reason: "null", type: "sentence-begin", sentence: { index: 0, words: [] } } };
    const { deps } = makeDeps(sseBody([noAudio, STOP_FRAME]));
    await expect(synthesizeCosyVoiceSpeech({ text: "大家", voice: "v" }, deps)).rejects.toThrow(/无音频/);
  });

  it("HTTP 非 200 → 抛错带截断原文", async () => {
    const { deps } = makeDeps(JSON.stringify({ code: "InvalidApiKey", message: "bad" }), 401);
    await expect(synthesizeCosyVoiceSpeech({ text: "大家", voice: "v" }, deps)).rejects.toThrow(/401/);
  });

  it("文本为空 → 抛错", async () => {
    const { deps } = makeDeps(sseBody([STOP_FRAME]));
    await expect(synthesizeCosyVoiceSpeech({ text: "  ", voice: "v" }, deps)).rejects.toThrow(/为空/);
  });

  it("未配置 DASHSCOPE_API_KEY → 抛错", async () => {
    await expect(synthesizeCosyVoiceSpeech({ text: "大家", voice: "v" }, {
      fetchImpl: (async () => new Response("")) as unknown as typeof fetch,
      probeDuration: async () => 1,
      putObject: async () => {},
      makeTmpDir: () => "/tmp/x",
      removeDir: () => {},
      writeFileFn: async () => {},
      apiKey: "",
    })).rejects.toThrow(/DASHSCOPE_API_KEY/);
  });
});
