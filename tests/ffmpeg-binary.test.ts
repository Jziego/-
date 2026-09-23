import { describe, expect, it } from "vitest";
import { resolveFfmpegPath } from "@/lib/services/ffmpeg-binary";

describe("resolveFfmpegPath", () => {
  it("系统 ffmpeg 可用时直接返回 'ffmpeg'", () => {
    const path = resolveFfmpegPath({ execCheck: () => true, staticPath: "/static/ffmpeg" });
    expect(path).toBe("ffmpeg");
  });

  it("系统不可用时回退 ffmpeg-static 路径", () => {
    const path = resolveFfmpegPath({ execCheck: () => false, staticPath: "/static/ffmpeg" });
    expect(path).toBe("/static/ffmpeg");
  });

  it("两者都不可用 → fail-fast", () => {
    expect(() => resolveFfmpegPath({ execCheck: () => false, staticPath: null })).toThrow(/找不到 ffmpeg/);
  });
});
