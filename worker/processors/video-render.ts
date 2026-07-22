import type { Job } from "bullmq";
import { createId, nowIso } from "@/lib/ids";
import {
  getAssetRepository,
  getBgmTrackRepository,
  getRenderRepository,
  getScriptRepository
} from "@/lib/repositories";
import type {
  AssetRepository,
  BgmTrackRepository,
  RenderRepository,
  ScriptRepository
} from "@/lib/repositories/types";
import { createPresignedGetUrl, getObjectToBuffer, putObjectFromBuffer } from "@/lib/storage";
import {
  buildAss,
  buildFilterGraph,
  buildTimeline,
  resolveCompositionMode,
  resolveSubtitlePreset,
  type CompositionMode,
  type TimelineSegment
} from "@/lib/services/video-compose";
import { probeFileDuration, runFfmpeg, type FfmpegInput } from "@/lib/services/ffmpeg-runner";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Asset, BgmTrack, VideoOutput } from "@/lib/types";
import type { ProcessorFn } from "./index";

const RESOLUTIONS: Record<string, { w: number; h: number }> = {
  "9:16": { w: 1080, h: 1920 },
  "1:1": { w: 1080, h: 1080 },
  "16:9": { w: 1920, h: 1080 }
};

export interface CompositeResult {
  storageKey: string;
  durationSeconds: number;
}

export interface RenderCompositeInput {
  projectId: string;
  mode: CompositionMode;
  segments: TimelineSegment[];
  assContent: string;
  subtitleStyle: string;
  talkingHead: VideoOutput | null;
  assets: Asset[];
  bgmTrack: BgmTrack | null;
  aspectRatio: string;
  totalDurationSec: number;
  onProgress: (pct: number) => void;
}

export type RenderCompositeFn = (input: RenderCompositeInput) => Promise<CompositeResult>;

export interface VideoRenderDeps {
  renderRepository: RenderRepository;
  scriptRepository: ScriptRepository;
  assetRepository: AssetRepository;
  bgmTrackRepository: BgmTrackRepository;
  /** Returns real duration (seconds) for a video asset; undefined for images / on failure. */
  probeAssetDuration: (asset: Asset) => Promise<number | undefined>;
  renderComposite: RenderCompositeFn;
}

/**
 * video_render processor — real ffmpeg composite (Mode C: digital-human
 * full-frame + B-roll inserts + burned CJK subtitles + BGM). Degrades to
 * asset_only (no digital human) when no talking-head product exists.
 *
 * The orchestration (mode resolution, timeline, persistence) is testable via
 * an injected `renderComposite`; the default does real R2 download → ffmpeg →
 * R2 upload. Expected job payload: { aspectRatio, subtitleStyle, bgmTrackId? }.
 */
export const videoRenderProcessor: ProcessorFn = (job) =>
  processVideoRender(job, {
    renderRepository: getRenderRepository(),
    scriptRepository: getScriptRepository(),
    assetRepository: getAssetRepository(),
    bgmTrackRepository: getBgmTrackRepository(),
    probeAssetDuration: defaultProbeAssetDuration,
    renderComposite: defaultRenderComposite
  });

/**
 * Default duration probe: presign a short-lived GET URL and ffprobe over HTTP
 * (no full download). Returns undefined for non-video assets or on any error so
 * the timeline falls back to the image-default slot instead of failing the render.
 */
export const defaultProbeAssetDuration = async (asset: Asset): Promise<number | undefined> => {
  if (asset.type !== "video") return undefined;
  try {
    const url = await createPresignedGetUrl(asset.storageKey, 60);
    const dur = await probeFileDuration(url);
    return dur > 0 ? dur : undefined;
  } catch (err) {
    console.warn(
      `[video_render] probeAssetDuration failed for ${asset.id}: ${err instanceof Error ? err.message : String(err)}`
    );
    return undefined;
  }
};

export async function processVideoRender(job: Job, deps: VideoRenderDeps): Promise<VideoOutput> {
  const projectId = job.data.projectId as string;
  const ownerId = (job.data.ownerId as string) ?? "demo_user";
  if (!projectId) {
    throw new Error("video_render requires a projectId");
  }

  const project = await deps.renderRepository.findProjectById(projectId);
  if (!project) throw new Error(`RenderProject not found: ${projectId}`);
  const draft = await deps.scriptRepository.findById(project.scriptDraftId);
  if (!draft) throw new Error(`ScriptDraft not found: ${project.scriptDraftId}`);
  const talkingHead = await deps.renderRepository.findTalkingHeadOutputByProject(projectId);
  const mode = resolveCompositionMode(talkingHead);

  // Resolve selected assets (filter to existing ones).
  const assetResults = await Promise.all(
    project.selectedAssetIds.map((id) => deps.assetRepository.findById(id))
  );
  const assets = assetResults.filter((a): a is Asset => a !== null);

  // Probe real durations for video assets (Bug B: align timeline to actual media).
  const probeEntries = await Promise.all(
    assets.map(async (a) =>
      a.type === "video" ? ([a.id, await deps.probeAssetDuration(a)] as const) : null
    )
  );
  const assetDurations: Record<string, number> = {};
  for (const entry of probeEntries) {
    if (entry && typeof entry[1] === "number") assetDurations[entry[0]] = entry[1];
  }

  const { segments, totalDurationSec } = buildTimeline({
    scenes: draft.scenes,
    assets,
    selectedAssetIds: project.selectedAssetIds,
    assetDurations,
    talkingHeadDurationSec: talkingHead?.durationSeconds
  });

  const bgmTrack = project.bgmTrackId
    ? await deps.bgmTrackRepository.findById(project.bgmTrackId)
    : null;

  const { storageKey, durationSeconds } = await deps.renderComposite({
    projectId,
    mode,
    segments,
    assContent: buildAss(segments, resolveSubtitlePreset(project.subtitleStyle)),
    subtitleStyle: project.subtitleStyle,
    talkingHead,
    assets,
    bgmTrack,
    aspectRatio: project.aspectRatio,
    totalDurationSec,
    onProgress: (pct) => {
      void job.updateProgress(pct);
    }
  });

  const output: VideoOutput = {
    id: createId("output"),
    ownerId,
    renderProjectId: projectId,
    storageKey,
    coverStorageKey: undefined,
    aspectRatio: (project.aspectRatio as VideoOutput["aspectRatio"]) ?? "9:16",
    durationSeconds,
    kind: "final_composite",
    status: "ready",
    createdAt: nowIso()
  };

  try {
    await deps.renderRepository.createOutput(output);
  } catch (err) {
    console.error(
      `[video_render] Failed to persist VideoOutput: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  await job.updateProgress(100);
  return output;
}

async function downloadToFile(storageKey: string, destPath: string): Promise<void> {
  const bytes = await getObjectToBuffer(storageKey);
  await writeFile(destPath, bytes);
}

/**
 * Default composite: download inputs from R2 to a tmp dir, run ffmpeg, upload
 * the final mp4. Progress maps download→5..20, ffmpeg→20..85, upload→90.
 */
export const defaultRenderComposite: RenderCompositeFn = async (input) => {
  const { w: width, h: height } = RESOLUTIONS[input.aspectRatio] ?? RESOLUTIONS["9:16"];
  const dir = mkdtempSync(join(tmpdir(), "render-"));
  try {
    const inputs: FfmpegInput[] = [];
    const assetInputIndex: Record<string, number> = {};
    let talkingHeadInputIndex: number | undefined;

    if (input.mode === "presenter_broll" && input.talkingHead) {
      const thPath = join(dir, "th.mp4");
      await downloadToFile(input.talkingHead.storageKey, thPath);
      talkingHeadInputIndex = 0;
      inputs.push({ path: thPath, isImage: false });
    }
    let nextIdx = talkingHeadInputIndex !== undefined ? talkingHeadInputIndex + 1 : 0;

    // Dedup assets across broll segments.
    const seen = new Set<string>();
    for (const seg of input.segments) {
      if (seg.role !== "broll" || !seg.assetId || seen.has(seg.assetId)) continue;
      seen.add(seg.assetId);
      const asset = input.assets.find((a) => a.id === seg.assetId);
      if (!asset) continue;
      const ext = asset.type === "video" ? "mp4" : "png";
      const p = join(dir, `asset-${asset.id}.${ext}`);
      await downloadToFile(asset.storageKey, p);
      assetInputIndex[asset.id] = nextIdx;
      inputs.push({ path: p, isImage: asset.type !== "video" });
      nextIdx++;
      input.onProgress(5 + Math.round((nextIdx / (input.segments.length + 2)) * 15));
    }

    let bgmInputIndex: number | undefined;
    if (input.bgmTrack) {
      const p = join(dir, "bgm.mp3");
      await downloadToFile(input.bgmTrack.storageKey, p);
      bgmInputIndex = nextIdx;
      inputs.push({ path: p, isImage: false });
      nextIdx++;
    }

    const assPath = join(dir, "subs.ass");
    await writeFile(assPath, input.assContent, "utf8");

    const filter = buildFilterGraph({
      mode: input.mode,
      segments: input.segments,
      assetInputIndex,
      talkingHeadInputIndex,
      bgmInputIndex,
      assPath,
      width,
      height,
      totalDurationSec: input.totalDurationSec
    });

    const outPath = join(dir, "output.mp4");
    await runFfmpeg({
      inputs,
      filter,
      outputPath: outPath,
      durationSec: input.totalDurationSec,
      onProgress: (pct) => input.onProgress(20 + Math.round((pct / 100) * 65))
    });

    input.onProgress(90);
    const storageKey = `renders/${input.projectId}/output-${createId("vid")}.mp4`;
    const bytes = await readFile(outPath);
    await putObjectFromBuffer(storageKey, new Uint8Array(bytes), "video/mp4");

    return { storageKey, durationSeconds: input.totalDurationSec };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
