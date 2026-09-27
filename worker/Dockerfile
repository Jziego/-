# Worker service for AI Video Assistant
# Deployed as a separate Zeabur service alongside the Next.js web service.
#
# Shares the same codebase (lib/, prisma/) as the web service but only runs
# the BullMQ worker processes. Connects to the same PostgreSQL + Redis
# instances that the web service uses.

FROM node:20-alpine AS base
WORKDIR /app

# Install system dependencies for Prisma + ffmpeg (video composite) + CJK font
# (subtitle burn: ASS Style hardcodes "Noto Sans CJK SC" → needs font-noto-cjk).
RUN apk add --no-cache openssl ffmpeg font-noto-cjk

# Copy package files
COPY package.json package-lock.json* ./
COPY prisma/ ./prisma/

# Install all dependencies (worker shares root codebase)
RUN npm ci

# Generate Prisma client
RUN npx prisma generate

# Copy the entire codebase (worker uses shared lib/)
COPY . .

# The worker runs on a different port or no port (it's a worker, not a server)
EXPOSE 3001

# 8GB 机（2026-09-28 从 4GB 升级）：V8 默认堆上限随物理内存膨胀到 ~4GB，
# 仍要显式限 1.5GB 让 V8 提前 GC 而不是被 OOM-kill；原 4GB 时代限 1GB，
# 升级后放宽换吞吐。注意：Zeabur 构建管线会丢弃本 ENV——运行时的实际值以
# Zeabur 服务变量 NODE_OPTIONS 为准（两者应保持一致）。
ENV NODE_OPTIONS=--max-old-space-size=1536

# Health check — worker doesn't serve HTTP, so we check the process
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD pgrep -f "worker/index.ts" || exit 1

# Run the worker with tsx
CMD ["npx", "tsx", "worker/index.ts"]
