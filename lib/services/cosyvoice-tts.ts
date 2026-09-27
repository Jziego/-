// lib/services/cosyvoice-tts.ts
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCosyvoiceModel, getDashscopeApiKey, getDashscopeBaseUrl } from "@/lib/env";
import { createId } from "@/lib/ids";
import { SPEECH_CHARS_PER_SECOND } from "@/lib/speech-rate";
import { putObjectFromBuffer } from "@/lib/storage";
import { probeFileDuration } from "@/lib/services/ffmpeg-runner";
import type { WordTimestamp } from "@/lib/services/avatar-provider";
import type { DoubaoTtsResult } from "@/lib/services/doubao-tts";

/**
 * 阿里百炼 CosyVoice TTS 客户端（HTTP + X-DashScope-SSE: enable 流式）。
 * 与 doubao-tts.ts 同构（返回 DoubaoTtsResult），字幕链路零改动。
 *
 * 协议要点（2026-09-27 线上复刻实测，经历过一次上游协议漂移）：
 *  - SSE 每事件带完整框架：id:/event:result/注释行(:HTTP_STATUS/xxx)/data:——解析只认 data: 行
 *  - data 可能跨多行（限流时网关返回 200 + pretty-print JSON，首行仅 "data:{"）——
 *    必须按 SSE 规范把同一块的所有 data: 行用 \n 拼接后再 JSON.parse（单行假设曾致全线报错）
 *  - 音频帧在 sentence-synthesis 事件的 output.audio.data（base64），顺序拼接；
 *    终帧可能改给 output.audio.url（OSS 预签名）——无 base64 时回退下载
 *  - 字级时间戳 output.sentence.words[]（毫秒→秒），按「句index:begin_index」去重
 *  - finish_reason=="stop" 判完
 */

const SYNTH_PATH = "/services/audio/tts/SpeechSynthesizer";
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_TEXT_BYTES = 3000;

export type { DoubaoTtsResult as CosyvoiceTtsResult };

export interface CosyvoiceTtsDeps {
  fetchImpl: typeof fetch;
  probeDuration: (pathOrUrl: string) => Promise<number>;
  putObject: (key: string, bytes: Uint8Array, contentType: string) => Promise<unknown>;
  makeTmpDir: () => string;
  removeDir: (dir: string) => void;
  writeFileFn: (path: string, data: Buffer) => Promise<unknown>;
  /** 测试注入；缺省读 env。 */
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

interface SseEvent {
  request_id?: string;
  output?: {
    finish_reason?: string;
    type?: string;
    sentence?: {
      index?: number;
      words?: { text?: string; begin_index?: number; end_index?: number; begin_time?: number; end_time?: number }[];
    };
    audio?: { data?: string | null; url?: string | null };
  };
  code?: string;
  message?: string;
}

export async function synthesizeCosyVoiceSpeech(
  input: { text: string; voice: string },
  deps?: Partial<CosyvoiceTtsDeps>,
): Promise<DoubaoTtsResult> {
  const apiKey = deps?.apiKey ?? getDashscopeApiKey();
  if (!apiKey) {
    throw new Error("DASHSCOPE_API_KEY is not configured");
  }
  const textBytes = Buffer.byteLength(input.text, "utf8");
  if (textBytes === 0 || !input.text.trim()) {
    throw new Error("CosyVoice TTS 文本为空");
  }
  if (textBytes > MAX_TEXT_BYTES) {
    throw new Error(`CosyVoice TTS 文本超长（${textBytes}B > ${MAX_TEXT_BYTES}B）——单句不应到此量级，请检查分段逻辑`);
  }
  const baseUrl = (deps?.baseUrl ?? getDashscopeBaseUrl()).replace(/\/+$/, "");
  const fetchImpl = deps?.fetchImpl ?? fetch;
  const res = await fetchImpl(`${baseUrl}${SYNTH_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "X-DashScope-SSE": "enable",
    },
    body: JSON.stringify({
      model: deps?.model ?? getCosyvoiceModel(),
      input: {
        text: input.text,
        voice: input.voice,
        format: "mp3",
        sample_rate: 24000,
        word_timestamp_enabled: true,
      },
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`CosyVoice TTS HTTP ${res.status}：${raw.slice(0, 200)}`);
  }

  const audioChunks: Buffer[] = [];
  const wordMap = new Map<string, WordTimestamp & { __sort: [number, number] }>();
  let sawStop = false;
  let audioUrl: string | null = null;
  for (const block of raw.split(/\r?\n\r?\n/)) {
    // SSE 规范：同一事件块的多个 data: 行需按 \n 拼接后再解析。2026-09-27 上游漂移：
    // 限流时网关返回 200 + pretty-print 多行 data（首行仅 "data:{"），单行假设会报
    // 出误导性的「协议漂移」而丢失真实的 Throttling 错误码。
    const dataLines = block.split(/\r?\n/).filter((l) => l.startsWith("data:"));
    if (dataLines.length === 0) continue;
    const payload = dataLines.map((l) => l.slice(5)).join("\n");
    let evt: SseEvent;
    try {
      evt = JSON.parse(payload) as SseEvent;
    } catch {
      throw new Error(`CosyVoice TTS SSE 含非 JSON 事件（协议漂移）：${payload.slice(0, 200)}`);
    }
    if (evt.code) {
      throw new Error(`CosyVoice TTS 合成失败 code=${evt.code}：${evt.message ?? "未知错误"}`);
    }
    const out = evt.output;
    if (typeof out?.audio?.data === "string" && out.audio.data.length > 0) {
      audioChunks.push(Buffer.from(out.audio.data, "base64"));
    } else if (typeof out?.audio?.url === "string" && out.audio.url.length > 0) {
      audioUrl = out.audio.url;
    }
    if (Array.isArray(out?.sentence?.words)) {
      const sentIdx = typeof out.sentence.index === "number" ? out.sentence.index : 0;
      for (const w of out.sentence.words) {
        if (w?.text && typeof w.begin_time === "number" && typeof w.end_time === "number") {
          const beginIndex = typeof w.begin_index === "number" ? w.begin_index : wordMap.size;
          // 重复携带防御：同一句同一字后到的帧覆盖先到的（内容一致，幂等）。
          wordMap.set(`${sentIdx}:${beginIndex}`, {
            word: w.text,
            startSec: w.begin_time / 1000,
            endSec: w.end_time / 1000,
            __sort: [sentIdx, beginIndex],
          });
        }
      }
    }
    if (out?.finish_reason === "stop") sawStop = true;
  }
  if (!sawStop) {
    throw new Error("CosyVoice TTS 响应缺少结束帧（finish_reason≠stop）——音频可能被截断，丢弃重试");
  }
  // URL 帧兜底：新协议终帧可能只给 OSS 预签名 URL 而非 base64——回退下载。
  if (audioChunks.length === 0 && audioUrl) {
    const audioRes = await fetchImpl(audioUrl, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!audioRes.ok) {
      throw new Error(`CosyVoice TTS 音频 URL 下载 HTTP ${audioRes.status}`);
    }
    const urlBytes = Buffer.from(await audioRes.arrayBuffer());
    if (urlBytes.length > 0) audioChunks.push(urlBytes);
  }
  if (audioChunks.length === 0) {
    throw new Error("CosyVoice TTS 返回无音频数据");
  }
  const audio = Buffer.concat(audioChunks);
  // 非法 base64 会被 Node 静默解码成空 buffer——帧数检查兜不住，按零字节再拦一次。
  if (audio.length === 0) {
    throw new Error("CosyVoice TTS 返回无音频数据");
  }
  const words: WordTimestamp[] = [...wordMap.values()]
    .sort((a, b) => a.__sort[0] - b.__sort[0] || a.__sort[1] - b.__sort[1])
    .map(({ word, startSec, endSec }) => ({ word, startSec, endSec }));

  const putObject = deps?.putObject ?? putObjectFromBuffer;
  const storageKey = `voices/${createId("tts")}.mp3`;
  const audioBytes = new Uint8Array(audio);
  await putObject(storageKey, audioBytes, "audio/mpeg");

  // 时长权威来源：ffprobe 实测（与豆包同款 mp3 句首静音防御）。
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

  return { audioStorageKey: storageKey, audioBytes, durationSeconds, words };
}
