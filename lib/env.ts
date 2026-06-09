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
