import { describe, it, expect } from "vitest";
import { buildTimeline, resolveCompositionMode, buildAss, resolveSubtitlePreset, buildFilterGraph } from "@/lib/services/video-compose";
import type { TimelineSegment } from "@/lib/services/video-compose";
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

describe("buildAss", () => {
  const segs: TimelineSegment[] = [
    { role: "presenter", startSec: 0, endSec: 4, durationSec: 4, sceneOrder: 1, text: "开场白", assetId: null },
    { role: "broll", startSec: 4, endSec: 11, durationSec: 7, sceneOrder: 2, text: "产品来了", assetId: "a1" }
  ];

  it("emits ASS with one Dialogue line per segment, timestamps from timeline", () => {
    const ass = buildAss(segs, "default");
    expect(ass).toContain("[V4+ Styles]");
    expect(ass).toContain("Style: Default");
    expect(ass).toContain("Dialogue: 0,0:00:00.00,0:00:04.00,Default,,0,0,0,,开场白");
    expect(ass).toContain("Dialogue: 0,0:00:04.00,0:00:11.00,Default,,0,0,0,,产品来了");
  });

  it("uses the Noto Sans CJK SC font (required for Chinese subtitles)", () => {
    expect(buildAss(segs, "default")).toContain("Noto Sans CJK SC");
  });

  it("resolveSubtitlePreset falls back to default for unknown styles", () => {
    expect(resolveSubtitlePreset("bold_bottom")).toBe("bold_bottom");
    expect(resolveSubtitlePreset("unknown")).toBe("default");
    expect(resolveSubtitlePreset(undefined)).toBe("default");
  });
});

describe("buildFilterGraph", () => {
  const segs: TimelineSegment[] = [
    { role: "presenter", startSec: 0, endSec: 4, durationSec: 4, sceneOrder: 1, text: "a", assetId: null },
    { role: "broll", startSec: 4, endSec: 11, durationSec: 7, sceneOrder: 2, text: "b", assetId: "a1" }
  ];

  it("presenter_broll: trims talking-head for presenter, asset for broll, concats, burns subs, mixes bgm", () => {
    const g = buildFilterGraph({
      mode: "presenter_broll",
      segments: segs,
      assetInputIndex: { a1: 1 },
      talkingHeadInputIndex: 0,
      bgmInputIndex: 2,
      assPath: "/tmp/subs.ass",
      width: 1080,
      height: 1920,
      totalDurationSec: 11
    });
    expect(g.filterComplex).toContain("[0:v]trim=start=0:duration=4");
    expect(g.filterComplex).toContain("[1:v]trim=duration=7");
    expect(g.filterComplex).toContain("[v0][v1]concat=n=2:v=1:a=0[vcat]");
    expect(g.filterComplex).toContain("subtitles='/tmp/subs.ass'");
    expect(g.filterComplex).toContain("amix=inputs=2");
    expect(g.mapVideo).toBe("[vsub]");
    expect(g.mapAudio).toBe("[aout]");
  });

  it("asset_only: no talking-head presenter trim, audio from bgm only", () => {
    const g = buildFilterGraph({
      mode: "asset_only",
      segments: [
        { role: "broll", startSec: 0, endSec: 5, durationSec: 5, sceneOrder: 1, text: "x", assetId: "a1" }
      ],
      assetInputIndex: { a1: 0 },
      bgmInputIndex: 1,
      assPath: "/tmp/subs.ass",
      width: 1080,
      height: 1920,
      totalDurationSec: 5
    });
    expect(g.filterComplex).not.toContain("[0:v]trim=start=");
    expect(g.filterComplex).toContain("[0:v]trim=duration=5");
    expect(g.mapAudio).toBe("[abgm]");
  });
});
