import {
  getDoubaoTtsVoice,
  getMediakitApiKey,
  getMediakitBaseUrl,
  getMediakitPollIntervalMs,
  getMediakitPollTimeoutMs,
} from "@/lib/env";
import { createPresignedGetUrl, putObjectFromBuffer } from "@/lib/storage";
import { synthesizeDoubaoSpeech, type DoubaoTtsResult } from "@/lib/services/doubao-tts";
import type {
  AvatarProvider,
  DigitalTwinStatus,
} from "@/lib/services/avatar-provider";

/**
 * 火山引擎「实拍对口型」供应商（MediaKit 视频口型对齐 + 豆包 TTS 2.0 配音）。
 *
 * 与 HeyGen 分身克隆的本质差异：无训练、无槽位、无外部授权流——用户的实拍
 * 口播视频就是"人脸底板"，每次渲染把新文案配音（豆包 TTS）+ 底板视频交给
 * MediaKit 改嘴部，其余像素 100% 保真。因此：
 *  - createDigitalTwin 不调远端，groupId 只是编码 footage storageKey 的本地句柄；
 *  - getDigitalTwinStatus 立即 ready（状态机复用现有轮询端点，~10s 收敛）；
 *  - generateTalkingHead 内部串 TTS → 双 presigned URL → lip-sync 任务 → 转存 R2。
 *
 * 素材传递用 R2 presigned GET（2h 过期，任务分钟级完成，足够）而非 mediakit://
 * file_id（30 天过期，需维护重传状态机）——无状态优先。
 * 探针实证（2026-09-16，scripts/probe-lipsync.mjs）：RTF≈7、并发≥2、9:16 保持、
 * 无可见水印、enable_video_loop=true 时输出时长恒等于音频时长。
 */

const LIPSYNC_GROUP_PREFIX = "lipsync:";
/** presigned URL 有效期：覆盖任务排队+拉取，远超分钟级处理时长。 */
const PRESIGN_TTL_SECONDS = 2 * 3600;
const SUBMIT_TIMEOUT_MS = 60_000;
/** 产物下行预算：45s 成片约 20MB，10 分钟足够。 */
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

export interface LipSyncProviderDeps {
  /** 本 provider 只拉取字符串 URL（MediaKit REST + 产物地址）——窄化签名便于测试注入 mock。 */
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  synthesizeSpeechFn: (input: { text: string; voice?: string }) => Promise<DoubaoTtsResult>;
  presignGet: (storageKey: string, expiresInSec: number) => Promise<string>;
  putObject: (key: string, bytes: Uint8Array, contentType: string) => Promise<unknown>;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  /** 测试注入；缺省读 env。 */
  apiKey?: string;
}

// ── MediaKit 响应形状（文档 6448/2278532 + 探针实证）─────────────────────────
interface MediaKitError {
  code?: string;
  message?: string;
  param?: string;
  type?: string;
}
interface MediaKitSubmitResponse {
  task_id?: string;
  success?: boolean;
  error?: MediaKitError;
}
interface MediaKitTaskResponse {
  status?: "queued" | "running" | "completed" | "failed" | string;
  success?: boolean;
  error?: MediaKitError;
  result?: { video_url?: string; duration?: number };
  expires_at?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createVolcEngineLipSyncProvider(deps?: Partial<LipSyncProviderDeps>): AvatarProvider {
  const fetchImpl = deps?.fetchImpl ?? fetch;
  const synthesize = deps?.synthesizeSpeechFn ?? synthesizeDoubaoSpeech;
  const presignGet = deps?.presignGet ?? createPresignedGetUrl;
  const putObject = deps?.putObject ?? putObjectFromBuffer;
  const pollIntervalMs = deps?.pollIntervalMs ?? getMediakitPollIntervalMs();
  const pollTimeoutMs = deps?.pollTimeoutMs ?? getMediakitPollTimeoutMs();

  function requireApiKey(): string {
    const apiKey = deps?.apiKey ?? getMediakitApiKey();
    if (!apiKey) {
      throw new Error("MEDIKIT_API_KEY is not configured");
    }
    return apiKey;
  }

  /** MediaKit REST 调用：非 2xx 或 success=false 一律抛错（截断原文，防失明）。 */
  async function mediakitCall<T>(method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<T> {
    const res = await fetchImpl(`${getMediakitBaseUrl()}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${requireApiKey()}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
    });
    const text = await res.text();
    let json: MediaKitSubmitResponse & MediaKitTaskResponse;
    try {
      json = JSON.parse(text) as typeof json;
    } catch {
      throw new Error(`MediaKit ${method} ${path} HTTP ${res.status} 非 JSON 响应：${text.slice(0, 300)}`);
    }
    if (!res.ok || json.success === false) {
      const err = json.error;
      const detail = err ? ` code=${err.code ?? "-"} param=${err.param ?? "-"} msg=${err.message ?? "-"}` : "";
      throw new Error(`MediaKit ${method} ${path} 失败 HTTP ${res.status}${detail}`);
    }
    return json as T;
  }

  async function downloadBytes(url: string): Promise<Uint8Array<ArrayBuffer>> {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) {
      throw new Error(`MediaKit 产物下载失败 HTTP ${res.status}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  return {
    name: "volcengine-lipsync",

    /** legacy 模板形象路径不适用于对口型（无平台公共底板可言）。 */
    async createAvatar() {
      throw new Error(
        "volcengine-lipsync 无模板公共形象：平台公共形象依赖 HeyGen 模板（HEYGEN_AVATAR_TEMPLATE_ID），请先创建自己的出镜形象",
      );
    },

    async createDigitalTwin(input) {
      if (!input.footageStorageKey) {
        throw new Error("volcengine-lipsync createDigitalTwin 需要 footageStorageKey（契约误用）");
      }
      // 不调远端：素材在我们 R2 即全部状态。groupId 编码 storageKey 供状态轮询回放。
      return { groupId: `${LIPSYNC_GROUP_PREFIX}${input.footageStorageKey}`, consentUrl: "" };
    },

    async refreshConsent() {
      throw new Error("对口型形象无需授权流程（路由层应先拦截，此为防御性抛错）");
    },

    async getDigitalTwinStatus(input): Promise<DigitalTwinStatus> {
      if (!input.groupId.startsWith(LIPSYNC_GROUP_PREFIX)) {
        // 防御：句柄只可能来自我们的 createDigitalTwin；畸形即数据异常，终态 failed 透出。
        return {
          consentStatus: "approved",
          trainingStatus: "failed",
          reason: "形象数据异常（句柄无法解析），请删除后重新创建",
        };
      }
      const storageKey = input.groupId.slice(LIPSYNC_GROUP_PREFIX.length);
      return {
        consentStatus: "approved",
        trainingStatus: "ready",
        providerAvatarId: storageKey,
        providerVoiceId: getDoubaoTtsVoice(),
      };
    },

    async generateTalkingHead(input, onProgress?) {
      // Stage 1: 文案 → 配音（字级时间戳随音频一起回来）
      const speech = await synthesize({ text: input.scriptText, voice: input.providerVoiceId });

      // Stage 2: 底板 + 音频双 presigned URL → 提交对口型任务
      const [videoUrl, audioUrl] = await Promise.all([
        presignGet(input.providerAvatarId, PRESIGN_TTL_SECONDS),
        presignGet(speech.audioStorageKey, PRESIGN_TTL_SECONDS),
      ]);
      const submitted = await mediakitCall<MediaKitSubmitResponse>("POST", "/api/v1/tools/lip-sync", {
        video_url: videoUrl,
        audio_url: audioUrl,
        // 恒 true：输出时长=音频时长（底板短则镜像循环，长则截断到音频长度）。
        enable_video_loop: true,
      });
      const taskId = submitted.task_id;
      if (!taskId) {
        throw new Error(`MediaKit 对口型提交未返回 task_id：${JSON.stringify(submitted).slice(0, 300)}`);
      }

      // Stage 3: 轮询（RTF≈6-8，15s 间隔起步；进度回调映射给 worker）
      const maxAttempts = Math.max(1, Math.ceil(pollTimeoutMs / pollIntervalMs));
      let task: MediaKitTaskResponse | undefined;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        onProgress?.(attempt + 1, maxAttempts);
        if (attempt > 0) {
          await sleep(pollIntervalMs);
        }
        task = await mediakitCall<MediaKitTaskResponse>("GET", `/api/v1/tasks/${taskId}`);
        if (task.status === "completed") break;
        if (task.status === "failed") {
          const msg = task.error?.message ?? "未知原因";
          throw new Error(`对口型生成失败：${msg}（code=${task.error?.code ?? "-"}）。如提示画面/人脸问题，请按拍摄要求重录底板视频`);
        }
      }
      if (!task || task.status !== "completed") {
        throw new Error(`MediaKit 对口型任务超时（>${Math.round(pollTimeoutMs / 60000)} 分钟未完成），task_id=${taskId}`);
      }
      const resultUrl = task.result?.video_url;
      if (!resultUrl) {
        throw new Error(`MediaKit 任务完成但无 result.video_url：${JSON.stringify(task).slice(0, 300)}`);
      }

      // Stage 4: 产物 24h 有效——立即下载转存 R2
      const bytes = await downloadBytes(resultUrl);
      const storageKey = `avatars/lipsync/${taskId}.mp4`;
      await putObject(storageKey, bytes, "video/mp4");

      return {
        videoAssetId: storageKey,
        // 时长权威来源 MediaKit result.duration；缺失兜底 TTS 音频实测时长（恒等关系见上）。
        durationSeconds: task.result?.duration ?? speech.durationSeconds,
        words: speech.words,
      };
    },

    async synthesizeSpeech(input) {
      return synthesize({ text: input.text, voice: input.providerVoiceId });
    },
  };
}
