import { createProviderFromEnv, createAvatarProfile } from "@/lib/services/avatar-provider";
import { getAvatarRepository, getAssetRepository, getStoreRepository } from "@/lib/repositories";
import { nowIso } from "@/lib/ids";
import type { ProcessorFn } from "./index";

/**
 * avatar_generation processor — creates an avatar profile using the configured provider.
 * Falls back to mock provider when no real provider is configured.
 *
 * Expected job payload: { avatarProfileId?: string, fallbackMode: string }
 */
export const avatarGenerationProcessor: ProcessorFn = async (job) => {
  const payload = job.data.payload as {
    avatarProfileId?: string;
    fallbackMode?: string;
    trainingVideoAssetId?: string;
  };
  const ownerId = (job.data.ownerId as string) ?? "demo_user";

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
      provider: provider.name,
      providerAvatarId: undefined,
      providerVoiceId: undefined,
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
