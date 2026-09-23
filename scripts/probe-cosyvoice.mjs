#!/usr/bin/env node
/**
 * 阿里云百炼 CosyVoice 声音复刻 + 流式合成 —— 一次性探针脚本
 *
 * 验证点：
 *  1. 百炼 workspace 端点 + Key 能否调通 voice-enrollment（克隆免费）
 *  2. 同一音频样本分别克隆 cosyvoice-v3.5-flash / cosyvoice-v3.5-plus 两个音色
 *  3. HTTP SSE 流式合成（X-DashScope-SSE: enable）+ word_timestamp_enabled
 *     是否对复刻音色返回字级时间戳（字幕链路硬约束）
 *  4. 两个模型的克隆音质对比 —— 产物落盘供人工盲听验收
 *
 * 用法：node scripts/probe-cosyvoice.mjs [--text="..."] [--sample="D:/下载/30s素材.mp4"]
 * 产物：D:/下载/cosyvoice-flash-probe.mp3、cosyvoice-plus-probe.mp3（可用 PROBE_OUT_DIR 覆盖）
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

// ── 配置 ─────────────────────────────────────────────────────────────────────
const KEY_FILE = process.env.BAILIAN_KEY_FILE || 'C:/Users/刘鉴震/Desktop/百炼.txt';
const OUT_DIR = process.env.PROBE_OUT_DIR || 'D:/下载';
// fileURLToPath 正确处理中文路径的百分号编码（pathname 手算会踩坑）
const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ENV_FILE = join(PROJECT_ROOT, '.env');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/s);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), 'true'];
  })
);
const DEFAULT_TEXT =
  '深圳的餐饮老板注意啦！门店没客流，不是菜不好吃，是没人知道你。我在龙岗做了十五年线上运营，帮三百多家店做过同城获客。现在用 AI 自动生成推广视频，不懂技术也能上手，评论区扣一，我发你案例。';
const text = args.text || DEFAULT_TEXT;
const sampleInput = args.sample || 'D:/下载/30s素材.mp4';
const MODELS = ['cosyvoice-v3.5-flash', 'cosyvoice-v3.5-plus'];

// ── 工具 ─────────────────────────────────────────────────────────────────────
function fail(msg) {
  console.error(`[probe] ✗ ${msg}`);
  process.exit(1);
}

function readBailianKey() {
  if (!existsSync(KEY_FILE)) fail(`密钥文件不存在：${KEY_FILE}`);
  const lines = readFileSync(KEY_FILE, 'utf8').split(/\r?\n/);
  let baseUrl = '';
  let apiKey = '';
  for (const line of lines) {
    const m = line.match(/^\s*(?:DashScope|url|URL)?\s*[:：]?\s*(https:\/\/\S+)\s*$/i);
    if (m) baseUrl = m[1];
    const k = line.match(/^\s*(?:key|Key|KEY)?\s*[:：]?\s*(sk-\S+)\s*$/);
    if (k) apiKey = k[1];
  }
  if (!baseUrl || !apiKey) fail(`密钥文件解析失败（需含 base URL 行与 sk- 开头的 key 行）：${KEY_FILE}`);
  console.log(`[probe] 已读取百炼密钥（长度 ${apiKey.length}，内容不显示）；端点 ${baseUrl}`);
  return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey };
}

function readProjectEnv() {
  if (!existsSync(ENV_FILE)) fail(`.env 不存在：${ENV_FILE}（R2 上传需要 OBJECT_STORAGE_*）`);
  const env = {};
  for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

function findBinary(name) {
  const wingetDir =
    'C:/Users/刘鉴震/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe';
  const candidates = [name, `${name}.exe`];
  try {
    const { readdirSync } = require('node:fs');
    for (const entry of readdirSync(wingetDir)) {
      const p = join(wingetDir, entry, 'bin', `${name}.exe`);
      if (existsSync(p)) return p;
    }
  } catch { /* PATH 里再试 */ }
  for (const c of candidates) {
    try {
      execFileSync(c, ['-version'], { stdio: 'pipe' });
      return c;
    } catch { /* 继续 */ }
  }
  fail(`找不到 ${name}（ffmpeg 用于抽取克隆样本音轨）`);
}

async function postJson(url, apiKey, body, extraHeaders = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const raw = await res.text();
  return { status: res.status, raw };
}

// ── 主流程 ───────────────────────────────────────────────────────────────────
const { baseUrl, apiKey } = readBailianKey();
const env = readProjectEnv();

// Step 1: 抽取克隆样本（视频 → wav 24k mono 15s；若输入已是音频则只转格式截长）
if (!existsSync(sampleInput)) fail(`样本文件不存在：${sampleInput}`);
const ffmpeg = findBinary('ffmpeg');
const tmpDir = mkdtempSync(join(tmpdir(), 'cosyvoice-probe-'));
const sampleWav = join(tmpDir, 'sample.wav');
console.log(`[probe] 抽取样本：${sampleInput} → wav 24kHz 单声道 15s（跳过开头 5s）…`);
try {
  execFileSync(ffmpeg, [
    '-y', '-ss', '5', '-t', '15', '-i', sampleInput,
    '-vn', '-ac', '1', '-ar', '24000', '-sample_fmt', 's16', sampleWav,
  ], { stdio: 'pipe' });
} catch (e) {
  fail(`ffmpeg 抽轨失败：${e.message}`);
}
const sampleBytes = readFileSync(sampleWav);
console.log(`[probe] 样本就绪：${(sampleBytes.length / 1024).toFixed(0)}KB`);

// Step 2: 样本投递。优先试 data URI（省掉 R2 往返；本地 .env 的存储端点可能是
// 开发用 MinIO 而非生产 R2）；--use-r2 强制走 R2 presigned URL。
let sampleUrl;
if (args['use-r2']) {
  const bucket = env.OBJECT_STORAGE_BUCKET || 'ai-video-assistant';
  if (!env.OBJECT_STORAGE_ENDPOINT || !env.OBJECT_STORAGE_ACCESS_KEY_ID) {
    fail('.env 缺少 OBJECT_STORAGE_* 配置');
  }
  const s3 = new S3Client({
    endpoint: env.OBJECT_STORAGE_ENDPOINT,
    region: env.OBJECT_STORAGE_REGION || 'us-east-1',
    credentials: {
      accessKeyId: env.OBJECT_STORAGE_ACCESS_KEY_ID,
      secretAccessKey: env.OBJECT_STORAGE_SECRET_ACCESS_KEY,
    },
    forcePathStyle: true,
  });
  const sampleKey = `probe/voice-samples/${randomUUID()}.wav`;
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: sampleKey, Body: sampleBytes, ContentType: 'audio/wav' }));
  sampleUrl = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: sampleKey }), { expiresIn: 3600 });
  console.log(`[probe] 样本已上传 R2 并生成 1h presigned URL`);
} else {
  sampleUrl = `data:audio/wav;base64,${sampleBytes.toString('base64')}`;
  console.log(`[probe] 样本走 data URI 直传（${(sampleUrl.length / 1024).toFixed(0)}KB body）——若被拒再加 --use-r2`);
}

// Step 3: 逐模型创建音色
const voiceIds = {};
for (const model of MODELS) {
  const short = model.replace('cosyvoice-v3.5-', '');
  console.log(`[probe] 创建音色：target_model=${model} …`);
  const { status, raw } = await postJson(
    `${baseUrl}/services/audio/tts/customization`,
    apiKey,
    { model: 'voice-enrollment', input: { action: 'create_voice', target_model: model, prefix: `probe${short}`, url: sampleUrl } },
  );
  let json;
  try { json = JSON.parse(raw); } catch { fail(`创建音色响应非 JSON（HTTP ${status}）：${raw.slice(0, 300)}`); }
  const voiceId = json?.output?.voice_id;
  if (status !== 200 || !voiceId) {
    fail(`创建音色失败（HTTP ${status}）：${raw.slice(0, 300)}`);
  }
  voiceIds[model] = voiceId;
  console.log(`[probe] ✓ ${model} → voice_id=${voiceId}`);
}

// Step 4: 逐音色 SSE 流式合成（带字级时间戳）
console.log(`[probe] 合成文本 ${Array.from(text).length} 字，开始逐音色流式合成…`);
const summary = [];
for (const model of MODELS) {
  const short = model.replace('cosyvoice-v3.5-', '');
  const voice = voiceIds[model];
  const { status, raw } = await postJson(
    `${baseUrl}/services/audio/tts/SpeechSynthesizer`,
    apiKey,
    {
      model,
      input: { text, voice, format: 'mp3', sample_rate: 24000, word_timestamp_enabled: true },
    },
    { 'X-DashScope-SSE': 'enable' },
  );
  if (status !== 200) fail(`合成失败（${model}，HTTP ${status}）：${raw.slice(0, 300)}`);

  // SSE：事件以空行分隔，每个事件一行 "data:{...}"
  const audioChunks = [];
  // sentence-synthesis 事件会重复携带当前句的完整 words 数组——
  // 以「句index:字begin_index」去重，否则 95 字会收进数百条重复字戳。
  const wordMap = new Map();
  let sawStop = false;
  let eventCount = 0;
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const dataLine = block.split(/\r?\n/).find((l) => l.startsWith('data:'));
    if (!dataLine) continue;
    let evt;
    try { evt = JSON.parse(dataLine.slice(5)); } catch { continue; }
    eventCount++;
    const out = evt.output ?? {};
    if (typeof out?.audio?.data === 'string' && out.audio.data.length > 0) {
      audioChunks.push(Buffer.from(out.audio.data, 'base64'));
    }
    if (Array.isArray(out?.sentence?.words)) {
      const sentIdx = typeof out.sentence.index === 'number' ? out.sentence.index : 0;
      for (const w of out.sentence.words) {
        if (w?.text && typeof w.begin_time === 'number' && typeof w.end_time === 'number') {
          wordMap.set(`${sentIdx}:${w.begin_index ?? wordMap.size}`, {
            word: w.text, startSec: w.begin_time / 1000, endSec: w.end_time / 1000,
          });
        }
      }
    }
    if (out.finish_reason === 'stop') sawStop = true;
  }
  const words = [...wordMap.entries()]
    .sort((a, b) => {
      const [sa, ia] = a[0].split(':').map(Number);
      const [sb, ib] = b[0].split(':').map(Number);
      return sa - sb || ia - ib;
    })
    .map(([, w]) => w);
  if (audioChunks.length === 0) fail(`合成无音频（${model}）。事件数=${eventCount}，首事件：${raw.slice(0, 300)}`);
  if (!sawStop) fail(`合成缺结束帧（${model}，finish_reason≠stop）——音频可能被截断`);

  const audio = Buffer.concat(audioChunks);
  const outPath = join(OUT_DIR, `cosyvoice-${short}-probe.mp3`);
  writeFileSync(outPath, audio);

  // 字级时间戳校验：非空、单调递增
  if (words.length === 0) fail(`✗ ${model} 未返回字级时间戳（字幕链路硬约束不满足）`);
  let monotonic = true;
  for (let i = 1; i < words.length; i++) {
    if (words[i].startSec < words[i - 1].startSec) { monotonic = false; break; }
  }
  const lastEnd = words[words.length - 1].endSec;
  summary.push({ model, voice, outPath, bytes: audio.length, words: words.length, lastEnd, monotonic });
  console.log(`[probe] ✓ ${model}：${audioChunks.length} 块音频 ${(audio.length / 1024).toFixed(0)}KB → ${outPath}`);
  console.log(`        字级时间戳 ${words.length} 个，末词 ${lastEnd.toFixed(2)}s，单调递增=${monotonic}`);
}

// 清理临时文件
rmSync(tmpDir, { recursive: true, force: true });

// Step 5: 汇总
console.log('\n[probe] ── 对比汇总 ─────────────────────────────');
for (const s of summary) {
  console.log(`  ${s.model}\n    voice_id=${s.voice}\n    产物=${s.outPath}（${(s.bytes / 1024).toFixed(0)}KB）字戳=${s.words} 末词=${s.lastEnd.toFixed(2)}s`);
}
console.log('[probe] 提示：两个测试音色留在百炼账号中（配额 1000，免费），可复测；如需删除可用 voice-enrollment 的 delete_voice。');
console.log('[probe] ✓ 全链路通过 —— 请盲听两个 mp3 对比克隆质量');
