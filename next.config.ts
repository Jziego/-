import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";
import { getSentryOrg, getSentryProject, getSentryAuthToken, getSentryDsn } from "@/lib/env";

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
  serverExternalPackages: ["@prisma/client", "@prisma/adapter-pg", "pg", "ioredis"],
  env: {
    NEXT_PUBLIC_APP_MODE: process.env.APP_MODE ?? "demo"
  },
  allowedDevOrigins: parseAllowedDevOrigins(),
  webpack: (config, { nextRuntime }) => {
    // ioredis uses Node.js builtins (net, tls, diagnostics_channel) that are
    // unavailable in Edge runtime. Externalize it so the dynamic import in
    // middleware.ts can fail gracefully at runtime (try/catch handles this).
    if (nextRuntime === "edge") {
      config.externals = [...(config.externals || []), "ioredis"];
    }
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
  org: getSentryOrg() ?? "",
  project: getSentryProject() ?? "",
  silent: !process.env.CI,
  authToken: getSentryAuthToken(),
  sourcemaps: {
    disable: !process.env.CI,
  },
});

export default getSentryDsn() ? sentryConfig : nextConfig;

if (process.env.NODE_ENV === "development") {
  void import("@opennextjs/cloudflare").then(({ initOpenNextCloudflareForDev }) => {
    initOpenNextCloudflareForDev();
  });
}
