import { describe, expect, it, vi } from "vitest";
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
    expect(args).toContain("-map_metadata -1");
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

  it("ffmpeg 抛错 → 净化为音频提取失败，不泄漏服务器路径", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { deps } = makeDeps(20);
      deps.execFileAsync = async () => {
        throw new Error("Command failed: /fake/ffmpeg 秘密路径 -ss 5 ...\nstderr 详情");
      };
      let caught: unknown;
      try {
        await extractVoiceSampleFromVideo({ footageBytes: new Uint8Array([1]) }, deps);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      const message = (caught as Error).message;
      expect(message).toMatch(/音频提取失败/);
      expect(message).not.toContain("秘密路径");
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("removeDir 在成功路径与 exec 抛错路径都被调用", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // 成功路径
      const ok = makeDeps(20);
      let removedOk = 0;
      ok.deps.removeDir = () => { removedOk += 1; };
      await extractVoiceSampleFromVideo({ footageBytes: new Uint8Array([1]) }, ok.deps);
      expect(removedOk).toBe(1);

      // exec 抛错路径
      const fail = makeDeps(20);
      fail.deps.execFileAsync = async () => { throw new Error("boom"); };
      let removedFail = 0;
      fail.deps.removeDir = () => { removedFail += 1; };
      await expect(
        extractVoiceSampleFromVideo({ footageBytes: new Uint8Array([1]) }, fail.deps),
      ).rejects.toThrow(/音频提取失败/);
      expect(removedFail).toBe(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("footageBytes 为空 → 报为空，且不建临时目录、不调 ffmpeg、不清理", async () => {
    const { deps } = makeDeps(20);
    let tmpCount = 0;
    let execCount = 0;
    let removed = 0;
    deps.makeTmpDir = () => { tmpCount += 1; return "/tmp/vs-test"; };
    deps.execFileAsync = async () => { execCount += 1; };
    deps.removeDir = () => { removed += 1; };
    await expect(
      extractVoiceSampleFromVideo({ footageBytes: new Uint8Array(0) }, deps),
    ).rejects.toThrow(/为空/);
    expect(tmpCount).toBe(0);
    expect(execCount).toBe(0);
    expect(removed).toBe(0);
  });
});
