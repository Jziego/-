import { describe, expect, it, vi } from "vitest";
import {
  deriveScenesFromSegments,
  deriveSegmentsFromVoiceover,
  estimateSegmentSeconds,
  filterActiveHighlights,
} from "@/lib/services/scene-derive";

describe("deriveSegmentsFromVoiceover", () => {
  it("splits by sentence with index/speakerIndex=0 and defaults onCamera to first+last", () => {
    const segments = deriveSegmentsFromVoiceover("开场一句。中间一句。结尾一句。");
    expect(segments.map((s) => s.text)).toEqual(["开场一句。", "中间一句。", "结尾一句。"]);
    expect(segments.map((s) => s.index)).toEqual([0, 1, 2]);
    expect(segments.every((s) => s.speakerIndex === 0)).toBe(true);
    expect(segments.map((s) => s.onCamera)).toEqual([true, false, true]);
  });

  it("single sentence → single onCamera segment", () => {
    const segments = deriveSegmentsFromVoiceover("只有一句没有标点");
    expect(segments).toHaveLength(1);
    expect(segments[0]?.onCamera).toBe(true);
  });

  it("AI onCameraTexts win over the first/last default", () => {
    const segments = deriveSegmentsFromVoiceover("开场一句。中间一句。结尾一句。", {
      onCameraTexts: ["中间一句。"],
    });
    expect(segments.map((s) => s.onCamera)).toEqual([false, true, false]);
  });

  it("falls back to first/last default (with a warn) when AI onCameraTexts match nothing", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const segments = deriveSegmentsFromVoiceover("开场一句。中间一句。结尾一句。", {
      onCameraTexts: ["完全不相关的句子。"],
    });
    expect(segments.map((s) => s.onCamera)).toEqual([true, false, true]);
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it("unchanged sentences inherit onCamera from prev; new sentences fall back to default", () => {
    const prev = deriveSegmentsFromVoiceover("旧开场。旧结尾。"); // [true, true]
    const segments = deriveSegmentsFromVoiceover("旧开场。新中段。新收尾。", { prev });
    expect(segments.map((s) => s.onCamera)).toEqual([true, false, true]);
  });

  it("empty voiceover → no segments", () => {
    expect(deriveSegmentsFromVoiceover("")).toEqual([]);
  });
});

describe("deriveSegmentsFromVoiceover — speakerIndex (Phase 3)", () => {
  it("assigns speakerIndex from speakerByText verbatim matches", () => {
    const voiceover = "大家好，我是店主。今天推荐招牌蛋糕。快来店里。";
    const segments = deriveSegmentsFromVoiceover(voiceover, {
      speakerByText: new Map([["今天推荐招牌蛋糕。", 1]]),
    });
    expect(segments.map((s) => s.speakerIndex)).toEqual([0, 1, 0]);
  });

  it("prev segments win over speakerByText (user edit keeps assignments)", () => {
    const prev = [
      { index: 0, text: "大家好。", speakerIndex: 2, onCamera: true },
      { index: 1, text: "今天推荐招牌蛋糕。", speakerIndex: 1, onCamera: false },
    ];
    const segments = deriveSegmentsFromVoiceover("大家好。今天推荐招牌蛋糕。", {
      speakerByText: new Map([["今天推荐招牌蛋糕。", 0]]),
      prev,
    });
    expect(segments.map((s) => s.speakerIndex)).toEqual([2, 1]);
  });

  it("clamps negative/NaN speakerIndex to 0", () => {
    const segments = deriveSegmentsFromVoiceover("你好。", {
      speakerByText: new Map([["你好。", Number.NaN]]),
    });
    expect(segments[0]!.speakerIndex).toBe(0);
  });
});

describe("filterActiveHighlights", () => {
  it("keeps only words present in the voiceover, trimmed and deduped", () => {
    expect(
      filterActiveHighlights(["牛肉面", "不存在词", " 牛肉面 ", ""], "今天牛肉面半价"),
    ).toEqual(["牛肉面"]);
  });
});

describe("deriveScenesFromSegments", () => {
  it("empty → empty", () => {
    expect(deriveScenesFromSegments([])).toEqual([]);
  });

  it("single segment → single presenter scene", () => {
    const scenes = deriveScenesFromSegments([
      { index: 0, text: "唯一一句口播在这里。", speakerIndex: 0, onCamera: true },
    ]);
    expect(scenes).toHaveLength(1);
    expect(scenes[0]?.role).toBe("presenter");
    expect(scenes[0]?.text).toBe("唯一一句口播在这里。");
  });

  it("three segments → first/last presenter scenes with estimated durations", () => {
    const scenes = deriveScenesFromSegments([
      { index: 0, text: "阿姨手作面馆今天主推牛肉面，现熬牛骨汤。", speakerIndex: 0, onCamera: true },
      { index: 1, text: "除了牛肉面，葱油拌面也值得一试。", speakerIndex: 0, onCamera: false },
      { index: 2, text: "现在到店，直接报视频里的活动。", speakerIndex: 0, onCamera: true },
    ]);
    expect(scenes).toHaveLength(2);
    expect(scenes.map((s) => s.role)).toEqual(["presenter", "presenter"]);
    expect(scenes.map((s) => s.order)).toEqual([1, 2]);
    // 20 字 / 4.5 ≈ 4s；15 字 / 4.5 ≈ 3s
    expect(scenes.map((s) => s.durationSeconds)).toEqual([4, 3]);
    expect(scenes.every((s) => s.assetHints.length === 0)).toBe(true);
  });
});

describe("estimateSegmentSeconds", () => {
  it("rounds chars/4.5 with a 3s floor", () => {
    expect(estimateSegmentSeconds("短句。")).toBe(3); // 3 字 → floor 3
    expect(estimateSegmentSeconds("阿姨手作面馆今天主推牛肉面，现熬牛骨汤。")).toBe(4); // 20 字
  });
});
