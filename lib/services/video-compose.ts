import type { Asset, ScriptScene, VideoOutput } from "@/lib/types";

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
 * Build a flat timeline of segments from scenes, accumulating durationSeconds
 * into [startSec, endSec] windows. Broll segments resolve a selected asset via
 * assetHint intersection (tags/businessTags); presenter segments get null.
 * When no hint matches, falls back to round-robin over selectedAssetIds.
 */
export function buildTimeline(args: {
  scenes: ScriptScene[];
  assets: Asset[];
  selectedAssetIds: string[];
}): TimelineSegment[] {
  const selectedIds = args.selectedAssetIds;
  let cursor = 0;
  let rr = 0;

  return args.scenes.map((scene) => {
    const duration = Math.max(scene.durationSeconds, 0.1);
    const start = cursor;
    const end = cursor + duration;
    cursor = end;

    const assetId =
      scene.role === "broll"
        ? resolveAssetForScene(scene, args.assets, selectedIds, () => {
            const id = selectedIds[rr % Math.max(selectedIds.length, 1)];
            rr += 1;
            return id ?? null;
          })
        : null;

    return {
      role: scene.role,
      startSec: start,
      endSec: end,
      durationSec: duration,
      sceneOrder: scene.order,
      text: scene.text,
      assetId
    };
  });
}

function resolveAssetForScene(
  scene: ScriptScene,
  assets: Asset[],
  selectedIds: string[],
  fallback: () => string | null
): string | null {
  const hints = new Set(scene.assetHints.map((h) => h.toLowerCase()));
  const selected = new Set(selectedIds);
  const match = assets.find((a) =>
    selected.has(a.id) &&
    [...(a.tags ?? []), ...(a.businessTags ?? [])].some((t) =>
      hints.has(String(t).toLowerCase())
    )
  );
  if (match) return match.id;
  return fallback();
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
