import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveFfmpegPath } from "@/lib/services/ffmpeg-binary";

/** 阿里样本要求：≥16kHz、10~20s 连续清晰人声。统一 24kHz s16 mono（与探针一致）。 */
const SAMPLE_RATE = 24000;
export const SAMPLE_BYTES_PER_SEC = SAMPLE_RATE * 2; // s16 mono
/** 官方推荐 10~20s；低于 10s 克隆质量差 → fail-fast。 */
export const MIN_SAMPLE_SEC = 10;
const SAMPLE_SEC = 20;
/** 跳过开头 5s（开场常有杂音/BGM 淡入）；短视频自动回退从头取。 */
const SKIP_HEAD_SEC = 5;
/** 标准 wav 头 44 字节；ffmpeg 输出恒定此布局，时长按 (size-44)/字节每秒 估算。 */
const WAV_HEADER_BYTES = 44;

export interface VoiceSampleResult {
  wavBytes: Uint8Array;
  durationSec: number;
}

export interface VoiceSampleDeps {
  ffmpegPath: string;
  execFileAsync: (cmd: string, args: string[]) => Promise<unknown>;
  writeFileFn: (path: string, data: Uint8Array) => Promise<unknown>;
  readFileFn: (path: string) => Promise<Uint8Array>;
  makeTmpDir: () => string;
  removeDir: (dir: string) => void;
}

const defaultExec = promisify(execFile);

/**
 * 底板视频 → 克隆样本 wav。样本只在内存/临时目录流转，调用方用完即弃
 * （声纹属生物特征，不落 R2、不留存）。
 */
export async function extractVoiceSampleFromVideo(
  input: { footageBytes: Uint8Array },
  deps?: Partial<VoiceSampleDeps>,
): Promise<VoiceSampleResult> {
  if (!input.footageBytes || input.footageBytes.length === 0) {
    throw new Error("底板视频字节为空——无法提取克隆样本");
  }
  const d: VoiceSampleDeps = {
    ffmpegPath: deps?.ffmpegPath ?? resolveFfmpegPath(),
    execFileAsync: deps?.execFileAsync ?? (defaultExec as unknown as VoiceSampleDeps["execFileAsync"]),
    writeFileFn: deps?.writeFileFn ?? (async (p, data) => { await writeFile(p, data); }),
    readFileFn: deps?.readFileFn ?? (async (p) => new Uint8Array(await readFile(p))),
    makeTmpDir: deps?.makeTmpDir ?? (() => mkdtempSync(join(tmpdir(), "voice-sample-"))),
    removeDir: deps?.removeDir ?? ((dir) => rmSync(dir, { recursive: true, force: true })),
  };

  const dir = d.makeTmpDir();
  try {
    const inputPath = join(dir, "footage.bin");
    await d.writeFileFn(inputPath, input.footageBytes);
    for (const skipHead of [SKIP_HEAD_SEC, 0]) {
      const outPath = join(dir, "sample.wav");
      await d.execFileAsync(d.ffmpegPath, [
        "-y", "-ss", String(skipHead), "-t", String(SAMPLE_SEC), "-i", inputPath,
        "-vn", "-ac", "1", "-ar", String(SAMPLE_RATE), "-sample_fmt", "s16", outPath,
      ]);
      const wavBytes = await d.readFileFn(outPath);
      const durationSec = Math.max(0, (wavBytes.length - WAV_HEADER_BYTES) / SAMPLE_BYTES_PER_SEC);
      if (durationSec >= MIN_SAMPLE_SEC) {
        return { wavBytes, durationSec };
      }
      // 跳头后不足 → 从头重抽一次；已是从头仍不足 → 落到循环后报错
    }
    throw new Error("视频太短或有效人声不足——请录制 15 秒以上的口播视频");
  } finally {
    d.removeDir(dir);
  }
}
