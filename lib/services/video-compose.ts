import type { Asset, SceneRole, ScriptScene, VideoOutput } from "@/lib/types";

export type CompositionMode = "presenter_broll" | "asset_only";

export interface TimelineSegment {
  role: ScriptScene["role"];
  startSec: number;
  endSec: number;
  durationSec: number;
  sceneOrder: number;
  text: string;
  assetId: string | null;
}

/**
 * Mode C (presenter_broll) when a talking-head product exists for the project;
 * asset_only when there is none (includeAvatar=false OR talking_head failed).
 * The video_render processor branches on this.
 */
export function resolveCompositionMode(talkingHead: VideoOutput | null): CompositionMode {
  return talkingHead ? "presenter_broll" : "asset_only";
}

/**
 * Build a real-duration-aligned, asset-driven timeline.
 *
 * Every selected asset becomes its own broll segment (Bug A fix: all uploaded
 * assets appear). Segment durations are grounded in actual media length — the
 * talking-head TTS duration anchors the total in presenter mode, and each
 * video asset uses its ffprobe'd length (Bug B fix: the concatenated video
 * stream now equals totalDurationSec, so the tail no longer freezes).
 *
 * Σ segment.durationSec === totalDurationSec by construction (the returned
 * totalDurationSec is the actual accumulated cursor). In presenter mode the
 * total is min(talkingHeadDuration, contentTotal) so the output never exceeds
 * the available footage/voiceover.
 *
 * Broll assets follow scene.matchedAssetId pinning when present: assets pinned
 * to broll scenes come first in scene order, then remaining pool assets.
 */
export interface BuildTimelineArgs {
  scenes: ScriptScene[];
  assets: Asset[];
  selectedAssetIds: string[];
  /** assetId → real ffprobe seconds, for video assets. Images use imageDefaultSec. */
  assetDurations?: Record<string, number>;
  /** Authoritative total when a talking-head product exists (presenter mode). */
  talkingHeadDurationSec?: number;
  /** Duration slot for image assets. Default 3. */
  imageDefaultSec?: number;
  /** Cap a single video clip's contribution. Default 12. */
  maxClipSec?: number;
}

export interface BuildTimelineResult {
  segments: TimelineSegment[];
  totalDurationSec: number;
}

export function buildTimeline(args: BuildTimelineArgs): BuildTimelineResult {
  const assetDurations = args.assetDurations ?? {};
  const imageDefaultSec = args.imageDefaultSec ?? 3;
  const maxClipSec = args.maxClipSec ?? 12;
  const hasTalkingHead =
    typeof args.talkingHeadDurationSec === "number" && args.talkingHeadDurationSec > 0;

  // Ordered, existing, de-duped selected assets = the broll pool.
  const seen = new Set<string>();
  const pool: Asset[] = [];
  for (const id of args.selectedAssetIds) {
    if (seen.has(id)) continue;
    const asset = args.assets.find((a) => a.id === id);
    if (asset) {
      seen.add(id);
      pool.push(asset);
    }
  }

  // Scene-pinned ordering: assets matched to broll scenes (via matchedAssetId) come first,
  // in scene order; any remaining pool assets are appended after. Backward-compatible —
  // when no scene carries a matchedAssetId, orderedAssets === pool (same order).
  const poolById = new Map(pool.map((a) => [a.id, a]));
  const usedAssetIds = new Set<string>();
  const orderedAssets: Asset[] = [];
  for (const s of args.scenes) {
    if (s.role !== "broll") continue;
    const mid = s.matchedAssetId ?? null;
    if (mid && poolById.has(mid) && !usedAssetIds.has(mid)) {
      orderedAssets.push(poolById.get(mid) as Asset);
      usedAssetIds.add(mid);
    }
  }
  for (const a of pool) {
    if (!usedAssetIds.has(a.id)) {
      orderedAssets.push(a);
      usedAssetIds.add(a.id);
    }
  }

  // Natural duration: video = real (capped) length; image = default slot.
  const naturalFor = (a: Asset): number =>
    a.type === "video"
      ? Math.min(Math.max(assetDurations[a.id] ?? imageDefaultSec, 0.5), maxClipSec)
      : imageDefaultSec;

  // Subtitle text pool: cycle scene texts across broll beats.
  const subtitlePool = args.scenes.map((s) => s.text).filter((t) => t.length > 0);
  let textCursor = 0;
  const nextText = (): string =>
    subtitlePool.length > 0 ? subtitlePool[textCursor++ % subtitlePool.length] : "";

  type Beat = { role: SceneRole; assetId: string | null; text: string; natural: number };
  const beats: Beat[] = [];

  const presenterScenes = args.scenes.filter((s) => s.role === "presenter");
  const openers = presenterScenes.slice(0, -1);
  const closer = presenterScenes.length > 0 ? presenterScenes[presenterScenes.length - 1] : undefined;

  if (hasTalkingHead) {
    for (const s of openers) {
      beats.push({ role: "presenter", assetId: null, text: s.text, natural: Math.max(s.durationSeconds, 0.5) });
    }
    for (const a of orderedAssets) {
      beats.push({ role: "broll", assetId: a.id, text: nextText(), natural: naturalFor(a) });
    }
    if (closer) {
      beats.push({ role: "presenter", assetId: null, text: closer.text, natural: Math.max(closer.durationSeconds, 0.5) });
    }
  } else {
    for (const a of orderedAssets) {
      beats.push({ role: "broll", assetId: a.id, text: nextText(), natural: naturalFor(a) });
    }
    if (pool.length === 0) {
      // No assets selected: one beat per script scene so the video is never empty.
      for (const s of args.scenes) {
        beats.push({ role: "broll", assetId: null, text: s.text, natural: Math.max(s.durationSeconds, 0.5) });
      }
    }
  }

  const contentTotal = beats.reduce((acc, b) => acc + b.natural, 0);
  const total = hasTalkingHead
    ? Math.min(args.talkingHeadDurationSec as number, contentTotal)
    : contentTotal;
  const scale = contentTotal > 0 ? total / contentTotal : 1;

  let cursor = 0;
  const segments: TimelineSegment[] = beats.map((b, i) => {
    const duration = b.natural * scale;
    const start = cursor;
    cursor = start + duration;
    return {
      role: b.role,
      startSec: start,
      endSec: cursor,
      durationSec: duration,
      sceneOrder: i + 1,
      text: b.text,
      assetId: b.assetId
    };
  });

  return { segments, totalDurationSec: cursor };
}

// ── Subtitle (ASS) generation ──────────────────────────────────────────────

export type SubtitleStylePreset = "default" | "bold_bottom" | "minimal";

interface AssStyleSpec {
  fontname: string;
  fontsize: number;
  primaryColour: string; // &H00BBGGRR (ASS alpha+BGR)
  outlineColour: string;
  bold: 0 | 1;
  outline: number;
  alignment: number; // 2 = bottom-center
  marginV: number;
}

const CJK_FONT = "Noto Sans CJK SC";

const SUBTITLE_PRESETS: Record<SubtitleStylePreset, AssStyleSpec> = {
  default: { fontname: CJK_FONT, fontsize: 72, primaryColour: "&H00FFFFFF", outlineColour: "&H00000000", bold: 1, outline: 4, alignment: 2, marginV: 80 },
  bold_bottom: { fontname: CJK_FONT, fontsize: 84, primaryColour: "&H0000F4FF", outlineColour: "&H00000000", bold: 1, outline: 6, alignment: 2, marginV: 60 },
  minimal: { fontname: CJK_FONT, fontsize: 56, primaryColour: "&H00EEEEEE", outlineColour: "&H80000000", bold: 0, outline: 2, alignment: 2, marginV: 100 }
};

function assTimestamp(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const sWhole = Math.floor(sec % 60);
  const cs = Math.round((sec - Math.floor(sec)) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(sWhole).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

/**
 * Escape a filesystem path for use inside an ffmpeg filtergraph (e.g. the
 * subtitles= filter). The filtergraph parser treats ":", "\", and "'" as
 * special, so Windows paths like C:\...\subs.ass must be escaped. Backslashes
 * are converted to forward slashes first. A no-op for Unix paths.
 */
function escapeFilterPath(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
}

/** Map a RenderProject.subtitleStyle string to a preset (default if unrecognized). */
export function resolveSubtitlePreset(style: string | undefined | null): SubtitleStylePreset {
  return style === "bold_bottom" || style === "minimal" ? style : "default";
}

/**
 * Generate an ASS subtitle file: one Dialogue line per timeline segment,
 * timed by accumulated segment boundaries. Styled by the chosen preset.
 * Requires the CJK font (worker/Dockerfile installs font-noto-cjk).
 */
export function buildAss(segments: TimelineSegment[], preset: SubtitleStylePreset): string {
  const s = SUBTITLE_PRESETS[preset] ?? SUBTITLE_PRESETS.default;
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 1080",
    "PlayResY: 1920",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,${s.fontname},${s.fontsize},${s.primaryColour},${s.outlineColour},${s.bold},0,1,${s.outline},0,${s.alignment},40,40,${s.marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"
  ];
  const dialogues = segments.map((seg) =>
    `Dialogue: 0,${assTimestamp(seg.startSec)},${assTimestamp(seg.endSec)},Default,,0,0,0,,${seg.text}`
  );
  return [...header, ...dialogues].join("\n");
}

// ── ffmpeg filter_complex builder ──────────────────────────────────────────

export interface FilterGraphResult {
  filterComplex: string;
  mapVideo: string;
  mapAudio: string;
}

export interface BuildFilterGraphArgs {
  mode: CompositionMode;
  segments: TimelineSegment[];
  /** assetId → ffmpeg input index (the runner downloads assets to local files). */
  assetInputIndex: Record<string, number>;
  /** input index of the talking-head mp4 (required for presenter_broll). */
  talkingHeadInputIndex?: number;
  /** input index of the BGM mp3, if any. */
  bgmInputIndex?: number;
  assPath: string;
  width: number;
  height: number;
  totalDurationSec: number;
}

/**
 * Build the ffmpeg `-filter_complex` string for Mode C (presenter full-frame +
 * B-roll inserts) or asset_only. Each scene becomes a trimmed+scaled video
 * segment; segments are concatenated, subtitles burned via the ASS file, and
 * audio mixed (continuous talking-head voiceover + ducked BGM, or BGM-only).
 *
 * Note: image assets must be fed to ffmpeg with `-loop 1` (runner's job) so
 * `trim=duration=D` produces frames; this builder is agnostic to image/video.
 */
export function buildFilterGraph(args: BuildFilterGraphArgs): FilterGraphResult {
  const { width, height, assPath, totalDurationSec } = args;
  const parts: string[] = [];
  const videoLabels: string[] = [];

  // Returns a scaled+padded chain. `inPrefix` is the source-label prefix
  // INCLUDING the trailing comma that connects into `scale` (e.g. "[0:v]trim=...,").
  const scaledChain = (inPrefix: string, outLabel: string): string =>
    `${inPrefix}scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30${outLabel}`;

  args.segments.forEach((seg, i) => {
    const outLabel = `[v${i}]`;
    if (
      seg.role === "presenter" &&
      args.mode === "presenter_broll" &&
      args.talkingHeadInputIndex !== undefined
    ) {
      // Trim the talking-head video to this scene's window.
      parts.push(
        scaledChain(
          `[${args.talkingHeadInputIndex}:v]trim=start=${seg.startSec}:duration=${seg.durationSec},setpts=PTS-STARTPTS,`,
          outLabel
        )
      );
    } else {
      const idx = seg.assetId != null ? args.assetInputIndex[seg.assetId] : undefined;
      if (idx === undefined) {
        // No asset resolved — black color source keeps concat consistent.
        parts.push(`color=c=black:s=${width}x${height}:d=${seg.durationSec},fps=30${outLabel}`);
      } else {
        parts.push(
          scaledChain(`[${idx}:v]trim=duration=${seg.durationSec},setpts=PTS-STARTPTS,`, outLabel)
        );
      }
    }
    videoLabels.push(outLabel);
  });

  // Concat all video segments, then burn subtitles.
  parts.push(`${videoLabels.join("")}concat=n=${videoLabels.length}:v=1:a=0[vcat]`);
  parts.push(`[vcat]subtitles='${escapeFilterPath(assPath)}'[vsub]`);

  // Audio: presenter_broll uses continuous talking-head voiceover (+ducked BGM);
  // asset_only uses BGM only (or silent track if no BGM).
  if (args.mode === "presenter_broll" && args.talkingHeadInputIndex !== undefined) {
    parts.push(
      `[${args.talkingHeadInputIndex}:a]atrim=duration=${totalDurationSec},apad,aresample=async=1[avoice]`
    );
    if (args.bgmInputIndex !== undefined) {
      parts.push(`[${args.bgmInputIndex}:a]volume=-20dB,atrim=duration=${totalDurationSec}[abgm]`);
      parts.push(`[avoice][abgm]amix=inputs=2:duration=first:dropout_transition=0[aout]`);
      return { filterComplex: parts.join(";"), mapVideo: "[vsub]", mapAudio: "[aout]" };
    }
    return { filterComplex: parts.join(";"), mapVideo: "[vsub]", mapAudio: "[avoice]" };
  }

  if (args.bgmInputIndex !== undefined) {
    parts.push(`[${args.bgmInputIndex}:a]volume=-12dB,atrim=duration=${totalDurationSec}[abgm]`);
    return { filterComplex: parts.join(";"), mapVideo: "[vsub]", mapAudio: "[abgm]" };
  }

  parts.push(
    `anullsrc=channel_layout=stereo:sample_rate=44100,atrim=duration=${totalDurationSec}[aout]`
  );
  return { filterComplex: parts.join(";"), mapVideo: "[vsub]", mapAudio: "[aout]" };
}
