import { describe, it, expect } from "vitest";
import { buildTimeline, resolveCompositionMode } from "@/lib/services/video-compose";
import type { Asset, ScriptScene, VideoOutput } from "@/lib/types";

const scenes: ScriptScene[] = [
  { order: 1, text: "开场", durationSeconds: 4, assetHints: ["门店"], role: "presenter" },
  { order: 2, text: "产品", durationSeconds: 7, assetHints: ["招牌产品"], role: "broll" },
  { order: 3, text: "CTA", durationSeconds: 4, assetHints: ["促销"], role: "presenter" }
];

function asset(id: string, tags: string[] = [], businessTags: string[] = []): Asset {
  return { id, tags, businessTags } as unknown as Asset;
}

const assets: Asset[] = [asset("a1", ["招牌产品"]), asset("a2", [], ["门店"])];

describe("video-compose", () => {
  it("accumulates scene durations into [start,end] windows", () => {
    const tl = buildTimeline({ scenes, assets, selectedAssetIds: ["a1", "a2"] });
    expect(tl).toHaveLength(3);
    expect(tl[0]).toMatchObject({ startSec: 0, endSec: 4, durationSec: 4 });
    expect(tl[1]).toMatchObject({ startSec: 4, endSec: 11, durationSec: 7 });
    expect(tl[2]).toMatchObject({ startSec: 11, endSec: 15, durationSec: 4 });
  });

  it("resolves an asset for broll via hint intersection, null for presenter", () => {
    const tl = buildTimeline({ scenes, assets, selectedAssetIds: ["a1", "a2"] });
    expect(tl[0]?.assetId).toBeNull(); // presenter
    expect(tl[1]?.assetId).toBe("a1"); // broll: "招牌产品" matches a1.tags
    expect(tl[2]?.assetId).toBeNull(); // presenter
  });

  it("falls back to round-robin selectedAssetIds when no hint matches", () => {
    const noMatch: ScriptScene[] = [
      { order: 1, text: "x", durationSeconds: 4, assetHints: ["不存在"], role: "broll" }
    ];
    const tl = buildTimeline({ scenes: noMatch, assets, selectedAssetIds: ["a1"] });
    expect(tl[0]?.assetId).toBe("a1");
  });

  it("resolveCompositionMode returns presenter_broll when talking-head exists, else asset_only", () => {
    expect(resolveCompositionMode({ kind: "talking_head" } as VideoOutput)).toBe(
      "presenter_broll"
    );
    expect(resolveCompositionMode(null)).toBe("asset_only");
  });
});
