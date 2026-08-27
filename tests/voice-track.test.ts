import { describe, expect, it } from "vitest";
import { planSegmentSynthesis, voiceTrackManifestKey } from "@/lib/services/voice-track";
import type { ScriptSegment } from "@/lib/types";

const speakers = [
  { profileId: "avatar_a", providerAvatarId: "look_a", providerVoiceId: "voice_a" },
  { profileId: "avatar_b", providerAvatarId: "look_b", providerVoiceId: "voice_b" },
];

const segs: ScriptSegment[] = [
  { index: 0, text: "开场。", speakerIndex: 0, onCamera: true },
  { index: 1, text: "介绍。", speakerIndex: 1, onCamera: false },
  { index: 2, text: "收尾。", speakerIndex: 5, onCamera: true }, // 越界 → clamp 到末位
];

describe("planSegmentSynthesis", () => {
  it("maps each segment to its speaker with clamping", () => {
    const plan = planSegmentSynthesis(segs, speakers);
    expect(plan).toHaveLength(3);
    expect(plan[0]).toMatchObject({ segment: segs[0], speaker: speakers[0] });
    expect(plan[1]).toMatchObject({ speaker: speakers[1] });
    expect(plan[2]).toMatchObject({ speaker: speakers[1] }); // clamped
  });

  it("resolves speakerIndex through speakerAvatarIds, unlisted id → first selected", () => {
    // speakerAvatarIds[0]=avatar_b：段0 虽 speakerIndex=0，仍应对齐到 avatar_b
    const plan = planSegmentSynthesis(segs.slice(0, 1), speakers, ["avatar_b"]);
    expect(plan[0]).toMatchObject({ speaker: speakers[1] });

    // speakerAvatarIds 指向未选中的形象 → 回退第一个选中形象
    const fallback = planSegmentSynthesis(segs.slice(0, 1), speakers, ["avatar_z"]);
    expect(fallback[0]).toMatchObject({ speaker: speakers[0] });
  });

  it("empty speakers throws (render-projects route guarantees non-empty)", () => {
    expect(() => planSegmentSynthesis(segs, [])).toThrow();
  });
});

describe("voiceTrackManifestKey", () => {
  it("is namespaced per project and ends with .json", () => {
    expect(voiceTrackManifestKey("render_1")).toBe("voice-tracks/render_1/manifest.json");
  });
});
