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
