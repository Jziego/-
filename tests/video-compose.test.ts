import { describe, it, expect } from "vitest";
import { buildTimeline, resolveCompositionMode, buildAss, resolveSubtitlePreset, buildFilterGraph } from "@/lib/services/video-compose";
import type { TimelineSegment } from "@/lib/services/video-compose";
import type { Asset, ScriptScene, VideoOutput } from "@/lib/types";

describe("video-compose buildTimeline", () => {
  const scenes: ScriptScene[] = [
    { order: 1, text: "开场", durationSeconds: 4, assetHints: ["门店"], role: "presenter" },
    { order: 2, text: "产品", durationSeconds: 7, assetHints: ["招牌产品"], role: "broll" },
    { order: 3, text: "CTA", durationSeconds: 4, assetHints: ["促销"], role: "presenter" }
  ];
  const assets: Asset[] = [
    { id: "a1", type: "video", tags: [], businessTags: [] } as unknown as Asset,
    { id: "a2", type: "image", tags: [], businessTags: [] } as unknown as Asset,
    { id: "a3", type: "video", tags: [], businessTags: [] } as unknown as Asset
  ];

  it("presenter mode: every selected asset gets its own broll segment", () => {
    const { segments } = buildTimeline({
      scenes, assets, selectedAssetIds: ["a1", "a2", "a3"],
      assetDurations: { a1: 5, a3: 8 }, talkingHeadDurationSec: 20
    });
    const brollAssetIds = segments.filter((s) => s.role === "broll").map((s) => s.assetId);
    expect(brollAssetIds).toEqual(["a1", "a2", "a3"]);
  });

  it("presenter mode: total equals talking-head duration and segments are contiguous", () => {
    const { segments, totalDurationSec } = buildTimeline({
      scenes, assets, selectedAssetIds: ["a1", "a2", "a3"],
      assetDurations: { a1: 5, a3: 8 }, talkingHeadDurationSec: 20
    });
    const sum = segments.reduce((acc, s) => acc + s.durationSec, 0);
    expect(Math.abs(sum - totalDurationSec)).toBeLessThan(0.05);
    expect(totalDurationSec).toBeCloseTo(20, 1);
    expect(segments[0]?.startSec).toBe(0);
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i]?.startSec).toBeCloseTo(segments[i - 1]?.endSec ?? -1, 5);
    }
    expect(segments[0]?.role).toBe("presenter");
    expect(segments[segments.length - 1]?.role).toBe("presenter");
  });

  it("presenter mode: video asset is capped at real duration and scales down when content exceeds the voiceover", () => {
    // Scale-up never happens (total <= contentTotal), so a3 never exceeds its real 8s.
    const capped = buildTimeline({
      scenes, assets, selectedAssetIds: ["a3"],
      assetDurations: { a3: 8 }, talkingHeadDurationSec: 40
    });
    const a3c = capped.segments.find((s) => s.assetId === "a3");
    expect(a3c?.durationSec).toBeLessThanOrEqual(8 + 0.01);

    // TH(8) < contentTotal(4+8+4=16) -> scale 0.5 -> a3 halves to ~4.
    const shrunk = buildTimeline({
      scenes, assets, selectedAssetIds: ["a3"],
      assetDurations: { a3: 8 }, talkingHeadDurationSec: 8
    });
    const a3s = shrunk.segments.find((s) => s.assetId === "a3");
    expect(a3s?.durationSec).toBeLessThan(8);
    expect(a3s?.durationSec).toBeCloseTo(4, 1);
  });

  it("presenter mode: shrinks total when content cannot fill the voiceover (no freeze)", () => {
    const { totalDurationSec } = buildTimeline({
      scenes, assets, selectedAssetIds: ["a1", "a2"],
      assetDurations: { a1: 5 }, talkingHeadDurationSec: 30
    });
    expect(totalDurationSec).toBeLessThan(30);
    expect(totalDurationSec).toBeGreaterThan(0);
  });

  it("presenter mode: total never exceeds talking-head duration even with many assets (no floor drift)", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      id: `v${i}`, type: "video" as const, tags: [], businessTags: []
    })) as unknown as Asset[];
    const durations = Object.fromEntries(many.map((a) => [a.id, 10]));
    const { segments, totalDurationSec } = buildTimeline({
      scenes, assets: many, selectedAssetIds: many.map((a) => a.id),
      assetDurations: durations, talkingHeadDurationSec: 1
    });
    // contentTotal (~308s) >> TH(1s). With the OLD 0.1s floor this would be ~3.2s
    // (30 video beats floored to 0.1); without the floor, total clamps to <= 1s.
    expect(totalDurationSec).toBeLessThanOrEqual(1 + 0.01);
    const sum = segments.reduce((acc, s) => acc + s.durationSec, 0);
    expect(Math.abs(sum - totalDurationSec)).toBeLessThan(0.05);
  });

  it("returns empty segments when no assets and no scenes", () => {
    const { segments, totalDurationSec } = buildTimeline({
      scenes: [], assets: [], selectedAssetIds: [], talkingHeadDurationSec: 10
    });
    expect(segments).toEqual([]);
    expect(totalDurationSec).toBe(0);
  });

  it("asset_only mode: no talking-head → all assets appear, presenter scenes are not black", () => {
    const { segments } = buildTimeline({
      scenes, assets, selectedAssetIds: ["a1", "a2", "a3"],
      assetDurations: { a1: 5, a3: 8 }
    });
    expect(segments.every((s) => s.role === "broll" && s.assetId !== null)).toBe(true);
    expect(segments.map((s) => s.assetId)).toEqual(["a1", "a2", "a3"]);
  });

  it("de-dupes repeated selectedAssetIds and drops ids with no matching asset", () => {
    const { segments } = buildTimeline({
      scenes, assets, selectedAssetIds: ["a1", "missing", "a1", "a2"],
      assetDurations: { a1: 5 }, talkingHeadDurationSec: 20
    });
    const ids = segments.filter((s) => s.role === "broll").map((s) => s.assetId);
    expect(ids).toEqual(["a1", "a2"]);
  });

  it("resolveCompositionMode returns presenter_broll when talking-head exists, else asset_only", () => {
    expect(resolveCompositionMode({ kind: "talking_head" } as VideoOutput)).toBe("presenter_broll");
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

  it("asset_only: a broll beat with a resolved asset never falls back to black color source", () => {
    const g = buildFilterGraph({
      mode: "asset_only",
      segments: [
        { role: "broll", startSec: 0, endSec: 4, durationSec: 4, sceneOrder: 1, text: "x", assetId: "a1" }
      ],
      assetInputIndex: { a1: 0 },
      assPath: "/tmp/subs.ass",
      width: 1080,
      height: 1920,
      totalDurationSec: 4
    });
    expect(g.filterComplex).toContain("[0:v]trim=duration=4");
    expect(g.filterComplex).not.toContain("color=c=black");
  });
});
