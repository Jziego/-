import { describe, expect, it } from "vitest";
import { matchAssetsToScenes } from "@/lib/services/script-match";
import type { ScriptScene } from "@/lib/types";

const scenes: ScriptScene[] = [
  { order: 1, text: "开场", durationSeconds: 4, assetHints: ["门头", "门店环境"], role: "presenter" },
  { order: 2, text: "产品", durationSeconds: 7, assetHints: ["牛肉面"], role: "broll" },
  { order: 3, text: "CTA", durationSeconds: 4, assetHints: ["到店引流"], role: "presenter" },
];

const assets = [
  { assetId: "asset_front", features: ["门头", "门店环境", "招牌"] },
  { assetId: "asset_noodle", features: ["牛肉面", "食物", "热汤"] },
  { assetId: "asset_promo", features: ["到店引流", "优惠"] },
];

describe("matchAssetsToScenes", () => {
  it("matches each scene to the highest-overlap asset and records the tag", () => {
    const out = matchAssetsToScenes(scenes, assets);
    expect(out[0].matchedAssetId).toBe("asset_front");
    expect(out[0].matchTag).toBe("门头");
    expect(out[1].matchedAssetId).toBe("asset_noodle");
    expect(out[1].matchTag).toBe("牛肉面");
    expect(out[2].matchedAssetId).toBe("asset_promo");
  });

  it("sets desiredTags from assetHints", () => {
    const out = matchAssetsToScenes(scenes, assets);
    expect(out[0].desiredTags).toEqual(["门头", "门店环境"]);
  });

  it("returns matchedAssetId null when no asset overlaps", () => {
    const out = matchAssetsToScenes(
      [{ order: 1, text: "x", durationSeconds: 3, assetHints: ["不存在的标签"], role: "broll" }],
      assets,
    );
    expect(out[0].matchedAssetId).toBeNull();
    expect(out[0].matchTag).toBeNull();
  });

  it("spreads to an alternative when two consecutive scenes share the same top asset", () => {
    const two: ScriptScene[] = [
      { order: 1, text: "a", durationSeconds: 3, assetHints: ["牛肉面"], role: "broll" },
      { order: 2, text: "b", durationSeconds: 3, assetHints: ["牛肉面"], role: "broll" },
    ];
    const pool = [
      { assetId: "asset_noodle", features: ["牛肉面"] },
      { assetId: "asset_noodle2", features: ["牛肉面", "其它"] },
    ];
    const out = matchAssetsToScenes(two, pool);
    // 两资产对 hint "牛肉面" 同分(均 1);稳定排序下 scene1 取池中前者
    expect(out[0].matchedAssetId).toBe("asset_noodle");
    // scene2 命中与上一镜相同,改选同分不同候选以分散画面
    expect(out[1].matchedAssetId).toBe("asset_noodle2");
    expect(out[1].matchedAssetId).not.toBe(out[0].matchedAssetId);
  });

  it("returns all null when asset pool is empty", () => {
    const out = matchAssetsToScenes(scenes, []);
    expect(out.every((s) => s.matchedAssetId === null)).toBe(true);
  });
});
