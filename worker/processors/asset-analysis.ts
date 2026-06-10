import { classifyAsset } from "@/lib/services/assets";
import { getAssetRepository, getAssetAnalysisRepository, getStoreRepository } from "@/lib/repositories";
import type { ProcessorFn } from "./index";

/**
 * asset_analysis processor — runs rule-based classification on an uploaded asset.
 * Reuses the existing classifyAsset() from lib/services/assets.ts.
 *
 * Expected job payload: { assetId: string }
 */
export const assetAnalysisProcessor: ProcessorFn = async (job) => {
  const { assetId } = job.data.payload as { assetId: string };

  const asset = await getAssetRepository().findById(assetId);
  if (!asset) throw new Error(`Asset not found: ${assetId}`);

  const stores = await getStoreRepository().listByOwner(asset.ownerId);
  const store = stores.find((s) => s.id === asset.storeId);
  if (!store) throw new Error(`Store not found for asset: ${assetId}`);

  const analysis = await classifyAsset({
    asset,
    store,
    visualLabels: asset.tags,
    analysisUnavailable: true
  });

  const created = await getAssetAnalysisRepository().create(analysis);
  return { analysisId: created.id };
};
