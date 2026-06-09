# AI Video Assistant

Production-oriented SaaS prototype for local shop owners to create short marketing videos with store profiles, asset analysis, digital avatar fallbacks, AI copywriting and queued render jobs.

## Local Setup

```bash
npm install
cp .env.example .env
npm run dev
```

`APP_MODE` defaults to `demo` and shows a UI badge. Set `APP_MODE=production` when you are ready to remove the demo indicator.

Copy `.env.example` to `.env` when wiring PostgreSQL, Redis, object storage or third-party AI providers.

## Object Storage (Phase 2)

Browser uploads use **presigned PUT URLs**: the web API signs an upload intent, the browser uploads directly to storage, then `POST /api/assets/confirm` verifies the object with `HeadObject` before creating the `Asset` row.

### Local — MinIO via Docker Compose

```bash
docker compose up -d
```

MinIO defaults (also in `.env.example`):

| Setting | Value |
|---------|-------|
| API endpoint | `http://127.0.0.1:9000` |
| Console | `http://127.0.0.1:9001` |
| Access key | `minioadmin` |
| Secret key | `minioadmin` |
| Bucket | `ai-video-assistant` |

Point your `.env` at MinIO:

```bash
OBJECT_STORAGE_ENDPOINT="http://127.0.0.1:9000"
OBJECT_STORAGE_BUCKET="ai-video-assistant"
OBJECT_STORAGE_ACCESS_KEY_ID="minioadmin"
OBJECT_STORAGE_SECRET_ACCESS_KEY="minioadmin"
OBJECT_STORAGE_REGION="us-east-1"
```

For browser PUT uploads from `localhost:3000`, configure the bucket CORS policy in the MinIO console (or `mc admin config`) to allow `PUT` and `Content-Type` from your dev origin.

### Production — Cloudflare R2 on Zeabur

1. In Cloudflare Dashboard → **R2** → create bucket `ai-video-assistant`.
2. **Manage R2 API Tokens** → create an S3-compatible token with read/write on that bucket.
3. In the R2 bucket **Settings → CORS**, allow your Zeabur app origin:

   - Allowed methods: `PUT`, `GET`, `HEAD`
   - Allowed headers: `Content-Type`
   - Allowed origins: `https://<your-zeabur-domain>`

4. Inject these variables on the Zeabur **web service**:

| Variable | Example / notes |
|----------|-----------------|
| `OBJECT_STORAGE_ENDPOINT` | `https://<account_id>.r2.cloudflarestorage.com` |
| `OBJECT_STORAGE_BUCKET` | `ai-video-assistant` |
| `OBJECT_STORAGE_ACCESS_KEY_ID` | R2 access key ID |
| `OBJECT_STORAGE_SECRET_ACCESS_KEY` | R2 secret access key |
| `OBJECT_STORAGE_REGION` | `auto` |
| `OBJECT_STORAGE_PUBLIC_URL` | Optional CDN/custom domain prefix for public asset URLs |

When `APP_MODE=production` and object storage env vars are missing, upload APIs return **503** (no fake URLs).

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
   - `OBJECT_STORAGE_*` — see [Production — Cloudflare R2](#production--cloudflare-r2-on-zeabur) above
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
- Route handlers that demonstrate BFF boundaries for store sync, signed upload intents, upload confirm, asset analysis, script drafts, avatar requests and render jobs.
- S3-compatible object storage (MinIO locally, Cloudflare R2 in production) with presigned browser uploads.
- Service-layer fallbacks for unavailable asset analysis, AI copy generation, talking-head generation and full render failure.
- BullMQ queue payload helpers and object storage URL helpers for production integration points.
