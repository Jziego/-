import {
  getAvatarProviderApiKey,
  getHeygenAvatarTemplateId,
  getHeygenVoiceId,
  getHeygenPollIntervalMs,
  getHeygenPollMaxAttempts,
} from "@/lib/env";
import { createId } from "@/lib/ids";
import { putObjectFromBuffer } from "@/lib/storage";
import type {
  AvatarProvider,
  DigitalTwinStatus,
  WordTimestamp,
} from "@/lib/services/avatar-provider";

const HEYGEN_BASE_URL = "https://api.heygen.com";
const REQUEST_TIMEOUT_MS = 30_000;

// ── HTTP helpers ────────────────────────────────────────────────────────────

interface HeyGenEnvelope<T> {
  data?: T;
  error?: { message: string };
}

/**
 * Authenticated call to the HeyGen REST API. Supports GET (status checks) and
 * POST (create video, list endpoints). Every call carries the X-Api-Key header
 * and a 30s abort timeout so a hung request can never block the worker forever.
 */
async function heyGenRequest<T>(
  path: string,
  method: "GET" | "POST",
  body?: Record<string, unknown>,
): Promise<T> {
  const apiKey = getAvatarProviderApiKey();
  if (!apiKey) {
    throw new Error("AVATAR_PROVIDER_API_KEY is not configured");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(`${HEYGEN_BASE_URL}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": apiKey,
      },
      body: method === "POST" && body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HeyGen API ${res.status}: ${text.slice(0, 200)}`);
    }

    return (await res.json()) as T;
  } catch (error) {
    clearTimeout(timer);
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`HeyGen API timeout after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw error;
  }
}

/** Download the rendered video bytes from a (presigned) video_url. */
async function downloadVideoBytes(url: string): Promise<Uint8Array> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      throw new Error(`HeyGen video download failed: ${res.status}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  } catch (error) {
    clearTimeout(timer);
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`HeyGen video download timeout after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw error;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Types ───────────────────────────────────────────────────────────────────

interface CreateVideoData {
  video_id?: string;
}

interface VideoStatusData {
  status?: "pending" | "processing" | "completed" | "failed";
  video_url?: string;
  duration?: number;
  failure_message?: string;
}

interface AvatarLook {
  id?: string;
  voice_id?: string;
}

interface VoiceItem {
  voice_id?: string;
}

interface ResolvedAvatar {
  providerAvatarId: string;
  providerVoiceId?: string;
}

interface TalkingHeadInput {
  providerAvatarId: string;
  providerVoiceId?: string;
  scriptText: string;
}

// ── Talking-head pipeline (split into stages for clarity + progress hooks) ──

/** Stage 1: create the async video task, return its id. */
async function createHeygenVideo(input: TalkingHeadInput): Promise<string> {
  const createBody: Record<string, unknown> = {
    type: "avatar",
    avatar_id: input.providerAvatarId,
    script: input.scriptText,
    title: `avatar-${input.providerAvatarId}`,
    resolution: "1080p",
    aspect_ratio: "9:16",
  };
  if (input.providerVoiceId) {
    createBody.voice_id = input.providerVoiceId;
  }

  const createRes = await heyGenRequest<HeyGenEnvelope<CreateVideoData>>(
    "/v3/videos",
    "POST",
    createBody,
  );
  if (createRes.error) {
    throw new Error(`HeyGen create failed: ${createRes.error.message}`);
  }
  const videoId = createRes.data?.video_id;
  if (!videoId) {
    throw new Error("HeyGen create returned no video_id");
  }
  return videoId;
}

/**
 * Stage 2: poll until the video completes. Calls `onProgress(attempt, max)`
 * before each poll so the worker can report progress. Throws on `failed`
 * status or when `maxAttempts` is exhausted without completion.
 */
async function pollHeygenVideo(
  videoId: string,
  onProgress?: (attempt: number, maxAttempts: number) => void,
): Promise<VideoStatusData> {
  const intervalMs = getHeygenPollIntervalMs();
  const maxAttempts = getHeygenPollMaxAttempts();
  let status: VideoStatusData | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    onProgress?.(attempt + 1, maxAttempts);
    if (attempt > 0) {
      await sleep(intervalMs);
    }
    const pollRes = await heyGenRequest<HeyGenEnvelope<VideoStatusData>>(
      `/v3/videos/${videoId}`,
      "GET",
    );
    status = pollRes.data;
    if (status?.status === "completed") {
      return status;
    }
    if (status?.status === "failed") {
      throw new Error(
        `HeyGen video generation failed: ${status.failure_message ?? "unknown error"}`,
      );
    }
  }
  throw new Error(`HeyGen video generation timed out after ${maxAttempts} attempts`);
}

// ── Provider ────────────────────────────────────────────────────────────────

export function createHeyGenProvider(): AvatarProvider {
  return {
    name: "heygen",

    async createAvatar() {
      const templateId = getHeygenAvatarTemplateId();
      if (templateId) {
        return {
          providerAvatarId: templateId,
          providerVoiceId: getHeygenVoiceId(),
        };
      }

      // No template configured — resolve a public stock avatar once and cache.
      return resolvePublicAvatar();
    },

    async generateTalkingHead(input: TalkingHeadInput, onProgress?) {
      // Workspace template overrides the profile's ids: an avatar profile may
      // carry a stale mock id ("provider_avatar_*") from an earlier mock-provider
      // run, which HeyGen rejects with 404 avatar_not_found. The configured
      // template is the authoritative workspace avatar/voice when set.
      const templateAvatarId = getHeygenAvatarTemplateId();
      const templateVoiceId = getHeygenVoiceId();
      const videoId = await createHeygenVideo({
        ...input,
        providerAvatarId: templateAvatarId ?? input.providerAvatarId,
        providerVoiceId: templateVoiceId ?? input.providerVoiceId,
      });
      const status = await pollHeygenVideo(videoId, onProgress);
      if (!status.video_url) {
        throw new Error("HeyGen completed but returned no video_url");
      }

      // Stage 3: download the rendered mp4 and persist a non-expiring copy in our R2.
      const bytes = await downloadVideoBytes(status.video_url);
      const storageKey = `avatars/${videoId}.mp4`;
      await putObjectFromBuffer(storageKey, bytes, "video/mp4");

      return {
        videoAssetId: storageKey,
        durationSeconds: status.duration ?? 15,
      };
    },

    async createDigitalTwin(input) {
      const createRes = await heyGenRequest<HeyGenEnvelope<{ group_id?: string; avatar_group_id?: string; id?: string }>>(
        "/v3/avatars",
        "POST",
        { type: "digital_twin", name: input.name, video_url: input.footageUrl },
      );
      const groupId = createRes.data?.group_id ?? createRes.data?.avatar_group_id ?? createRes.data?.id;
      if (!groupId) throw new Error("HeyGen digital_twin create returned no group id");
      const { consentUrl } = await requestConsentUrl(groupId);
      return { groupId, consentUrl };
    },

    async refreshConsent(input) {
      return requestConsentUrl(input.groupId);
    },

    async getDigitalTwinStatus(input) {
      const res = await heyGenRequest<HeyGenEnvelope<HeyGenAvatarGroup>>(
        `/v3/avatar_groups/${input.groupId}`,
        "GET",
      );
      return normalizeGroupStatus(res.data ?? {});
    },

    async synthesizeSpeech(input) {
      const res = await heyGenRequest<HeyGenEnvelope<HeyGenSpeechData>>(
        "/v3/voices/speech",
        "POST",
        { voice_id: input.providerVoiceId, text: input.text },
      );
      const data = res.data;
      if (!data?.audio_url) throw new Error("HeyGen TTS returned no audio_url");
      const bytes = await downloadVideoBytes(data.audio_url); // 同一下载器（带超时）
      const storageKey = `voices/${createId("tts")}.mp3`;
      await putObjectFromBuffer(storageKey, bytes, "audio/mpeg");
      return {
        audioStorageKey: storageKey,
        durationSeconds: data.duration ?? 0,
        words: normalizeWordTimestamps(data.word_timestamps ?? [], data.duration ?? 0),
      };
    },
  };
}

// ── Public avatar resolution (used when no HEYGEN_AVATAR_TEMPLATE_ID) ────────

let publicAvatarCache: ResolvedAvatar | null = null;

/**
 * Best-effort resolution of a public stock avatar so the pipeline can run
 * end-to-end without a pre-created avatar. Shape of the HeyGen list responses
 * may vary; on any mismatch this falls through to an actionable error pointing
 * the operator at HEYGEN_AVATAR_TEMPLATE_ID. The happy path (template set) is
 * the recommended production configuration.
 */
async function resolvePublicAvatar(): Promise<ResolvedAvatar> {
  if (publicAvatarCache) {
    return publicAvatarCache;
  }

  const configuredVoice = getHeygenVoiceId();

  try {
    const looksRes = await heyGenRequest<HeyGenEnvelope<{ looks?: AvatarLook[] }>>(
      "/v3/avatars/looks?avatar_type=photo_avatar&ownership=public",
      "GET",
    );
    const look = looksRes.data?.looks?.find((l) => l.id);
    if (look?.id) {
      const voiceId = configuredVoice ?? look.voice_id ?? (await resolveDefaultVoice());
      publicAvatarCache = {
        providerAvatarId: look.id,
        providerVoiceId: voiceId,
      };
      return publicAvatarCache;
    }
  } catch {
    // fall through to actionable error
  }

  throw new Error(
    "No HeyGen avatar configured. Set HEYGEN_AVATAR_TEMPLATE_ID (and optionally " +
      "HEYGEN_VOICE_ID) to a real avatar from your HeyGen workspace, or ensure public " +
      "stock avatars are reachable with your API key.",
  );
}

async function resolveDefaultVoice(): Promise<string | undefined> {
  try {
    const voicesRes = await heyGenRequest<HeyGenEnvelope<{ voices?: VoiceItem[] }>>(
      "/v1/voice.list",
      "GET",
    );
    return voicesRes.data?.voices?.find((v) => v.voice_id)?.voice_id;
  } catch {
    return undefined;
  }
}

// ── Digital twin (Phase 3) ──────────────────────────────────────────────────

interface HeyGenAvatarGroup {
  consent_status?: string;
  status?: string;
  reject_reason?: string;
  error?: string;
  looks?: { id?: string }[];
  look_id?: string;
  voice_id?: string;
  consent_url?: string;
  url?: string;
}

interface HeyGenSpeechData {
  audio_url?: string;
  duration?: number;
  word_timestamps?: { word?: string; start?: number; end?: number }[];
}

async function requestConsentUrl(groupId: string): Promise<{ consentUrl: string }> {
  const res = await heyGenRequest<HeyGenEnvelope<{ url?: string; consent_url?: string }>>(
    `/v3/avatars/${groupId}/consent`,
    "POST",
    {},
  );
  const url = res.data?.url ?? res.data?.consent_url;
  if (!url) throw new Error("HeyGen consent endpoint returned no url");
  return { consentUrl: url };
}

/** HeyGen group 原始字段 → 归一化状态机。未知/进行中的状态保守映射为 pending/processing。 */
function normalizeGroupStatus(data: HeyGenAvatarGroup): DigitalTwinStatus {
  const consentRaw = (data.consent_status ?? "").toLowerCase();
  const consentStatus =
    consentRaw === "approved" || consentRaw === "completed" || consentRaw === "success"
      ? "approved"
      : consentRaw === "rejected" || consentRaw === "denied" || consentRaw === "failed"
        ? "rejected"
        : consentRaw === "expired"
          ? "expired"
          : "awaiting_user";

  const statusRaw = (data.status ?? "").toLowerCase();
  const failed = statusRaw === "failed" || statusRaw === "error";
  const ready = statusRaw === "completed" || statusRaw === "ready" || statusRaw === "success";
  const trainingStatus =
    consentStatus === "rejected" || consentStatus === "expired" || failed
      ? "failed"
      : ready
        ? "ready"
        : consentStatus === "approved"
          ? "processing"
          : "pending";

  return {
    consentStatus,
    trainingStatus,
    providerAvatarId: data.looks?.find((l) => l.id)?.id ?? data.look_id,
    providerVoiceId: data.voice_id,
    reason: data.reject_reason ?? data.error,
    consentUrl: data.consent_url ?? data.url,
  };
}

/**
 * word_timestamps 归一化为秒。Task 0 Step 4 确认单位：若 HeyGen 返回毫秒
 * （end 远超 duration），按 /1000 处理；中文粒度按字/按词均可——消费端按句对齐。
 */
function normalizeWordTimestamps(
  raw: { word?: string; start?: number; end?: number }[],
  durationSec: number,
): WordTimestamp[] {
  const parsed = raw
    .filter((w): w is { word: string; start: number; end: number } =>
      Boolean(w.word) && typeof w.start === "number" && typeof w.end === "number")
    .map((w) => ({ word: w.word, start: w.start, end: w.end }));
  const looksLikeMs = parsed.some((w) => w.end > durationSec * 10 + 1);
  const scale = looksLikeMs ? 0.001 : 1;
  return parsed.map((w) => ({ word: w.word, startSec: w.start * scale, endSec: w.end * scale }));
}
