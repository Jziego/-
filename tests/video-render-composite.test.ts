import { describe, expect, it, beforeEach, vi } from "vitest";
import { writeFile } from "node:fs/promises";

// Mock object storage + ffmpeg so the composite orchestration runs without R2/ffmpeg.
const { getObjectToFileMock, putObjectFromStreamMock, runFfmpegMock } = vi.hoisted(() => ({
  getObjectToFileMock: vi.fn(),
  putObjectFromStreamMock: vi.fn(),
  runFfmpegMock: vi.fn()
}));

vi.mock("@/lib/storage", () => ({
  getObjectToBuffer: vi.fn(async () => new Uint8Array([0, 1, 2])),
  putObjectFromBuffer: vi.fn(async () => undefined),
  createPresignedGetUrl: vi.fn(async () => "https://example.com/presigned")
}));

// 流式原语在 server-only 的 lib/storage-stream（node:fs/node:stream 不能进客户端图）
vi.mock("@/lib/storage-stream", () => ({
  getObjectToFile: getObjectToFileMock,
  putObjectFromStream: putObjectFromStreamMock
}));

vi.mock("@/lib/services/ffmpeg-runner", () => ({
  runFfmpeg: runFfmpegMock,
  probeFileDuration: vi.fn(async () => 5)
}));

import { defaultRenderComposite } from "@/worker/processors/video-render";
import type { Asset, BgmTrack, VideoOutput } from "@/lib/types";
import type { TimelineSegment } from "@/lib/services/video-compose";

const NOW = "2026-08-16T00:00:00.000Z";

const videoAsset: Asset = {
  id: "asset_1", ownerId: "u", storeId: "s", type: "video",
  originalFilename: "a.mp4", storageKey: "uploads/a.mp4", mimeType: "video/mp4",
  sizeBytes: 1000, tags: [], businessTags: [], status: "ready",
  category: "material", createdAt: NOW
};

const talkingHead: VideoOutput = {
  id: "out_th", ownerId: "u", renderProjectId: "proj_1", storageKey: "avatars/th.mp4",
  coverStorageKey: undefined, aspectRatio: "9:16", durationSeconds: 10,
  kind: "talking_head", status: "ready", createdAt: NOW
};

const bgmTrack: BgmTrack = {
  id: "bgm_upbeat_01", name: "明快节奏 01", storageKey: "bgm/bgm_upbeat_01.mp3",
  durationSeconds: 30, category: "upbeat", createdAt: NOW
};

const segments: TimelineSegment[] = [
  { role: "presenter", startSec: 0, endSec: 4, durationSec: 4, sceneOrder: 1, text: "开场", assetId: null },
  { role: "broll", startSec: 4, endSec: 9, durationSec: 5, sceneOrder: 2, text: "产品", assetId: "asset_1" }
];

function compositeInput(overrides: Partial<Parameters<typeof defaultRenderComposite>[0]> = {}) {
  return {
    projectId: "proj_1",
    mode: "presenter_broll" as const,
    segments,
    assContent: "[Script Info]\n",
    subtitleStyle: "bold_bottom",
    talkingHead,
    assets: [videoAsset],
    bgmTrack,
    aspectRatio: "9:16",
    totalDurationSec: 9,
    onProgress: () => {},
    ...overrides
  };
}

describe("defaultRenderComposite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getObjectToFileMock.mockImplementation(async (key: string, destPath: string) => {
      if (key.startsWith("bgm/")) {
        throw new Error("NoSuchKey: The specified key does not exist.");
      }
      await writeFile(destPath, new Uint8Array([0, 1, 2]));
    });
    putObjectFromStreamMock.mockResolvedValue(undefined);
    runFfmpegMock.mockImplementation(async ({ outputPath }: { outputPath: string }) => {
      await writeFile(outputPath, new Uint8Array([9]));
    });
  });

  it("BGM object missing in R2 → render still completes, without bgm in the filter graph", async () => {
    const result = await defaultRenderComposite(compositeInput());

    expect(result.storageKey).toContain("renders/proj_1/");
    expect(result.durationSeconds).toBe(9);
    expect(runFfmpegMock).toHaveBeenCalledTimes(1);
    const { filter, inputs } = runFfmpegMock.mock.calls[0][0];
    // BGM input dropped: no bgm file fed to ffmpeg, no bgm audio chain in the graph.
    expect(inputs.some((i: { path: string }) => i.path.includes("bgm"))).toBe(false);
    expect(filter.filterComplex).not.toContain("[abgm]");
    expect(filter.mapAudio).toBe("[avoice]");
    // Talking-head + asset still downloaded (streamed to disk) and composited.
    expect(getObjectToFileMock).toHaveBeenCalledWith("avatars/th.mp4", expect.any(String));
    expect(getObjectToFileMock).toHaveBeenCalledWith("uploads/a.mp4", expect.any(String));
    // 成片以流式上传（不整文件进堆）
    expect(putObjectFromStreamMock).toHaveBeenCalledTimes(1);
    expect(putObjectFromStreamMock).toHaveBeenCalledWith(
      expect.stringMatching(/^renders\/proj_1\/output-vid_.+\.mp4$/),
      expect.stringContaining("output.mp4"),
      "video/mp4"
    );
  });

  it("BGM object present → mixed into the audio graph", async () => {
    getObjectToFileMock.mockImplementation(async (_key: string, destPath: string) => {
      await writeFile(destPath, new Uint8Array([0, 1, 2]));
    });

    await defaultRenderComposite(compositeInput());

    const { filter } = runFfmpegMock.mock.calls[0][0];
    expect(filter.filterComplex).toContain("[abgm]");
    expect(filter.filterComplex).toContain("amix");
    expect(filter.mapAudio).toBe("[aout]");
  });
});
