import { describe, expect, it } from "vitest";
import { processVideoRender, type VideoRenderDeps, type RenderCompositeInput } from "@/worker/processors/video-render";
import type { Asset, RenderProject, ScriptDraft, VideoOutput } from "@/lib/types";

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
});
