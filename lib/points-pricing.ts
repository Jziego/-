/**
 * 积分定价（10 积分 = ¥1）。服务端扣减点与前端 script-confirm 展示共用此唯一来源。
 * 调价只改这里。成本依据（2026-09 与需求方确认）：
 * 写稿 ≈¥0.02/次 · 渲染基础 ≈¥0.15/次（豆包TTS+ffmpeg）· 数字人 ≈¥1.1/60s（火山对口型 ¥1/分钟 + TTS）
 */
export const POINTS_PER_YUAN = 10;

/** 生成口播稿 */
export const SCRIPT_DRAFT_POINTS = 10;
/** 生成数字人形象：名义防滥用费——后端成本为 0（CosyVoice 创建音色免费），纯拦截反复上传 */
export const AVATAR_CREATE_POINTS = 10;
/** 渲染视频基础（TTS + 合成，无数字人） */
export const RENDER_BASE_POINTS = 30;
/** 每个出镜数字人（火山对口型按分钟计费的大头） */
export const AVATAR_APPEARANCE_POINTS = 250;

/** 渲染总价 = 基础 + 250 × 出镜形象数。形象数取渲染请求校验后的数量（0~3）。 */
export function renderPointsCost(avatarCount: number): number {
  return RENDER_BASE_POINTS + AVATAR_APPEARANCE_POINTS * Math.max(0, avatarCount);
}
