import type { NextConfig } from "next";

function parseAllowedDevOrigins(): string[] {
  const raw = process.env.DEV_ALLOWED_ORIGINS ?? "192.168.5.9";

  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      if (entry.startsWith("http://") || entry.startsWith("https://")) {
        return new URL(entry).hostname;
      }
      // Next.js matches dev origins by hostname (no port).
      return entry.includes(":") ? entry.split(":")[0]! : entry;
    });
}

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_APP_MODE: process.env.APP_MODE ?? "demo"
  },
  allowedDevOrigins: parseAllowedDevOrigins(),
  experimental: {
    serverActions: {
      bodySizeLimit: "20mb"
    }
  }
};

export default nextConfig;

if (process.env.NODE_ENV === "development") {
  void import("@opennextjs/cloudflare").then(({ initOpenNextCloudflareForDev }) => {
    initOpenNextCloudflareForDev();
  });
}
