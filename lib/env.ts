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
