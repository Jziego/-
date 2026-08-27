import { describe, expect, it } from "vitest";
import { processVideoRender, type VideoRenderDeps, type RenderCompositeInput } from "@/worker/processors/video-render";
import type { Asset, RenderProject, ScriptDraft, VideoOutput } from "@/lib/types";
import type { VoiceTrackManifest } from "@/lib/services/voice-track";

const draft: ScriptDraft = {
  id: "script_1",
  ownerId: "u",
  storeId: "s",
  purpose: "store_traffic",
  platform: "douyin",
  title: "t",
  hook: "h",
  scenes: [
    { order: 1, text: "开场展示星巴克门店或招牌", durationSeconds: 7, assetHints: [], role: "presenter" },
    { order: 2, text: "展示冰美式制作过程", durationSeconds: 11, assetHints: [], role: "broll" },
    { order: 3, text: "展示优惠到店 CTA", durationSeconds: 7, assetHints: [], role: "presenter" },
  ],
  voiceover: "星巴克今天主推冰美式，门店现做现卖。到店领取本期优惠。",
  captions: [],
  cta: "c",
  generationMode: "template_fallback",
  complianceWarnings: [],
  targetDurationSec: 45,
  createdAt: "2026-08-16T00:00:00.000Z",
};

const project: RenderProject = {
  id: "render_1",
  ownerId: "u",
  storeId: "s",
  scriptDraftId: "script_1",
  selectedAssetIds: ["a1"],
  purpose: "store_traffic",
  aspectRatio: "9:16",
  subtitleStyle: "default",
  targetDurationSec: 45,
  status: "processing",
  createdAt: "2026-08-16T00:00:00.000Z",
  updatedAt: "2026-08-16T00:00:00.000Z",
};

const asset: Asset = {
  id: "a1", ownerId: "u", storeId: "s", type: "video",
  originalFilename: "f.mp4", storageKey: "k", mimeType: "video/mp4",
  sizeBytes: 1, tags: [], businessTags: [], status: "ready",
  category: "material",
  createdAt: "2026-08-16T00:00:00.000Z",
};

const talkingHead: VideoOutput = {
  id: "out_th", ownerId: "u", renderProjectId: "render_1",
  storageKey: "avatars/th.mp4", aspectRatio: "9:16", durationSeconds: 50,
  kind: "talking_head", status: "ready", createdAt: "2026-08-16T00:00:00.000Z",
};

function makeDeps(captured: { input?: RenderCompositeInput }, th: VideoOutput | null = talkingHead): VideoRenderDeps {
  return {
    renderRepository: {
      findProjectById: async () => project,
      findTalkingHeadOutputByProject: async () => th,
      createOutput: async (o: VideoOutput) => o,
    } as unknown as VideoRenderDeps["renderRepository"],
    scriptRepository: {
      findById: async () => draft,
    } as unknown as VideoRenderDeps["scriptRepository"],
    assetRepository: {
      findById: async (id: string) => (id === "a1" ? asset : null),
    } as unknown as VideoRenderDeps["assetRepository"],
    bgmTrackRepository: {
      findById: async () => null,
    } as unknown as VideoRenderDeps["bgmTrackRepository"],
    probeAssetDuration: async () => 5, // 素材只有 5s
    loadVoiceTrack: async () => {
      throw new Error("loadVoiceTrack not stubbed");
    },
    renderComposite: async (input: RenderCompositeInput) => {
      captured.input = input;
      return { storageKey: "renders/render_1/output.mp4", durationSeconds: input.totalDurationSec };
    },
  };
}

const fakeJob = { data: { projectId: "render_1", ownerId: "u" }, updateProgress: async () => {} } as never;

describe("video_render processor: target duration + voiceover captions", () => {
  it("normalizes the timeline to the project's target duration slot", async () => {
    const captured: { input?: RenderCompositeInput } = {};
    await processVideoRender(fakeJob, makeDeps(captured));
    // 素材仅 5s、目标 45s、TH 50s → 口播超目标，成片以口播为准 ≈50s（spec §4.1）；修复前 ≈19s
    expect(captured.input?.totalDurationSec).toBeCloseTo(50, 0);
  });

  it("burns subtitles from the voiceover, never from scene descriptions", async () => {
    const captured: { input?: RenderCompositeInput } = {};
    await processVideoRender(fakeJob, makeDeps(captured));
    const ass = captured.input?.assContent ?? "";
    expect(ass).toContain("星巴克今天主推冰美式");
    expect(ass).not.toContain("开场展示星巴克门店或招牌");
    expect(ass).not.toContain("展示冰美式制作过程");
  });

  it("asset_only mode burns no subtitles (no voice track)", async () => {
    const captured: { input?: RenderCompositeInput } = {};
    // 无 TH 产物 → asset_only 模式（spec §4.3）：无配音轨，ASS 零 Dialogue 行
    await processVideoRender(fakeJob, makeDeps(captured, null));
    const ass = captured.input?.assContent ?? "";
    expect(ass).toContain("[Events]"); // ASS 文件本身仍存在（头部完整）
    expect(ass).not.toContain("Dialogue:");
    expect(ass).not.toContain("星巴克今天主推冰美式");
  });

  it("burns yellow ASS overrides for the draft's active highlights", async () => {
    const captured: { input?: RenderCompositeInput } = {};
    const hlDraft: ScriptDraft = { ...draft, highlights: ["冰美式", "稿外词"] };
    const deps = makeDeps(captured);
    deps.scriptRepository = {
      findById: async () => hlDraft,
    } as unknown as VideoRenderDeps["scriptRepository"];
    await processVideoRender(fakeJob, deps);
    const ass = captured.input?.assContent ?? "";
    expect(ass).toContain("{\\c&H00FFFF&}冰美式{\\c&H00FFFFFF&}");
    // 不出现在口播稿中的词不会被包裹（也不会凭空出现）
    expect(ass).not.toContain("稿外词");
  });

  it("never lets avatar_footage assets into the b-roll timeline", async () => {
    const captured: { input?: RenderCompositeInput } = {};
    const avatarAsset: Asset = { ...asset, id: "a_av", category: "avatar_footage" };
    const avatarProject: RenderProject = { ...project, selectedAssetIds: ["a1", "a_av"] };
    const deps = makeDeps(captured);
    deps.renderRepository = {
      findProjectById: async () => avatarProject,
      findTalkingHeadOutputByProject: async () => talkingHead,
      createOutput: async (o: VideoOutput) => o,
    } as unknown as VideoRenderDeps["renderRepository"];
    deps.assetRepository = {
      findById: async (id: string) => (id === "a1" ? asset : id === "a_av" ? avatarAsset : null),
    } as unknown as VideoRenderDeps["assetRepository"];

    await processVideoRender(fakeJob, deps);

    const ids = (captured.input?.assets ?? []).map((a) => a.id);
    expect(ids).toContain("a1");
    expect(ids).not.toContain("a_av");
  });

  it("segmented_voice output drives the manifest path (caption per segment, mixed timeline)", async () => {
    const segmentedVoice: VideoOutput = {
      ...talkingHead,
      kind: "segmented_voice",
      storageKey: "voice-tracks/render_1/manifest.json",
    };
    // 两段 manifest：1 出镜(4s) + 1 画外音 TTS(10s)
    const segManifest: VoiceTrackManifest = {
      version: 1,
      totalDurationSec: 14,
      segments: [
        { index: 0, speakerIndex: 0, onCamera: true, text: "开场白。", videoStorageKey: "avatars/s0.mp4", durationSec: 4 },
        { index: 1, speakerIndex: 0, onCamera: false, text: "介绍产品。", audioStorageKey: "voices/s1.mp3", durationSec: 10 },
      ],
    };

    const captured: { input?: RenderCompositeInput } = {};
    const loadedKeys: string[] = [];
    const segProject: RenderProject = { ...project, targetDurationSec: undefined };
    const deps = makeDeps(captured, segmentedVoice);
    deps.renderRepository = {
      findProjectById: async () => segProject,
      findTalkingHeadOutputByProject: async () => segmentedVoice,
      createOutput: async (o: VideoOutput) => o,
    } as unknown as VideoRenderDeps["renderRepository"];
    deps.loadVoiceTrack = async (key: string) => {
      loadedKeys.push(key);
      return segManifest;
    };

    await processVideoRender(fakeJob, deps);

    // manifest 按分段产物的 storageKey 加载，并透传给 renderComposite
    expect(loadedKeys).toEqual(["voice-tracks/render_1/manifest.json"]);
    expect(captured.input?.voiceTrack).toBe(segManifest);

    // 字幕：每段一条 Dialogue，边界 = 段真实时长累计
    const ass = captured.input?.assContent ?? "";
    const dialogues = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
    expect(dialogues).toHaveLength(2);
    expect(dialogues[0]).toContain("0:00:00.00,0:00:04.00");
    expect(dialogues[0]).toContain("开场白。");
    expect(dialogues[1]).toContain("0:00:04.00,0:00:14.00");
    expect(dialogues[1]).toContain("介绍产品。");

    // 时间线混排：presenter 段精确 4s + broll 铺满 10s 窗口，总时长 = voice 14s
    const segs = captured.input?.segments ?? [];
    expect(segs[0]).toMatchObject({ role: "presenter", durationSec: 4 });
    const broll = segs.filter((s) => s.role === "broll");
    expect(broll.length).toBeGreaterThan(0);
    expect(broll.reduce((acc, s) => acc + s.durationSec, 0)).toBeCloseTo(10, 5);
    expect(captured.input?.totalDurationSec).toBeCloseTo(14, 5);
  });
});
