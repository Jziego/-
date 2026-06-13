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
  serverExternalPackages: ["@prisma/client", "@prisma/adapter-pg", "pg"],
  env: {
    NEXT_PUBLIC_APP_MODE: process.env.APP_MODE ?? "demo"
  },
  allowedDevOrigins: parseAllowedDevOrigins(),
  webpack: (config) => {
    // @auth/core imports nodemailer as a conditional dependency of the email provider.
    // We override sendVerificationRequest with Resend, so nodemailer is never called.
    // Tell webpack to resolve it as an empty module to avoid a "Module not found" error.
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

export default nextConfig;

if (process.env.NODE_ENV === "development") {
  void import("@opennextjs/cloudflare").then(({ initOpenNextCloudflareForDev }) => {
    initOpenNextCloudflareForDev();
  });
}
