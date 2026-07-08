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

# Health check — worker doesn't serve HTTP, so we check the process
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD pgrep -f "worker/index.ts" || exit 1

# Run the worker with tsx
CMD ["npx", "tsx", "worker/index.ts"]
