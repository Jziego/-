import { createId, nowIso } from "@/lib/ids";
import { getAvatarProviderApiKey } from "@/lib/env";
import type { AvatarProvider } from "@/lib/services/avatar-provider";

const HEYGEN_BASE_URL = "https://api.heygen.com";
const REQUEST_TIMEOUT_MS = 30_000;

// ── Helpers ────────────────────────────────────────────────────────────────

async function heyGenFetch<T>(
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const apiKey = getAvatarProviderApiKey();
  if (!apiKey) {
    throw new Error("AVATAR_PROVIDER_API_KEY is not configured");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(`${HEYGEN_BASE_URL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": apiKey,
      },
      body: JSON.stringify(body),
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

// ── Types ──────────────────────────────────────────────────────────────────

interface HeyGenVideoResponse {
  data?: { video_id?: string; duration?: number };
  error?: { message: string };
}

// ── Provider ───────────────────────────────────────────────────────────────

export function createHeyGenProvider(): AvatarProvider {
  return {
    name: "heygen",

    async createAvatar(input: { trainingVideoAssetId: string; ownerId: string }) {
      // Check for pre-configured template avatar (avoids training per request)
      const templateId = process.env.HEYGEN_AVATAR_TEMPLATE_ID;
      if (templateId) {
        return {
          providerAvatarId: templateId,
          providerVoiceId: process.env.HEYGEN_VOICE_ID || undefined,
        };
      }

      // No template — return a placeholder. Full avatar training is async
      // and requires webhook/callback support (future enhancement).
      return {
        providerAvatarId: createId("heygen_avatar"),
        providerVoiceId: createId("heygen_voice"),
      };
    },

    async generateTalkingHead(input: {
      providerAvatarId: string;
      providerVoiceId?: string;
      scriptText: string;
    }) {
      const result = await heyGenFetch<HeyGenVideoResponse>(
        "/v2/video/generate",
        {
          avatar_id: input.providerAvatarId,
          voice_id: input.providerVoiceId,
          text: input.scriptText,
          caption: false,
        },
      );

      if (result.error) {
        throw new Error(
          `HeyGen video generation failed: ${result.error.message}`,
        );
      }

      return {
        videoAssetId: result.data?.video_id ?? createId("heygen_video"),
        durationSeconds: result.data?.duration ?? 15,
      };
    },
  };
}
