#!/usr/bin/env node
/**
 * 火山引擎 AI MediaKit 视频口型对齐 —— 一次性探针脚本（供应商实测用）
 *
 * 用法：
 *   node scripts/probe-lipsync.mjs --video="D:/下载/a.mp4" --audio="D:/下载/b.mp3" --label=baseline
 *   node scripts/probe-lipsync.mjs --video-id="mediakit://xxx" --audio-id="mediakit://yyy" --label=run2 --loop=true
 *
 * 说明：
 * - 密钥从 C:\Users\Administrator\Desktop\API.txt 读取（可用 MEDIKIT_KEY_FILE 覆盖），脚本不打印密钥
 * - 本地上传走官方 mediakit:// 机制（申请上传地址 → PUT 二进制 → 得 file_id），file_id 30 天有效可复用
 * - 产物下载到 D:\下载\lipsync-{label}.mp4（结果链接官方只保留 24 小时）
 * - 计费按输出时长 ¥1/分钟，单次 30 秒测试 ≈ ¥0.5
 */

import { readFileSync, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const BASE = 'https://mediakit.cn-beijing.volces.com';
const KEY_FILE = process.env.MEDIKIT_KEY_FILE || 'C:/Users/Administrator/Desktop/API.txt';
const OUT_DIR = process.env.PROBE_OUT_DIR || 'D:/下载';
const POLL_INTERVAL_MS = 15_000;
const POLL_TIMEOUT_MS = 40 * 60_000; // 官方 RTF≈6-8，30 秒音频约 3-4 分钟，留足队列余量

// ---------- 参数 ----------
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/s);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), 'true'];
  })
);
const { video, audio, label = `run${Date.now()}`, loop = 'false' } = args;
let { 'video-id': videoId, 'audio-id': audioId } = args;

if ((!video && !videoId) || (!audio && !audioId)) {
  console.error('缺少参数：需要 --video / --audio（本地路径）或 --video-id / --audio-id（mediakit:// file_id）');
  process.exit(2);
}

// ---------- 密钥 ----------
const apiKey = readFileSync(KEY_FILE, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
if (!apiKey) {
  console.error(`密钥文件为空：${KEY_FILE}`);
  process.exit(2);
}
console.log(`[probe] 已读取密钥（长度 ${apiKey.length}，内容不显示）`);

const authHeaders = { Authorization: `Bearer ${apiKey}` };

// ---------- HTTP 助手 ----------
async function apiCall(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${res.status} 非 JSON 响应：${text.slice(0, 500)}`);
  }
  if (!res.ok || json.success === false) {
    const err = json?.error ? ` code=${json.error.code} type=${json.error.type} param=${json.error.param ?? '-'} msg=${json.error.message}` : '';
    throw new Error(`API 调用失败 HTTP ${res.status}${err} | 原始响应(截断500): ${text.slice(0, 500)}`);
  }
  return json;
}

// ---------- 上传 ----------
const MIME = {
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
};

async function uploadLocalFile(filePath) {
  const ext = extname(filePath).toLowerCase();
  const contentType = MIME[ext];
  if (!contentType) throw new Error(`不支持的文件类型 ${ext}（支持：${Object.keys(MIME).join('/')}）`);
  const size = (await stat(filePath)).size;
  console.log(`[upload] ${basename(filePath)}（${(size / 1024 / 1024).toFixed(1)}MB）申请上传地址…`);

  const apply = await apiCall('POST', `${BASE}/api/v1/tools-sync/request-media-upload-url`, {});
  const { file_id: fileId, upload_url: uploadUrl, upload_headers: extraHeaders = [] } = apply.result;
  console.log(`[upload] 获得 file_id：${fileId.slice(0, 32)}…（30 天内可复用）`);

  const data = readFileSync(filePath);
  const headers = { 'Content-Type': contentType };
  for (const h of extraHeaders) {
    if (h && h.key) headers[h.key] = h.value;
  }
  const res = await fetch(uploadUrl, { method: 'PUT', headers, body: data, signal: AbortSignal.timeout(10 * 60_000) });
  if (!(res.status >= 200 && res.status < 300)) {
    const text = await res.text().catch(() => '');
    throw new Error(`上传失败 HTTP ${res.status}：${text.slice(0, 300)}`);
  }
  console.log(`[upload] 上传成功 HTTP ${res.status}`);
  return fileId;
}

// ---------- 主流程 ----------
const t0 = Date.now();
try {
  if (!videoId) videoId = await uploadLocalFile(video);
  else console.log(`[probe] 复用 video_id：${videoId.slice(0, 40)}…`);
  if (!audioId) audioId = await uploadLocalFile(audio);
  else console.log(`[probe] 复用 audio_id：${audioId.slice(0, 40)}…`);

  const enableLoop = loop === 'true';
  console.log(`[submit] 提交对口型任务（enable_video_loop=${enableLoop}）…`);
  const submitted = await apiCall('POST', `${BASE}/api/v1/tools/lip-sync`, {
    video_url: videoId,
    audio_url: audioId,
    enable_video_loop: enableLoop,
  });
  const taskId = submitted.task_id;
  console.log(`[submit] task_id=${taskId}`);
  console.log(`[probe] ★ 复用凭证（下次可跳过上传）：--video-id="${videoId}" --audio-id="${audioId}"`);

  let lastStatus = '';
  while (true) {
    if (Date.now() - t0 > POLL_TIMEOUT_MS) throw new Error('轮询超时（40 分钟），请拿 task_id 手动查询');
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const info = await apiCall('GET', `${BASE}/api/v1/tasks/${taskId}`);
    if (info.status !== lastStatus) {
      console.log(`[poll] 状态：${info.status}（已等 ${Math.round((Date.now() - t0) / 1000)}s）`);
      lastStatus = info.status;
    }
    if (info.status === 'failed') {
      const e = info.error || {};
      throw new Error(`任务失败 code=${e.code} msg=${e.message} param=${e.param ?? '-'}`);
    }
    if (info.status === 'completed') {
      const { video_url: videoUrl, duration } = info.result || {};
      console.log(`[done] 输出时长 ${duration}s，结果链接有效期至 ${new Date((info.expires_at || 0) * 1000).toLocaleString('zh-CN')}`);
      const outPath = join(OUT_DIR, `lipsync-${label}.mp4`);
      const res = await fetch(videoUrl, { signal: AbortSignal.timeout(10 * 60_000) });
      if (!res.ok || !res.body) throw new Error(`下载产物失败 HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body), createWriteStream(outPath));
      console.log(`[done] 已下载 → ${outPath}（总耗时 ${Math.round((Date.now() - t0) / 1000)}s）`);
      break;
    }
  }
} catch (err) {
  console.error(`[probe] ✗ ${err.message}`);
  process.exit(1);
}
