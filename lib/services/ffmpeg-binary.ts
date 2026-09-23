import { execFileSync } from "node:child_process";
import ffmpegStatic from "ffmpeg-static";

export interface FfmpegBinaryDeps {
  /** 系统 ffmpeg 探测（默认 exec -version）；测试注入。 */
  execCheck: () => boolean;
  /** ffmpeg-static 包解析出的路径（无平台二进制时为 null）；测试注入。 */
  staticPath: string | null;
}

/**
 * ffmpeg 路径解析：系统 PATH 优先（worker Docker 已装），回退 ffmpeg-static
 * 自带二进制（web 进程 Zeabur 自动构建无 ffmpeg，靠它覆盖）。
 */
export function resolveFfmpegPath(deps?: Partial<FfmpegBinaryDeps>): string {
  const execCheck = deps?.execCheck ?? (() => {
    try {
      execFileSync("ffmpeg", ["-version"], { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  });
  if (execCheck()) return "ffmpeg";
  const staticPath = deps?.staticPath !== undefined ? deps.staticPath : (ffmpegStatic as string | null);
  if (staticPath) return staticPath;
  throw new Error("找不到 ffmpeg：系统 PATH 无 ffmpeg 且 ffmpeg-static 无本平台二进制");
}
