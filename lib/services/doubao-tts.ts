import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDoubaoTtsApiKey, getDoubaoTtsResourceId, getDoubaoTtsVoice } from "@/lib/env";
import { createId } from "@/lib/ids";
import { SPEECH_CHARS_PER_SECOND } from "@/lib/speech-rate";
import { putObjectFromBuffer } from "@/lib/storage";
import { probeFileDuration } from "@/lib/services/ffmpeg-runner";
import type { WordTimestamp } from "@/lib/services/avatar-provider";

/**
 * 豆包语音合成大模型 2.0 —— V3 HTTP Chunked 单向流式客户端（官方文档 6561/1598757）。
 *
 * 选型说明：V1 非流式接口（/api/v1/tts）官方已标"不推荐"且不支持 TTS 2.0 音色；
 * V3 chunked 一次性输入全部文本、流式返回 JSON 帧，我们读完全流再组装——
 * 效果等同非流式，但能拿到 enable_subtitle=true 的字级时间戳（基于原文，
 * 字幕链路直接可用；V1 的 with_timestamp 是 TN 后文本，对不上原稿）。
 *
 * 只在 worker 侧使用：依赖 ffprobe 实测音频时长（mp3 句首有 ~100ms 静音，
 * 字幕末词时间不等于音频真实时长；时长是分段时间线/字幕对齐的权威数据源）。
 */

const ENDPOINT = "https://openspeech.bytedance.com/api/v3/tts/unidirectional";
const REQUEST_TIMEOUT_MS = 60_000;
/** 防御上限：V1 文档限 1024 字节；分段后单句远低于此。超长说明分段逻辑漏了，早炸。 */
const MAX_TEXT_BYTES = 3000;

export interface DoubaoTtsResult {
  audioStorageKey: string;
  durationSeconds: number;
  words: WordTimestamp[];
}

export interface DoubaoTtsDeps {
  fetchImpl: typeof fetch;
  probeDuration: (pathOrUrl: string) => Promise<number>;
  putObject: (key: string, bytes: Uint8Array, contentType: string) => Promise<unknown>;
  makeTmpDir: () => string;
  removeDir: (dir: string) => void;
  writeFileFn: (path: string, data: Buffer) => Promise<unknown>;
  /** 测试注入；缺省读 env。 */
  apiKey?: string;
  resourceId?: string;
}

// ── V3 帧形状（文档 2.3 节）──────────────────────────────────────────────────
// 音频帧 {code:0, data:"<base64>"}；字幕帧 {code:0, data:null, sentence:{...}}；
// 结束帧 {code:20000000, usage:{text_words}}；错误帧 code 为其他值。
interface V3Frame {
  code?: number;
  message?: string;
  data?: string | null;
  sentence?: {
    text?: string;
    words?: { word?: string; startTime?: number; endTime?: number }[];
  };
}

export async function synthesizeDoubaoSpeech(
  input: { text: string; voice?: string },
  deps?: Partial<DoubaoTtsDeps>,
): Promise<DoubaoTtsResult> {
  const apiKey = deps?.apiKey ?? getDoubaoTtsApiKey();
  if (!apiKey) {
    throw new Error("DOUBAO_TTS_API_KEY is not configured");
  }
  const textBytes = Buffer.byteLength(input.text, "utf8");
  if (textBytes > MAX_TEXT_BYTES) {
    throw new Error(`豆包 TTS 文本超长（${textBytes}B > ${MAX_TEXT_BYTES}B）——单句不应到此量级，请检查分段逻辑`);
  }

  const fetchImpl = deps?.fetchImpl ?? fetch;
  const res = await fetchImpl(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": apiKey,
      "X-Api-Resource-Id": deps?.resourceId ?? getDoubaoTtsResourceId(),
      "X-Api-Request-Id": randomUUID(),
    },
    body: JSON.stringify({
      user: { uid: "ai-video-assistant" },
      namespace: "BidirectionalTTS",
      req_params: {
        text: input.text,
        speaker: input.voice ?? getDoubaoTtsVoice(),
        audio_params: { format: "mp3", sample_rate: 24000, enable_subtitle: true },
      },
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const raw = await res.text();
  if (!res.ok) {
    // 401/403 多为服务未开通或 Key 不属于语音产品线（2026-09-16 实测 MediaKit Key → 401）
    throw new Error(`豆包 TTS HTTP ${res.status}：${raw.slice(0, 200)}`);
  }

  const audioChunks: Buffer[] = [];
  const words: WordTimestamp[] = [];
  let sawTerminalFrame = false;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let frame: V3Frame;
    try {
      frame = JSON.parse(trimmed) as V3Frame;
    } catch {
      throw new Error(`豆包 TTS 响应含非 JSON 行（协议漂移）：${trimmed.slice(0, 200)}`);
    }
    if (frame.code === 20000000) {
      sawTerminalFrame = true;
      continue;
    }
    if (frame.code !== 0) {
      throw new Error(`豆包 TTS 合成失败 code=${String(frame.code)}：${frame.message ?? "未知错误"}`);
    }
    if (typeof frame.data === "string" && frame.data.length > 0) {
      audioChunks.push(Buffer.from(frame.data, "base64"));
    }
    if (frame.sentence?.words) {
      for (const w of frame.sentence.words) {
        if (w.word && typeof w.startTime === "number" && typeof w.endTime === "number") {
          words.push({ word: w.word, startSec: w.startTime, endSec: w.endTime });
        }
      }
    }
  }
  if (!sawTerminalFrame) {
    throw new Error("豆包 TTS 响应缺少结束帧（code=20000000）——音频可能被截断，丢弃重试");
  }
  if (audioChunks.length === 0) {
    throw new Error("豆包 TTS 返回无音频数据");
  }
  const audio = Buffer.concat(audioChunks);

  const putObject = deps?.putObject ?? putObjectFromBuffer;
  const storageKey = `voices/${createId("tts")}.mp3`;
  await putObject(storageKey, new Uint8Array(audio), "audio/mpeg");

  // 时长权威来源：ffprobe 实测（字幕末词只是兜底；再兜不住按全局语速估算）。
  const makeTmpDir = deps?.makeTmpDir ?? (() => mkdtempSync(join(tmpdir(), "tts-")));
  const removeDir = deps?.removeDir ?? ((dir: string) => rmSync(dir, { recursive: true, force: true }));
  const writeFileFn = deps?.writeFileFn ?? (async (path: string, data: Buffer) => { await writeFile(path, data); });
  const probe = deps?.probeDuration ?? probeFileDuration;
  let durationSeconds = 0;
  const dir = makeTmpDir();
  try {
    const audioPath = join(dir, "speech.mp3");
    await writeFileFn(audioPath, audio);
    durationSeconds = await probe(audioPath);
  } finally {
    removeDir(dir);
  }
  if (!(durationSeconds > 0)) {
    const lastWordEnd = words.length > 0 ? Math.max(...words.map((w) => w.endSec)) : 0;
    durationSeconds = lastWordEnd > 0 ? lastWordEnd : Array.from(input.text).length / SPEECH_CHARS_PER_SECOND;
  }

  return { audioStorageKey: storageKey, durationSeconds, words };
}
