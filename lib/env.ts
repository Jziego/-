export type AppMode = "demo" | "production";

export function getAppMode(): AppMode {
  const mode = process.env.APP_MODE ?? "demo";
  return mode === "production" ? "production" : "demo";
}

export function hasDatabase(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}

export function getDatabaseUrl(): string | undefined {
  return process.env.DATABASE_URL?.trim() || undefined;
}

export function hasObjectStorage(): boolean {
  return Boolean(
    process.env.OBJECT_STORAGE_ENDPOINT?.trim() &&
      process.env.OBJECT_STORAGE_BUCKET?.trim() &&
      process.env.OBJECT_STORAGE_ACCESS_KEY_ID?.trim() &&
      process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY?.trim()
  );
}

export function hasRedis(): boolean {
  return Boolean(process.env.REDIS_URL?.trim());
}

export function getRedisUrl(): string | undefined {
  return process.env.REDIS_URL?.trim() || undefined;
}

export function getAuthSecret(): string | undefined {
  return process.env.AUTH_SECRET?.trim() || undefined;
}

export function getAuthUrl(): string | undefined {
  return process.env.AUTH_URL?.trim() || undefined;
}

export function getResendApiKey(): string | undefined {
  return process.env.RESEND_API_KEY?.trim() || undefined;
}

export function getEmailFrom(): string {
  return process.env.EMAIL_FROM?.trim() || "AI短视频助手 <noreply@resend.dev>";
}

export function getAvatarProviderName(): string | undefined {
  return process.env.AVATAR_PROVIDER?.trim() || undefined;
}

export function getAvatarProviderApiKey(): string | undefined {
  return process.env.AVATAR_PROVIDER_API_KEY?.trim() || undefined;
}

export function hasAvatarProvider(): boolean {
  const name = getAvatarProviderName();
  const key = getAvatarProviderApiKey();
  return Boolean(name && name !== "mock-avatar" && key);
}

export function getAIReasoningEffort(): "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined {
  // AI_REASONING_EFFORT：推理强度。默认 low——deepseek-v4-flash 推理 token 计入
  // max_tokens，不限制时 reasoning 会耗尽预算导致 content 为空/截断。
  // 设为 "off" 则不传该参数（用于不识别的 OpenAI 兼容端点）。
  const v = process.env.AI_REASONING_EFFORT?.trim().toLowerCase();
  if (v === "off") return undefined;
  if (v === "none" || v === "minimal" || v === "low" || v === "medium" || v === "high" || v === "xhigh") return v;
  return "low";
}

// ── HeyGen (avatar provider) tuning ──────────────────────────────────────────

export function getHeygenAvatarTemplateId(): string | undefined {
  return process.env.HEYGEN_AVATAR_TEMPLATE_ID?.trim() || undefined;
}

export function getHeygenVoiceId(): string | undefined {
  return process.env.HEYGEN_VOICE_ID?.trim() || undefined;
}

export function getHeygenPollIntervalMs(): number {
  const raw = Number(process.env.HEYGEN_POLL_INTERVAL_MS?.trim());
  return Number.isFinite(raw) && raw > 0 ? raw : 5000;
}

export function getHeygenPollMaxAttempts(): number {
  const raw = Number(process.env.HEYGEN_POLL_MAX_ATTEMPTS?.trim());
  return Number.isFinite(raw) && raw > 0 ? raw : 60;
}

// ── Sentry ───────────────────────────────────────────────────────────────────

export function getSentryDsn(): string | undefined {
  return process.env.SENTRY_DSN?.trim() || undefined;
}

export function getSentryOrg(): string | undefined {
  return process.env.SENTRY_ORG?.trim() || undefined;
}

export function getSentryProject(): string | undefined {
  return process.env.SENTRY_PROJECT?.trim() || undefined;
}

export function getSentryAuthToken(): string | undefined {
  return process.env.SENTRY_AUTH_TOKEN?.trim() || undefined;
}

// ── WeChat OAuth ─────────────────────────────────────────────────────────────

export function getWechatAppId(): string | undefined {
  return process.env.WECHAT_APP_ID?.trim() || undefined;
}

export function getWechatAppSecret(): string | undefined {
  return process.env.WECHAT_APP_SECRET?.trim() || undefined;
}

export function hasWechatProvider(): boolean {
  return Boolean(getWechatAppId() && getWechatAppSecret());
}

// ── 火山引擎对口型（MediaKit + 豆包 TTS）────────────────────────────────────
// 对口型供应商双 Key：MediaKit 管视频改口型任务，豆包语音管配音合成。
// 2026-09-16 实测：两个产品线 Key 不通用（MediaKit Key 调语音服务 401）。

export function getMediakitApiKey(): string | undefined {
  return process.env.MEDIKIT_API_KEY?.trim() || undefined;
}

export function getMediakitBaseUrl(): string {
  return process.env.MEDIKIT_BASE_URL?.trim() || "https://mediakit.cn-beijing.volces.com";
}

export function getMediakitPollIntervalMs(): number {
  const raw = Number(process.env.MEDIKIT_POLL_INTERVAL_MS?.trim());
  return Number.isFinite(raw) && raw > 0 ? raw : 15_000;
}

export function getMediakitPollTimeoutMs(): number {
  const raw = Number(process.env.MEDIKIT_POLL_TIMEOUT_MS?.trim());
  return Number.isFinite(raw) && raw > 0 ? raw : 40 * 60_000;
}

export function getDoubaoTtsApiKey(): string | undefined {
  return process.env.DOUBAO_TTS_API_KEY?.trim() || undefined;
}

/** 豆包 TTS 2.0 音色（发音人 id）。后续声音复刻上线后按形象写 providerVoiceId 覆盖。 */
export function getDoubaoTtsVoice(): string {
  return process.env.DOUBAO_TTS_VOICE?.trim() || "zh_female_vv_uranus_bigtts";
}

/** 计费/模型资源位：seed-tts-2.0（标准音色）；声音复刻上线后改 seed-icl-2.0。 */
export function getDoubaoTtsResourceId(): string {
  return process.env.DOUBAO_TTS_RESOURCE_ID?.trim() || "seed-tts-2.0";
}

export function hasLipSyncProvider(): boolean {
  return Boolean(getMediakitApiKey() && getDoubaoTtsApiKey());
}
