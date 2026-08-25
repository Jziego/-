import { createProviderFromEnv, createAvatarProfile } from "@/lib/services/avatar-provider";
import { isPlatformAvatarId } from "@/lib/services/platform-avatar";
import { getAvatarRepository, getAssetRepository, getStoreRepository } from "@/lib/repositories";
import { nowIso } from "@/lib/ids";
import type { ProcessorFn } from "./index";

/**
 * avatar_generation processor — creates an avatar profile using the configured provider.
 * Falls back to mock provider when no real provider is configured.
 *
 * Expected job payload: { avatarProfileId?: string, avatarProfileIds?: string[], fallbackMode: string }
 */
export const avatarGenerationProcessor: ProcessorFn = async (job) => {
  const payload = job.data.payload as {
    avatarProfileId?: string;
    avatarProfileIds?: string[];
    fallbackMode?: string;
    trainingVideoAssetId?: string;
  };
  const ownerId = (job.data.ownerId as string) ?? "demo_user";

  // Phase 3：多形象批量校验（planRenderJobs 新契约）。平台公共形象不查库。
  if (Array.isArray(payload.avatarProfileIds)) {
    const ready: string[] = [];
    for (const id of payload.avatarProfileIds) {
      if (isPlatformAvatarId(id)) continue;
      const avatar = await getAvatarRepository().findById(id);
      if (!avatar) {
        throw new Error(`Avatar profile not found: ${id}`);
      }
      ready.push(id);
    }
    return {
      avatarProfileIds: payload.avatarProfileIds,
      trainingStatus: "ready" as const,
      validated: ready
    };
  }

  // If an existing avatar profile ID was provided, look it up and confirm readiness.
  if (payload.avatarProfileId) {
    const avatar = await getAvatarRepository().findById(payload.avatarProfileId);
    if (avatar) {
      return {
        avatarProfileId: avatar.id,
        provider: avatar.provider,
        providerAvatarId: avatar.providerAvatarId,
        providerVoiceId: avatar.providerVoiceId,
        trainingStatus: "ready" as const
      };
    }
  }

  // Create a new avatar profile via the mock provider
  const provider = createProviderFromEnv();

  // Get store context for the avatar
  const assetId = payload.trainingVideoAssetId;
  const asset = assetId ? await getAssetRepository().findById(assetId) : null;

  if (!asset) {
    // No training asset — create a minimal avatar with fallback
    const now = nowIso();
    const avatar = await getAvatarRepository().create({
      id: `avatar_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      ownerId,
      storeId: job.data.projectId ?? "demo_store",
      name: "",
      provider: provider.name,
      providerAvatarId: undefined,
      providerVoiceId: undefined,
      consentStatus: "approved",
      consentAcceptedAt: now,
      trainingStatus: "ready",
      fallbackMode: (payload.fallbackMode as "tts_voiceover") ?? "tts_voiceover",
      createdAt: now,
      updatedAt: now
    });

    return {
      avatarProfileId: avatar.id,
      provider: avatar.provider,
      trainingStatus: "ready",
      fallbackMode: avatar.fallbackMode,
      mode: "fallback_no_training_asset"
    };
  }

  // Get the store for consent context
  const stores = await getStoreRepository().listByOwner(ownerId);
  const store = stores.find((s) => s.id === asset.storeId);

  const profile = await createAvatarProfile({
    ownerId,
    storeId: asset.storeId,
    provider,
    trainingVideoAssetId: asset.id,
    consentAccepted: true
  });

  // Mark training as complete (mock provider is instant)
  profile.trainingStatus = "ready";
  profile.updatedAt = nowIso();

  const saved = await getAvatarRepository().create(profile);

  return {
    avatarProfileId: saved.id,
    provider: saved.provider,
    providerAvatarId: saved.providerAvatarId,
    providerVoiceId: saved.providerVoiceId,
    trainingStatus: "ready",
    fallbackMode: saved.fallbackMode
  };
};
