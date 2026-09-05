/**
 * HeyGen 数字人训练素材约束（2026-09-05 生产事故后确立）。
 *
 * 背景：HeyGen 创建 digital_twin 对素材有双重要求——
 *  1. 时长 30 秒–5 分钟（训练质量要求，HeyGen 官方拍摄指南）；
 *  2. 文件硬上限 32MB（/v3/assets 直传实测：89.3MB 素材被 400 拒，
 *     "File is too large (89.3 MB). Maximum size is 32 MB."）。
 *
 * 我们不压缩用户原视频（用户决策），改为在上传入口就拦截超限素材。
 * 应用侧上限取 30MiB，对 HeyGen 的 32MiB 留安全边距。
 */

/** HeyGen 训练素材最短时长（秒）：少于 30s 训练不出可用分身。 */
export const MIN_FOOTAGE_DURATION_SEC = 30;
/** HeyGen 训练素材最长时长（秒）。 */
export const MAX_FOOTAGE_DURATION_SEC = 5 * 60;
/** 应用侧文件大小上限：30MiB（HeyGen 硬上限 32MiB 留边距）。 */
export const MAX_FOOTAGE_BYTES = 30 * 1024 * 1024;

/** 大小校验：超限返回用户可读的中文提示，否则 null。 */
export function validateFootageSize(sizeBytes: number): string | null {
  if (sizeBytes > MAX_FOOTAGE_BYTES) {
    const mb = Math.round(sizeBytes / 1024 / 1024);
    return `视频文件过大（约 ${mb}MB）：上限 30MB。请缩短视频时长，或在手机相机设置里把录像分辨率调低（如 720p）后重拍。`;
  }
  return null;
}

/**
 * 时长校验：超出 30s–5min 返回中文提示，否则 null。
 * durationSec <= 0 表示前端读不出元数据（浏览器不支持该编码）——放行，
 * 由 HeyGen 在创建分身时做权威校验并经状态轮询回报具体原因。
 */
export function validateFootageDuration(durationSec: number): string | null {
  if (durationSec <= 0) {
    return null;
  }
  if (durationSec < MIN_FOOTAGE_DURATION_SEC) {
    return `视频太短（${Math.round(durationSec)} 秒）：分身训练素材需要 30 秒–5 分钟，请重新拍摄。`;
  }
  if (durationSec > MAX_FOOTAGE_DURATION_SEC) {
    const min = Math.floor(durationSec / 60);
    const sec = Math.round(durationSec % 60);
    return `视频太长（${min} 分 ${sec} 秒）：分身素材最长 5 分钟，请剪辑到 5 分钟以内再上传。`;
  }
  return null;
}
