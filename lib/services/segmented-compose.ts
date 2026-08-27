import type { Asset, SceneRole } from "@/lib/types";
import type { VoiceTrackManifest } from "@/lib/services/voice-track";
import {
  escapeFilterPath,
  type CaptionCue,
  type FilterGraphResult,
  type TimelineSegment,
} from "@/lib/services/video-compose";

/** 分段混排时间线段：manifestIndex 指向 manifest.segments 的音轨来源段。 */
export interface SegmentedTimelineSegment extends TimelineSegment {
  manifestIndex: number;
}

export interface BuildSegmentedTimelineArgs {
  manifest: VoiceTrackManifest;
  assets: Asset[];
  selectedAssetIds: string[];
  /** assetId → ffprobe 实际秒数（视频）；图片用 imageDefaultSec。 */
  assetDurations?: Record<string, number>;
  /** 目标成片时长：voice 不足时尾部 b-roll 铺满（Phase 1 语义）；voice 超长不截断。 */
  targetDurationSec?: number;
  imageDefaultSec?: number;
  maxClipSec?: number;
}

/**
 * Phase 3 混排时间线（spec §6.4）：
 * - onCamera 段 = presenter 段，时长 = 该段数字人视频真实时长；
 * - 画外音段窗口内顺序铺 b-roll（素材池循环复用，末段截断到窗口余量）；
 * - 素材池为空时黑场兜底；voice 总长短于 targetDurationSec 时尾部 b-roll 铺满。
 * Σ durationSec === totalDurationSec（与 buildTimeline 同契约）。
 */
export function buildSegmentedTimeline(args: BuildSegmentedTimelineArgs): {
  segments: SegmentedTimelineSegment[];
  totalDurationSec: number;
} {
  const imageDefaultSec = args.imageDefaultSec ?? 3;
  const maxClipSec = args.maxClipSec ?? 12;
  const assetDurations = args.assetDurations ?? {};

  // 有序去重素材池（勾选顺序；category 守卫在 processor 层已做）。
  const seen = new Set<string>();
  const pool: Asset[] = [];
  for (const id of args.selectedAssetIds) {
    if (seen.has(id)) continue;
    const asset = args.assets.find((a) => a.id === id);
    if (asset) { seen.add(id); pool.push(asset); }
  }
  const naturalFor = (a: Asset): number =>
    a.type === "video"
      ? Math.min(Math.max(assetDurations[a.id] ?? imageDefaultSec, 0.5), maxClipSec)
      : imageDefaultSec;

  const beats: { role: SceneRole; manifestIndex: number; assetId: string | null; duration: number }[] = [];
  let poolCursor = 0;

  /** 在 duration 窗口内铺 b-roll；窗口必须被恰好填满（末段截断）。 */
  const fillBrollWindow = (windowSec: number, manifestIndex: number): void => {
    let remaining = windowSec;
    let guard = 0;
    while (remaining > 0.001 && guard < 1000) {
      guard++;
      const asset = pool[poolCursor % pool.length];
      poolCursor++;
      const natural = asset ? naturalFor(asset) : remaining;
      const slice = Math.min(natural, remaining);
      beats.push({ role: "broll", manifestIndex, assetId: asset?.id ?? null, duration: slice });
      remaining -= slice;
      if (pool.length === 0) break; // 黑场一段即可铺满
    }
  };

  args.manifest.segments.forEach((seg, manifestIndex) => {
    if (seg.onCamera) {
      beats.push({ role: "presenter", manifestIndex, assetId: null, duration: seg.durationSec });
    } else {
      fillBrollWindow(seg.durationSec, manifestIndex);
    }
  });

  // voice 短于目标档位 → 尾部 b-roll 铺满（音轨在 filter graph 侧 apad）。
  let contentTotal = beats.reduce((acc, b) => acc + b.duration, 0);
  if (args.targetDurationSec !== undefined && args.targetDurationSec > contentTotal) {
    fillBrollWindow(args.targetDurationSec - contentTotal, args.manifest.segments.length - 1);
    contentTotal = args.targetDurationSec;
  }

  let cursor = 0;
  const segments: SegmentedTimelineSegment[] = beats.map((b, i) => {
    const start = cursor;
    cursor += b.duration;
    return {
      role: b.role,
      startSec: start,
      endSec: cursor,
      durationSec: b.duration,
      sceneOrder: i + 1,
      text: "",
      assetId: b.assetId,
      manifestIndex: b.manifestIndex,
    };
  });
  return { segments, totalDurationSec: cursor };
}

/**
 * 分段字幕：每段一条 cue，边界 = 段真实时长累计（TTS 段时长来自词级时间轴，
 * 天然与配音对齐；onCamera 段整句一条）。标黄仍由 buildAss 的 highlights 包裹。
 */
export function buildSegmentedCaptionCues(manifest: VoiceTrackManifest): CaptionCue[] {
  let cursor = 0;
  return manifest.segments.map((seg) => {
    const cue = { startSec: cursor, endSec: cursor + seg.durationSec, text: seg.text };
    cursor += seg.durationSec;
    return cue;
  });
}

export interface BuildSegmentedFilterGraphArgs {
  segments: SegmentedTimelineSegment[];
  manifest: VoiceTrackManifest;
  /** manifest index → 该段数字人视频（onCamera 或 TTS 降级）的 ffmpeg 输入下标。 */
  segmentVideoInputIndex: Record<number, number>;
  /** manifest index → 该段 TTS 音频的 ffmpeg 输入下标。 */
  segmentAudioInputIndex: Record<number, number>;
  assetInputIndex: Record<string, number>;
  bgmInputIndex?: number;
  assPath: string;
  width: number;
  height: number;
  totalDurationSec: number;
}

/**
 * 分段 filter graph：画面按时间线（presenter 段从对应形象视频 trim；b-roll 段
 * 从素材 trim/黑场）；音频按 manifest 段序 concat（onCamera/降级段取视频原声，
 * 画外音段取 TTS 音频），apad 到总时长后与 BGM duck 混音。
 */
export function buildSegmentedFilterGraph(args: BuildSegmentedFilterGraphArgs): FilterGraphResult {
  const { width, height, assPath, totalDurationSec } = args;
  const parts: string[] = [];
  const videoLabels: string[] = [];

  const scaledChain = (inPrefix: string, outLabel: string): string =>
    `${inPrefix}scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30${outLabel}`;

  args.segments.forEach((seg, i) => {
    const outLabel = `[v${i}]`;
    if (seg.role === "presenter") {
      const videoIdx = args.segmentVideoInputIndex[seg.manifestIndex];
      if (videoIdx === undefined) {
        // 数据损坏兜底：黑场而不是崩图
        parts.push(`color=c=black:s=${width}x${height}:d=${seg.durationSec},fps=30${outLabel}`);
      } else {
        parts.push(
          scaledChain(
            `[${videoIdx}:v]trim=start=0:duration=${seg.durationSec},setpts=PTS-STARTPTS,`,
            outLabel,
          ),
        );
      }
    } else {
      const idx = seg.assetId != null ? args.assetInputIndex[seg.assetId] : undefined;
      if (idx === undefined) {
        parts.push(`color=c=black:s=${width}x${height}:d=${seg.durationSec},fps=30${outLabel}`);
      } else {
        parts.push(scaledChain(`[${idx}:v]trim=duration=${seg.durationSec},setpts=PTS-STARTPTS,`, outLabel));
      }
    }
    videoLabels.push(outLabel);
  });

  parts.push(`${videoLabels.join("")}concat=n=${videoLabels.length}:v=1:a=0[vcat]`);
  parts.push(`[vcat]subtitles='${escapeFilterPath(assPath)}'[vsub]`);

  // 音轨：按 manifest 段序 concat。onCamera 与 TTS 降级段取视频原声；画外音段取 TTS。
  const audioLabels: string[] = [];
  args.manifest.segments.forEach((seg, manifestIndex) => {
    const label = `[a${manifestIndex}]`;
    const videoIdx = args.segmentVideoInputIndex[manifestIndex];
    const audioIdx = args.segmentAudioInputIndex[manifestIndex];
    if (seg.onCamera || seg.fellBackToVideo) {
      if (videoIdx !== undefined) {
        parts.push(`[${videoIdx}:a]atrim=duration=${seg.durationSec},asetpts=PTS-STARTPTS${label}`);
        audioLabels.push(label);
      }
    } else if (audioIdx !== undefined) {
      parts.push(`[${audioIdx}:a]atrim=duration=${seg.durationSec},asetpts=PTS-STARTPTS${label}`);
      audioLabels.push(label);
    }
  });
  if (audioLabels.length === 0) {
    parts.push(`anullsrc=channel_layout=stereo:sample_rate=44100,atrim=duration=${totalDurationSec}[avoice0]`);
  } else {
    parts.push(`${audioLabels.join("")}concat=n=${audioLabels.length}:v=0:a=1[avoicecat]`);
    parts.push(`[avoicecat]apad,atrim=duration=${totalDurationSec},aresample=async=1[avoice0]`);
  }

  if (args.bgmInputIndex !== undefined) {
    parts.push(`[${args.bgmInputIndex}:a]volume=-20dB,atrim=duration=${totalDurationSec}[abgm]`);
    parts.push(`[avoice0][abgm]amix=inputs=2:duration=first:dropout_transition=0[aout]`);
    return { filterComplex: parts.join(";"), mapVideo: "[vsub]", mapAudio: "[aout]" };
  }
  return { filterComplex: parts.join(";"), mapVideo: "[vsub]", mapAudio: "[avoice0]" };
}
