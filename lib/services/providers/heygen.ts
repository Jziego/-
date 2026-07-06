import {
  getAvatarProviderApiKey,
  getHeygenAvatarTemplateId,
  getHeygenVoiceId,
  getHeygenPollIntervalMs,
  getHeygenPollMaxAttempts,
} from "@/lib/env";
import { putObjectFromBuffer } from "@/lib/storage";
import type { AvatarProvider } from "@/lib/services/avatar-provider";

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

    async generateTalkingHead(input: {
      providerAvatarId: string;
      providerVoiceId?: string;
      scriptText: string;
    }) {
      // 1. Create the video (async) via v3.
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

      // 2. Poll for completion (async rendering).
      const intervalMs = getHeygenPollIntervalMs();
      const maxAttempts = getHeygenPollMaxAttempts();
      let status: VideoStatusData | undefined;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (attempt > 0) {
          await sleep(intervalMs);
        }
        const pollRes = await heyGenRequest<HeyGenEnvelope<VideoStatusData>>(
          `/v3/videos/${videoId}`,
          "GET",
        );
        status = pollRes.data;
        if (status?.status === "completed") {
          break;
        }
        if (status?.status === "failed") {
          throw new Error(
            `HeyGen video generation failed: ${status.failure_message ?? "unknown error"}`,
          );
        }
      }

      if (status?.status !== "completed" || !status.video_url) {
        throw new Error(
          `HeyGen video generation timed out after ${maxAttempts} attempts`,
        );
      }

      // 3. Download the rendered mp4 and persist a non-expiring copy in our R2.
      const bytes = await downloadVideoBytes(status.video_url);
      const storageKey = `avatars/${videoId}.mp4`;
      await putObjectFromBuffer(storageKey, bytes, "video/mp4");

      return {
        videoAssetId: storageKey,
        durationSeconds: status.duration ?? 15,
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
