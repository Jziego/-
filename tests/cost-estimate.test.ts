import { describe, expect, it } from "vitest";
import {
  AVATAR_VIDEO_USD_PER_SEC,
  CLONED_TTS_USD_PER_SEC,
  estimateRenderCost,
} from "@/lib/cost-estimate";
import type { ScriptSegment } from "@/lib/types";

const seg = (text: string, onCamera: boolean) => ({
  index: 0, text, speakerIndex: 0, onCamera,
});

describe("estimateRenderCost", () => {
  it("splits seconds by onCamera and prices the two tiers", () => {
    // 45 字出镜 = 10s；45 字画外音 = 10s
    const est = estimateRenderCost([seg("一".repeat(45), true), seg("二".repeat(45), false)]);
    expect(est.onCameraSec).toBe(10);
    expect(est.voiceoverSec).toBe(10);
    expect(est.totalUsd).toBeCloseTo(10 * AVATAR_VIDEO_USD_PER_SEC + 10 * CLONED_TTS_USD_PER_SEC, 4);
  });

  it("no avatars selected → zero cost regardless of segments", () => {
    expect(estimateRenderCost([seg("一".repeat(90), true)], 0).totalUsd).toBe(0);
  });

  it("empty/undefined segments → zero", () => {
    expect(estimateRenderCost(undefined, 2).totalUsd).toBe(0);
    expect(estimateRenderCost([], 1).totalUsd).toBe(0);
  });

  it("lipsync pricing: on-camera seconds billed at ¥1/min, off-camera TTS negligible", () => {
    const segments: ScriptSegment[] = [
      { index: 0, text: "大家好本周全场八八折", speakerIndex: 0, onCamera: true },   // 10 字 ≈ 2.2s
      { index: 1, text: "地址在建设路二十八号", speakerIndex: 0, onCamera: false },  // 10 字 ≈ 2.2s
    ];
    const est = estimateRenderCost(segments, 1, "lipsync");
    expect(est.onCameraSec).toBeGreaterThan(2);
    expect(est.totalCny).toBeCloseTo(est.onCameraSec / 60, 5);
    expect(est.totalUsd).toBe(0);
  });

  it("heygen pricing remains the default and unchanged", () => {
    const segments: ScriptSegment[] = [
      { index: 0, text: "大家好本周全场八八折", speakerIndex: 0, onCamera: true },
    ];
    const est = estimateRenderCost(segments, 1);
    expect(est.totalUsd).toBeGreaterThan(0);
    expect(est.totalCny).toBe(0);
  });
});
