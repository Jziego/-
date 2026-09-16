#!/usr/bin/env node
/**
 * 豆包语音合成大模型 2.0（V3 HTTP 单向流式）—— 一次性探针脚本
 *
 * 验证点：
 *  1. API.txt 的火山 Key 能否直接调通语音合成服务（X-Api-Key 鉴权）
 *  2. enable_subtitle=true 是否返回字级时间戳（基于原文，字幕链路依赖）
 *  3. mp3 音频能否完整拼装、落盘可听
 *
 * 用法：node scripts/probe-doubao-tts.mjs [--text="..."] [--speaker=zh_female_shuangkuaisisi_moon_bigtts]
 * 产物：D:/下载/tts-probe.mp3（可用 PROBE_OUT_DIR 覆盖）
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const ENDPOINT = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
const KEY_FILE = process.env.MEDIKIT_KEY_FILE || 'C:/Users/Administrator/Desktop/API.txt';
const OUT_DIR = process.env.PROBE_OUT_DIR || 'D:/下载';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/s);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), 'true'];
  })
);
const text = args.text || '大家好，我是老刘。本周店里做活动，全场满五十减十块，欢迎光临！';
const speaker = args.speaker || 'zh_female_vv_uranus_bigtts';

const apiKey = readFileSync(KEY_FILE, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
if (!apiKey) {
  console.error(`密钥文件为空：${KEY_FILE}`);
  process.exit(2);
}
console.log(`[probe] 已读取密钥（长度 ${apiKey.length}，内容不显示）`);

const body = {
  user: { uid: 'probe-script' },
  namespace: 'BidirectionalTTS',
  req_params: {
    text,
    speaker,
    audio_params: {
      format: 'mp3',
      sample_rate: 24000,
      enable_subtitle: true,
    },
  },
};

console.log(`[probe] POST ${ENDPOINT}（speaker=${speaker}，文本 ${Array.from(text).length} 字）…`);
const res = await fetch(ENDPOINT, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Api-Key': apiKey,
    'X-Api-Resource-Id': 'seed-tts-2.0',
    'X-Api-Request-Id': randomUUID(),
  },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(60_000),
});

const raw = await res.text();
console.log(`[probe] HTTP ${res.status}，响应 ${(raw.length / 1024).toFixed(1)}KB（chunked JSON 行）`);

// 响应是若干行 JSON：音频帧 {code:0,data:"<base64>"}；字幕帧 {code:0,sentence:{...}}；
// 结束帧 {code:20000000}。错误时可能整体是一行非流式 JSON。
const audioChunks = [];
const subtitleWords = [];
let sawEnd = false;
let lineCount = 0;

for (const line of raw.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  lineCount++;
  let frame;
  try {
    frame = JSON.parse(trimmed);
  } catch {
    console.log(`[probe] 第 ${lineCount} 行非 JSON（截断 300 字）：${trimmed.slice(0, 300)}`);
    continue;
  }
  if (frame.code !== 0 && frame.code !== 20000000) {
    console.error(`[probe] ✗ 服务端错误帧：code=${frame.code} message=${frame.message}`);
    process.exit(1);
  }
  if (frame.code === 20000000) {
    sawEnd = true;
    console.log(`[probe] 结束帧：usage=${JSON.stringify(frame.usage ?? null)}`);
    continue;
  }
  if (typeof frame.data === 'string' && frame.data.length > 0) {
    audioChunks.push(Buffer.from(frame.data, 'base64'));
  }
  if (frame.sentence?.words) {
    for (const w of frame.sentence.words) {
      subtitleWords.push({ word: w.word, startTime: w.startTime, endTime: w.endTime });
    }
  }
}

if (lineCount === 0) {
  console.error('[probe] ✗ 空响应');
  process.exit(1);
}

console.log(`[probe] 共 ${lineCount} 帧：音频块 ${audioChunks.length} 个，字幕词 ${subtitleWords.length} 个，结束帧=${sawEnd}`);

if (audioChunks.length === 0) {
  console.error('[probe] ✗ 没有音频数据');
  process.exit(1);
}
const audio = Buffer.concat(audioChunks);
const outPath = join(OUT_DIR, 'tts-probe.mp3');
writeFileSync(outPath, audio);
console.log(`[probe] 音频已落盘 → ${outPath}（${(audio.length / 1024).toFixed(1)}KB）`);

if (subtitleWords.length > 0) {
  const last = subtitleWords[subtitleWords.length - 1];
  console.log(`[probe] 字级时间轴（秒）：首词 ${JSON.stringify(subtitleWords[0])}，末词 ${JSON.stringify(last)}`);
  console.log(`[probe] 字幕全长 ≈ ${last.endTime}s（应与 mp3 时长相近）`);
} else {
  console.error('[probe] ✗ enable_subtitle=true 但未收到任何字幕帧');
  process.exit(1);
}
console.log('[probe] ✓ 全链路通过');
