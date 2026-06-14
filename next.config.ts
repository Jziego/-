import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

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
      return entry.includes(":") ? entry.split(":")[0]! : entry;
    });
}

const nextConfig: NextConfig = {
  serverExternalPackages: ["@prisma/client", "@prisma/adapter-pg", "pg"],
  env: {
    NEXT_PUBLIC_APP_MODE: process.env.APP_MODE ?? "demo"
  },
  allowedDevOrigins: parseAllowedDevOrigins(),
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      nodemailer: false,
      "@react-email/render": false,
    };
    return config;
  },
  experimental: {
    serverActions: {
      bodySizeLimit: "20mb"
    }
  }
};

const sentryConfig = withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG ?? "",
  project: process.env.SENTRY_PROJECT ?? "",
  silent: !process.env.CI,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  sourcemaps: {
    disable: !process.env.CI,
  },
});

export default process.env.SENTRY_DSN ? sentryConfig : nextConfig;

if (process.env.NODE_ENV === "development") {
  void import("@opennextjs/cloudflare").then(({ initOpenNextCloudflareForDev }) => {
    initOpenNextCloudflareForDev();
  });
}
