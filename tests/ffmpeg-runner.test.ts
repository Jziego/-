import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { runFfmpeg } from "@/lib/services/ffmpeg-runner";
import { buildFilterGraph, buildAss } from "@/lib/services/video-compose";

const hasFfmpeg = (() => {
  try {
    execSync("ffmpeg -version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const runner = hasFfmpeg ? describe : describe.skip;

runner("ffmpeg runner (requires the ffmpeg binary)", () => {
  it("renders an asset_only mp4 from a color image + burned subtitle", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ff-runner-"));
    try {
      const imgPath = join(dir, "img.png");
      // 2s solid red 1080x1920 test image (single frame)
      execSync(
        'ffmpeg -hide_banner -loglevel error -f lavfi -i "color=c=red:s=1080x1920:d=2" -update 1 -frames:v 1 ' +
          imgPath,
        { stdio: "ignore" }
      );

      const segs = [
        { role: "broll" as const, startSec: 0, endSec: 2, durationSec: 2, sceneOrder: 1, text: "测试字幕", assetId: "a1" }
      ];
      const assPath = join(dir, "subs.ass");
      writeFileSync(assPath, buildAss(segs, "default"), "utf8");

      const filter = buildFilterGraph({
        mode: "asset_only",
        segments: segs,
        assetInputIndex: { a1: 0 },
        assPath,
        width: 1080,
        height: 1920,
        totalDurationSec: 2
      });

      const outPath = join(dir, "out.mp4");
      await runFfmpeg({
        inputs: [{ path: imgPath, isImage: true }],
        filter,
        outputPath: outPath,
        durationSec: 2
      });

      expect(existsSync(outPath)).toBe(true);
      expect(statSync(outPath).size).toBeGreaterThan(1000);
      // mp4 'ftyp' box sanity (bytes 4..7 are ASCII 'ftyp')
      expect(readFileSync(outPath).subarray(4, 8).toString("latin1")).toBe("ftyp");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
