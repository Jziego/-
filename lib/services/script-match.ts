import type { ScriptScene } from "@/lib/types";

/** 匹配输入：一个素材的 id + 用于匹配的特征集（来自 AssetAnalysis）。 */
export interface AssetMatchInput {
  assetId: string;
  features: string[];
}

/** 该镜期望的标签：默认取 assetHints（去重）。 */
function sceneDesiredTags(scene: ScriptScene): string[] {
  return [...new Set(scene.assetHints)];
}

/**
 * 为每个分镜挑选特征重叠度最高的素材。
 * - 重叠计数最高者命中；命中标签取第一个重叠特征。
 * - 无任何重叠 → matchedAssetId = null（UI 显示「待匹配」）。
 * - 若命中者与上一镜相同、且存在同分不同候选 → 改选候选以分散画面。
 */
export function matchAssetsToScenes(
  scenes: ScriptScene[],
  assets: AssetMatchInput[],
): ScriptScene[] {
  let prevAssetId: string | null = null;

  return scenes.map((scene) => {
    const desired = sceneDesiredTags(scene);

    const scored = assets
      .map((a) => {
        const overlap = a.features.filter((f) => desired.includes(f));
        return { assetId: a.assetId, score: overlap.length, tag: overlap[0] ?? null };
      })
      .sort((x, y) => y.score - x.score);

    const candidates = scored.filter((s) => s.score > 0);
    const top = candidates[0] ?? null;
    let pick = top;

    if (top && prevAssetId && top.assetId === prevAssetId) {
      const alt = candidates.find((s) => s.assetId !== prevAssetId && s.score === top.score);
      if (alt) pick = alt;
    }

    const matchedAssetId = pick?.assetId ?? null;
    const matchTag = pick?.tag ?? null;
    prevAssetId = matchedAssetId;

    return { ...scene, desiredTags: desired, matchedAssetId, matchTag };
  });
}
