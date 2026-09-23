import { describe, expect, it } from "vitest";
import {
  extractVoiceSampleFromVideo,
  SAMPLE_BYTES_PER_SEC,
  type VoiceSampleDeps,
} from "@/lib/services/voice-sample";

/** 构造假 wav：44 字节头 + PCM 数据，时长 = dataSize/48000。 */
function fakeWav(seconds: number): Uint8Array {
  const size = 44 + Math.round(seconds * SAMPLE_BYTES_PER_SEC);
  const buf = new Uint8Array(size);
  buf.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  return buf;
}

function makeDeps(wavSeconds: number) {
  const calls: string[][] = [];
  const deps: VoiceSampleDeps = {
    ffmpegPath: "/fake/ffmpeg",
    execFileAsync: async (_cmd, args) => { calls.push(args); },
    writeFileFn: async () => {},
    readFileFn: async () => fakeWav(wavSeconds),
    makeTmpDir: () => "/tmp/vs-test",
    removeDir: () => {},
  };
  return { deps, calls };
}

describe("extractVoiceSampleFromVideo", () => {
  it("默认跳开头 5s 抽 20s，返回 wav 字节与时长", async () => {
    const { deps, calls } = makeDeps(20);
    const result = await extractVoiceSampleFromVideo({ footageBytes: new Uint8Array([1, 2, 3]) }, deps);
    expect(result.durationSec).toBe(20);
    expect(result.wavBytes.length).toBeGreaterThan(44);
    const args = calls[0]!.join(" ");
    expect(args).toContain("-ss 5");
    expect(args).toContain("-t 20");
    expect(args).toContain("-ar 24000");
    expect(args).toContain("-ac 1");
  });

  it("跳头后不足 10s → 从头重抽一次", async () => {
    let n = 0;
    const { deps, calls } = makeDeps(0);
    deps.readFileFn = async () => fakeWav(++n === 1 ? 6 : 20);
    const result = await extractVoiceSampleFromVideo({ footageBytes: new Uint8Array([1]) }, deps);
    expect(result.durationSec).toBe(20);
    expect(calls.length).toBe(2);
    expect(calls[1]!.join(" ")).toContain("-ss 0");
  });

  it("从头抽仍不足 10s → 报视频太短", async () => {
    const { deps } = makeDeps(6);
    await expect(
      extractVoiceSampleFromVideo({ footageBytes: new Uint8Array([1]) }, deps),
    ).rejects.toThrow(/15 秒/);
  });
});
