import { describe, expect, it } from "vitest";
import {
  buildSegmentedCaptionCues,
  buildSegmentedFilterGraph,
  buildSegmentedTimeline,
} from "@/lib/services/segmented-compose";
import { parseVoiceTrackManifest, type VoiceTrackManifest } from "@/lib/services/voice-track";
import type { Asset } from "@/lib/types";

const videoAsset = (id: string, dur = 6): Asset => ({
  id, ownerId: "o", storeId: "s", type: "video", originalFilename: `${id}.mp4`,
  storageKey: `k/${id}`, mimeType: "video/mp4", sizeBytes: 1,
  tags: [], businessTags: [], status: "ready", category: "material",
  createdAt: new Date().toISOString(), durationSeconds: dur,
});

const manifest: VoiceTrackManifest = {
  version: 1,
  totalDurationSec: 20,
  segments: [
    { index: 0, speakerIndex: 0, onCamera: true, text: "开场白。", videoStorageKey: "avatars/s0.mp4", durationSec: 4 },
    { index: 1, speakerIndex: 0, onCamera: false, text: "介绍产品。", audioStorageKey: "voices/s1.mp3", durationSec: 10,
      words: [{ word: "介绍", startSec: 0, endSec: 1 }, { word: "产品", startSec: 1, endSec: 2 }] },
    { index: 2, speakerIndex: 0, onCamera: true, text: "快来店里。", videoStorageKey: "avatars/s2.mp4", durationSec: 6 },
  ],
};

describe("buildSegmentedTimeline", () => {
  it("onCamera segments keep exact voice durations; broll fills off-camera windows", () => {
    const { segments, totalDurationSec } = buildSegmentedTimeline({
      manifest,
      assets: [videoAsset("a", 6), videoAsset("b", 6)],
      selectedAssetIds: ["a", "b"],
    });
    // 段序：presenter(4s) → broll×? 铺满 10s → presenter(6s)
    expect(segments[0]).toMatchObject({ role: "presenter", durationSec: 4, manifestIndex: 0 });
    const brollWindow = segments.filter((s) => s.role === "broll");
    expect(brollWindow.reduce((acc, s) => acc + s.durationSec, 0)).toBeCloseTo(10, 5);
    expect(segments.at(-1)).toMatchObject({ role: "presenter", durationSec: 6, manifestIndex: 2 });
    expect(totalDurationSec).toBeCloseTo(20, 5);
    // 相邻段首尾相接
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i]!.startSec).toBeCloseTo(segments[i - 1]!.endSec, 5);
    }
  });

  it("broll pool cycles within a long off-camera window and reuses assets", () => {
    const { segments } = buildSegmentedTimeline({
      manifest: { ...manifest, segments: [manifest.segments[1]!], totalDurationSec: 10 },
      assets: [videoAsset("a", 3)],
      selectedAssetIds: ["a"],
    });
    // 3+3+3+1：单素材循环复用，最后一段截断到窗口余量
    const durations = segments.map((s) => s.durationSec);
    expect(durations.reduce((a, b) => a + b, 0)).toBeCloseTo(10, 5);
    expect(segments.length).toBe(4);
    expect(segments.every((s) => s.assetId === "a")).toBe(true);
  });

  it("target beyond voice length appends a broll tail (Phase 1 fill semantics)", () => {
    const { segments, totalDurationSec } = buildSegmentedTimeline({
      manifest: { ...manifest, segments: [manifest.segments[0]!], totalDurationSec: 4 },
      assets: [videoAsset("a", 6)],
      selectedAssetIds: ["a"],
      targetDurationSec: 10,
    });
    expect(totalDurationSec).toBeCloseTo(10, 5);
    expect(segments.at(-1)!.role).toBe("broll");
  });

  it("empty asset pool → black broll beats (never crash)", () => {
    const { segments } = buildSegmentedTimeline({ manifest, assets: [], selectedAssetIds: [] });
    const broll = segments.filter((s) => s.role === "broll");
    expect(broll.length).toBeGreaterThan(0);
    expect(broll.every((s) => s.assetId === null)).toBe(true);
  });
});

describe("buildSegmentedCaptionCues", () => {
  it("emits one cue per manifest segment with exact accumulated boundaries", () => {
    const cues = buildSegmentedCaptionCues(manifest);
    expect(cues).toEqual([
      { startSec: 0, endSec: 4, text: "开场白。" },
      { startSec: 4, endSec: 14, text: "介绍产品。" },
      { startSec: 14, endSec: 20, text: "快来店里。" },
    ]);
  });
});

describe("buildSegmentedFilterGraph", () => {
  it("trims each presenter segment from its own video input and concats per-segment audio", () => {
    const { segments, totalDurationSec } = buildSegmentedTimeline({
      manifest, assets: [videoAsset("a", 6)], selectedAssetIds: ["a"],
    });
    const graph = buildSegmentedFilterGraph({
      segments,
      manifest,
      segmentVideoInputIndex: { 0: 0, 2: 1 },
      segmentAudioInputIndex: { 1: 2 },
      assetInputIndex: { a: 3 },
      assPath: "/tmp/subs.ass",
      width: 1080,
      height: 1920,
      totalDurationSec,
    });
    // 两个 presenter 段分别从 input 0 / 1 trim
    expect(graph.filterComplex).toContain("[0:v]trim=start=0:duration=4");
    expect(graph.filterComplex).toContain("[1:v]trim=start=0:duration=6");
    // 音频：段0 取视频原声、段1 取 TTS 输入、段2 取视频原声 → 三段 concat
    expect(graph.filterComplex).toContain("[0:a]atrim=duration=4");
    expect(graph.filterComplex).toContain("[2:a]atrim=duration=10");
    expect(graph.filterComplex).toContain("[1:a]atrim=duration=6");
    expect(graph.filterComplex).toMatch(/concat=n=3:v=0:a=1\[avoicecat\]/);
    // 字幕烧录 + 映射
    expect(graph.filterComplex).toContain("subtitles=");
    expect(graph.mapVideo).toBe("[vsub]");
  });

  it("TTS-fallback segments take audio from their fallback video input", () => {
    const fbManifest: VoiceTrackManifest = {
      version: 1, totalDurationSec: 5,
      segments: [{ index: 0, speakerIndex: 0, onCamera: false, text: "降级段。", videoStorageKey: "avatars/fb.mp4", durationSec: 5, fellBackToVideo: true }],
    };
    const { segments, totalDurationSec } = buildSegmentedTimeline({
      manifest: fbManifest, assets: [videoAsset("a")], selectedAssetIds: ["a"],
    });
    const graph = buildSegmentedFilterGraph({
      segments, manifest: fbManifest,
      segmentVideoInputIndex: { 0: 0 },
      segmentAudioInputIndex: {},
      assetInputIndex: { a: 1 },
      assPath: "/tmp/s.ass", width: 1080, height: 1920, totalDurationSec,
    });
    expect(graph.filterComplex).toContain("[0:a]atrim=duration=5");
    // 降级段画面仍是 b-roll（onCamera=false），不从 fallback 视频取画面
    const videoPart = graph.filterComplex.split(";").filter((p) => p.includes(":v]trim"));
    expect(videoPart.every((p) => !p.startsWith("[0:v]trim=start=0:duration=5"))).toBe(true);
  });
});

describe("parseVoiceTrackManifest", () => {
  it("accepts a well-formed manifest round-trip", () => {
    expect(parseVoiceTrackManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest);
  });

  it("rejects corrupt payloads with a descriptive error", () => {
    expect(() => parseVoiceTrackManifest(null)).toThrow(/manifest/i);
    expect(() => parseVoiceTrackManifest({ version: 2, segments: [] })).toThrow(/version/);
    expect(() => parseVoiceTrackManifest({ version: 1, segments: "nope" })).toThrow(/segments/);
    expect(() =>
      parseVoiceTrackManifest({ version: 1, segments: [{ index: 0, onCamera: "yes", durationSec: 4 }] }),
    ).toThrow(/onCamera/);
    expect(() =>
      parseVoiceTrackManifest({ version: 1, segments: [{ index: 0, onCamera: true, durationSec: "4" }] }),
    ).toThrow(/durationSec/);
  });

  it("rejects an empty segments array (concat=n=0 would fail far from the root cause)", () => {
    expect(() => parseVoiceTrackManifest({ version: 1, totalDurationSec: 0, segments: [] })).toThrow(
      /segments/,
    );
  });

  it("rejects segments with no media key (silent audio misalignment guard)", () => {
    // 既无 videoStorageKey 又无 audioStorageKey 的段会被下载循环与音频 concat 双双跳过，
    // apad 只在结尾补静音 → 整条音轨静默前移，必须在读端拒绝。
    expect(() =>
      parseVoiceTrackManifest({
        version: 1,
        totalDurationSec: 4,
        segments: [{ index: 0, speakerIndex: 0, onCamera: true, text: "x", durationSec: 4 }],
      }),
    ).toThrow(/segment 0/);
    // fellBackToVideo 却缺 videoStorageKey 同样拒绝，错误带段下标
    expect(() =>
      parseVoiceTrackManifest({
        version: 1,
        totalDurationSec: 9,
        segments: [
          { index: 0, speakerIndex: 0, onCamera: true, text: "x", videoStorageKey: "avatars/s0.mp4", durationSec: 4 },
          { index: 1, speakerIndex: 0, onCamera: false, text: "y", durationSec: 5, fellBackToVideo: true },
        ],
      }),
    ).toThrow(/segment 1/);
  });
});
