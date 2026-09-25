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
  // ffmpeg-static 在模块加载时用 __dirname 解析二进制路径，打包后 __dirname
  // 会漂移到 .next/server/chunks/ 导致运行时 ENOENT——必须保持外部化。
  serverExternalPackages: ["@prisma/client", "@prisma/adapter-pg", "pg", "ioredis", "ffmpeg-static"],
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
    },
    // ── Zeabur 构建容器 OOM 治理 ──
    // 多核构建机上 Next 按 CPU 核数派生 page-data/静态生成 worker，每个 worker
    // 继承 --max-old-space-size 形成独立堆，并发导入 prisma 等模块会把容器总内存
    // 撑爆（堆上限越大死得越快）。限制并发 + 官方内存优化，用构建时长换稳定。
    webpackMemoryOptimizations: true,
    cpus: 4,
    staticGenerationMaxConcurrency: 4
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
