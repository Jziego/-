import { getAvatarProviderName, hasAvatarProvider } from "@/lib/env";
import type { AvatarProvider } from "@/lib/services/avatar-provider";
import { createHeyGenProvider } from "@/lib/services/providers/heygen";
import { createMockProvider } from "@/lib/services/providers/mock";

/**
 * Factory: returns the appropriate AvatarProvider based on environment config.
 *
 * - AVATAR_PROVIDER="heygen" + AVATAR_PROVIDER_API_KEY set → HeyGen
 * - Otherwise → Mock (safe no-op fallback)
 */
export function createProviderFromEnv(): AvatarProvider {
  if (hasAvatarProvider()) {
    const name = (getAvatarProviderName() ?? "").toLowerCase();
    if (name === "heygen") {
      return createHeyGenProvider();
    }
    // Future providers: d-id, tavus, synthesia
  }

  return createMockProvider();
}
