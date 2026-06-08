# AI Video Assistant

Production-oriented SaaS prototype for local shop owners to create short marketing videos with store profiles, asset analysis, digital avatar fallbacks, AI copywriting and queued render jobs.

## Local Setup

```bash
npm install
npm run dev
```

Copy `.env.example` to `.env` when wiring real PostgreSQL, Redis, object storage or third-party AI providers.

`APP_MODE` defaults to `demo` and shows a UI badge. Set `APP_MODE=production` when you are ready to remove the demo indicator.

## Architecture Notes

- The primary runtime is **Zeabur (Node.js + `next start`)**, not Cloudflare Workers. BullMQ, ffmpeg and long-lived Redis connections require a full Node process.
- Web and Worker are separate processes (Worker arrives in Phase 3).
- Without `DATABASE_URL`, APIs fall back to in-memory storage for local development.
- With `DATABASE_URL`, data persists in PostgreSQL via the repository layer.

## Zeabur Deployment

1. Create a Zeabur project (Hong Kong region recommended).
2. Add the **PostgreSQL** plugin and bind it to the web service (`DATABASE_URL` is injected automatically).
3. Set environment variables:
   - `APP_MODE=demo` for internal previews, or `production` when ready
   - `REDIS_URL` (Phase 3+)
   - Object storage credentials (Phase 2+)
4. Deploy from this repository. `zbpack.json` runs `prisma migrate deploy` before `next start`.
5. Run `npm run db:seed` once against the production database (or rely on seed in your deploy pipeline).

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
