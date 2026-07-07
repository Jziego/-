import ffmpeg from "fluent-ffmpeg";
import type { FilterGraphResult } from "@/lib/services/video-compose";

export interface FfmpegInput {
  path: string;
  /** true for image inputs — ffmpeg needs `-loop 1` to extend a single frame. */
  isImage: boolean;
}

export interface RunFfmpegArgs {
  /** Ordered local file paths; index order matches the filter graph's input indices. */
  inputs: FfmpegInput[];
  filter: FilterGraphResult;
  outputPath: string;
  durationSec: number;
  onProgress?: (pct: number) => void;
}

/**
 * Execute ffmpeg via fluent-ffmpeg using a complexFilter (built by
 * buildFilterGraph). Outputs H.264/aac mp4. `onProgress` receives 0..100
 * (fluent-ffmpeg reports percent against the duration). Rejects on any error.
 */
export function runFfmpeg(args: RunFfmpegArgs): Promise<void> {
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg();
    for (const input of args.inputs) {
      cmd.input(input.path);
      if (input.isImage) {
        // -loop 1 must be applied to the image input so trim=duration produces
        // frames (fluent-ffmpeg emits inputOptions before their -i).
        cmd.inputOptions(["-loop 1"]);
      }
    }

    cmd.complexFilter(args.filter.filterComplex)
      .outputOptions([
        "-map",
        args.filter.mapVideo,
        "-map",
        args.filter.mapAudio,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "128k"
      ])
      .duration(args.durationSec)
      .output(args.outputPath);

    if (args.onProgress) {
      cmd.on("progress", (p: { percent?: number }) => {
        if (typeof p.percent === "number" && Number.isFinite(p.percent)) {
          args.onProgress!(Math.max(0, Math.min(100, Math.round(p.percent))));
        }
      });
    }

    cmd.on("end", () => resolve());
    cmd.on("error", (err: Error) => reject(new Error(`ffmpeg failed: ${err.message}`)));
    cmd.run();
  });
}
