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

// ── 对口型出镜底板素材约束（火山 MediaKit，2026-09-16 探针实测后确立）──────────
//
// 与 HeyGen 训练素材的差异：对口型不做训练/克隆，素材是"人脸底板"——成片直接
// 复用原视频像素、只改嘴部。因此：
//  - 时长要求大幅降低（10s 即可，画面不够时 MediaKit 镜像循环）；
//  - 大小上限大幅放宽（MediaKit 支持 ≤5GB，应用侧取 200MB 与全局上传上限对齐）。
// 内容约束（单人真人、水平 ±45°/俯仰 ±15°、非 HDR）无法在入口机检，
// 由 MediaKit 任务失败时的错误信息透出，UI 引导重拍。

/** 对口型底板最短时长（秒）：太短镜像循环穿帮明显。 */
export const LIPSYNC_MIN_FOOTAGE_DURATION_SEC = 10;
/** 对口型底板最长时长（秒）：底板素材 3 分钟足够，更长只是浪费每次任务的拉取带宽。 */
export const LIPSYNC_MAX_FOOTAGE_DURATION_SEC = 3 * 60;
/** 对口型底板大小上限：200MiB（与全局 MAX_UPLOAD_BYTES 对齐）。 */
export const LIPSYNC_MAX_FOOTAGE_BYTES = 200 * 1024 * 1024;

/** 大小校验：超限返回用户可读的中文提示，否则 null。 */
export function validateLipSyncFootageSize(sizeBytes: number): string | null {
  if (sizeBytes > LIPSYNC_MAX_FOOTAGE_BYTES) {
    const mb = Math.round(sizeBytes / 1024 / 1024);
    return `视频文件过大（约 ${mb}MB）：出镜底板上限 200MB。请剪辑到 3 分钟以内，或在手机相机设置里把录像分辨率调低后重拍。`;
  }
  return null;
}

/**
 * 时长校验：超出 10s–3min 返回中文提示，否则 null。
 * durationSec <= 0 表示前端读不出元数据——放行，由 MediaKit 做权威校验。
 */
export function validateLipSyncFootageDuration(durationSec: number): string | null {
  if (durationSec <= 0) {
    return null;
  }
  if (durationSec < LIPSYNC_MIN_FOOTAGE_DURATION_SEC) {
    return `视频太短（${Math.round(durationSec)} 秒）：出镜底板需要 10 秒–3 分钟（建议 30 秒以上更自然），请重新拍摄。`;
  }
  if (durationSec > LIPSYNC_MAX_FOOTAGE_DURATION_SEC) {
    const min = Math.floor(durationSec / 60);
    const sec = Math.round(durationSec % 60);
    return `视频太长（${min} 分 ${sec} 秒）：出镜底板最长 3 分钟，请剪辑后再上传。`;
  }
  return null;
}
