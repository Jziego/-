# AI Video Assistant

Production-oriented SaaS prototype for local shop owners to create short marketing videos with store profiles, asset analysis, digital avatar fallbacks, AI copywriting and queued render jobs.

## Local Setup

```bash
npm install
npm run dev
```

Copy `.env.example` to `.env` when wiring real PostgreSQL, Redis, object storage or third-party AI providers.

## Verification

```bash
npm test
npm run typecheck
npm run lint
npx prisma validate
npm run build
```

## Implemented Scope

- Next.js App Router single-page dashboard for store profile, asset upload, avatar creation and one-click render flow.
- Zod schemas and Prisma 7 models for users, stores, assets, analyses, avatars, scripts, render projects, jobs and outputs.
- Route handlers that demonstrate BFF boundaries for store sync, signed upload intents, asset analysis, script drafts, avatar requests and render jobs.
- Service-layer fallbacks for unavailable asset analysis, AI copy generation, talking-head generation and full render failure.
- BullMQ queue payload helpers and object storage URL helpers for production integration points.
