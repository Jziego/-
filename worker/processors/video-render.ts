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
  buildCaptionCues,
  buildFilterGraph,
  buildTimeline,
  resolveCompositionMode,
  resolveSubtitlePreset,
  type CompositionMode,
  type TimelineSegment
} from "@/lib/services/video-compose";
import {
  buildSegmentedCaptionCues,
  buildSegmentedFilterGraph,
  buildSegmentedTimeline,
  type SegmentedTimelineSegment
} from "@/lib/services/segmented-compose";
import { parseVoiceTrackManifest, type VoiceTrackManifest } from "@/lib/services/voice-track";
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
  /** Phase 3 分段口播 manifest（talkingHead.kind="segmented_voice" 时加载）；驱动混排时间线与分段 filter graph。 */
  voiceTrack?: VoiceTrackManifest | null;
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
  /** 加载 voice-track manifest（kind="segmented_voice" 时）；测试注入。 */
  loadVoiceTrack: (storageKey: string) => Promise<VoiceTrackManifest>;
}

const defaultLoadVoiceTrack = async (storageKey: string): Promise<VoiceTrackManifest> => {
  const bytes = await getObjectToBuffer(storageKey);
  return parseVoiceTrackManifest(JSON.parse(new TextDecoder().decode(bytes)));
};

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
    renderComposite: defaultRenderComposite,
    loadVoiceTrack: defaultLoadVoiceTrack
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

  // Phase 3：segmented_voice 产物 → 加载 manifest 走混排时间线；否则保持 Phase 1/2 行为。
  const voiceTrack =
    talkingHead?.kind === "segmented_voice"
      ? await deps.loadVoiceTrack(talkingHead.storageKey)
      : null;

  // Resolve selected assets (filter to existing ones). avatar_footage 是数字分身
  // 训练素材，即使用户端把它塞进 selectedAssetIds 也绝不进 b-roll 时间线。
  const assetResults = await Promise.all(
    project.selectedAssetIds.map((id) => deps.assetRepository.findById(id))
  );
  const assets = assetResults.filter(
    (a): a is Asset => a !== null && (a.category ?? "material") === "material"
  );

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

  let segments: TimelineSegment[];
  let totalDurationSec: number;
  if (voiceTrack) {
    const built = buildSegmentedTimeline({
      manifest: voiceTrack,
      assets,
      selectedAssetIds: project.selectedAssetIds,
      assetDurations,
      targetDurationSec: project.targetDurationSec
    });
    segments = built.segments;
    totalDurationSec = built.totalDurationSec;
  } else {
    const built = buildTimeline({
      scenes: draft.scenes,
      assets,
      selectedAssetIds: project.selectedAssetIds,
      assetDurations,
      talkingHeadDurationSec: talkingHead?.durationSeconds,
      targetDurationSec: project.targetDurationSec
    });
    segments = built.segments;
    totalDurationSec = built.totalDurationSec;
  }

  const bgmTrack = project.bgmTrackId
    ? await deps.bgmTrackRepository.findById(project.bgmTrackId)
    : null;

  // Subtitles follow the voiceover (Bug 3 fix): presenter mode burns the spoken
  // script; asset_only has no voice track, hence no subtitles at all.
  // 分段模式：每段一条 cue，边界 = 段真实时长（TTS 词级时间轴天然精准）。
  const captionCues = voiceTrack
    ? buildSegmentedCaptionCues(voiceTrack)
    : mode === "presenter_broll"
      ? buildCaptionCues(draft.voiceover, totalDurationSec)
      : [];

  const { storageKey, durationSeconds } = await deps.renderComposite({
    projectId,
    mode,
    segments,
    assContent: buildAss(captionCues, resolveSubtitlePreset(project.subtitleStyle), draft.highlights),
    subtitleStyle: project.subtitleStyle,
    talkingHead,
    voiceTrack,
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
    const segmentVideoInputIndex: Record<number, number> = {};
    const segmentAudioInputIndex: Record<number, number> = {};
    let nextIdx = 0;

    if (input.voiceTrack) {
      // 分段产物下载：onCamera/降级段是 mp4；画外音段是 TTS mp3。
      for (let m = 0; m < input.voiceTrack.segments.length; m++) {
        const seg = input.voiceTrack.segments[m]!;
        if (seg.videoStorageKey) {
          const p = join(dir, `seg-${m}.mp4`);
          await downloadToFile(seg.videoStorageKey, p);
          segmentVideoInputIndex[m] = nextIdx++;
          inputs.push({ path: p, isImage: false });
        } else if (seg.audioStorageKey) {
          const p = join(dir, `seg-${m}.mp3`);
          await downloadToFile(seg.audioStorageKey, p);
          segmentAudioInputIndex[m] = nextIdx++;
          inputs.push({ path: p, isImage: false });
        }
      }
    } else if (input.mode === "presenter_broll" && input.talkingHead) {
      const thPath = join(dir, "th.mp4");
      await downloadToFile(input.talkingHead.storageKey, thPath);
      talkingHeadInputIndex = 0;
      inputs.push({ path: thPath, isImage: false });
      nextIdx = 1;
    }

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
      // BGM is an optional enhancement: a missing/unreadable object (e.g. the
      // ops-uploaded bgm/*.mp3 never reached the bucket) must not fail the
      // whole render — degrade to voice-only audio instead.
      const p = join(dir, "bgm.mp3");
      try {
        await downloadToFile(input.bgmTrack.storageKey, p);
        bgmInputIndex = nextIdx;
        inputs.push({ path: p, isImage: false });
        nextIdx++;
      } catch (err) {
        console.warn(
          `[video_render] BGM download failed (${input.bgmTrack.storageKey}); rendering without music: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    const assPath = join(dir, "subs.ass");
    await writeFile(assPath, input.assContent, "utf8");

    const filter = input.voiceTrack
      ? buildSegmentedFilterGraph({
          segments: input.segments as SegmentedTimelineSegment[],
          manifest: input.voiceTrack,
          segmentVideoInputIndex,
          segmentAudioInputIndex,
          assetInputIndex,
          bgmInputIndex,
          assPath,
          width,
          height,
          totalDurationSec: input.totalDurationSec
        })
      : buildFilterGraph({
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
