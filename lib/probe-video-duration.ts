/**
 * 浏览器端读取视频时长（秒）：建一个临时 video 元素读元数据。
 * 仅可在客户端组件使用（依赖 DOM）。读取失败（浏览器不支持该编码/容器、
 * 流式 webm 时长为 Infinity 等）返回 0——调用方应放行，由 HeyGen 在创建
 * 分身时做权威校验。
 */
export function probeVideoDurationSec(file: File): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    const done = (sec: number) => {
      URL.revokeObjectURL(url);
      resolve(sec);
    };
    video.preload = "metadata";
    video.onloadedmetadata = () => done(Number.isFinite(video.duration) ? video.duration : 0);
    video.onerror = () => done(0);
    video.src = url;
  });
}
