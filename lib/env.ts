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
