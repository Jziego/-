# CLAUDE.md — AI Video Assistant

## Project Overview

SaaS prototype for an AI-powered short-video assistant targeting local shop owners.
Users upload product assets → AI generates marketing scripts → render short videos
with optional AI avatar (HeyGen) voiceover.

- **Stack:** Next.js 16 (App Router), React 19, Tailwind CSS 4, TypeScript 6
- **Data:** PostgreSQL + Prisma 7, Redis + BullMQ
- **AI:** OpenAI-compatible API (`OPENAI_BASE_URL`), HeyGen avatar provider
- **Storage:** AWS S3-compatible object storage
- **Deploy:** Zeabur (Node.js `next start` + Worker)
- **Package manager:** npm

## Directory Map

| Directory | Purpose |
|-----------|---------|
| `app/api/` | Next.js API route handlers (guarded by `middleware.ts`) |
| `lib/` | Shared utilities, repositories, services, types |
| `lib/repositories/` | Data access layer (Prisma + in-memory fallback) |
| `lib/services/` | Business logic: AI client, script engine, render pipeline, avatar provider |
| `prisma/` | Schema + migrations |
| `worker/` | Background job worker (BullMQ consumer) |
| `.github/workflows/` | CI pipeline |

## Code Conventions

### API Routes
- Use `jsonOk(data, status?)` / `jsonError(message, status?)` from `lib/api-response.ts`
- Parse JSON body with try/catch around `request.json()` — return 400 on parse failure
- Validate required fields manually before calling services
- Use `safeParse` from Zod schemas when a schema exists (`lib/schemas.ts`)
- Auth model: call `getOwnerId()` from `lib/auth-helpers.ts` at the start of every handler — returns the logged-in user id, or falls back to `demoOwnerId` only in demo mode. Canonical pattern: `app/api/assets/route.ts`. Never read `demoOwnerId` directly in a route.

### Repository Pattern
- Each entity has a repository interface in `lib/repositories/types.ts`
- Two implementations: `lib/repositories/prisma.ts` (production) and `lib/repositories/memory.ts` (demo/fallback)
- Use `getXxxRepository()` factory functions from `lib/repositories/index.ts`

### Naming
- IDs use `createId("prefix")` from `lib/ids.ts` → format `prefix_<uuid>`
- Dates use `nowIso()` from `lib/ids.ts` → ISO 8601 string

### TypeScript
- Strict mode enabled; run `npm run typecheck` before committing
- Types in `lib/types.ts`; Zod schemas in `lib/schemas.ts`

## Security Rules — Review Checklist

These MUST be checked in every PR review:

### 1. Authentication & Authorization
- **Current state:** Auth is LIVE (Phase 5 + 5b). NextAuth v5 (`auth.ts`) with JWT sessions, PrismaAdapter, and providers: Email (magic-link via Resend, dev fallback logs the URL) + WeChat (registered when `hasWechatProvider()`). Custom pages: `/login`, `/login/verify`.
- **Dual mode via `APP_MODE` env (default `demo`):**
  - `demo` — middleware allows all traffic; `getOwnerId()` falls back to `demoOwnerId` when there is no session. For local dev / preview.
  - `production` — middleware guards every non-public path: API → 401 JSON, pages → redirect to `/login`. Also runs Redis IP rate-limiting and JWT session-blacklist checks.
- **`middleware.ts` runs on Node.js runtime (NOT Edge)** so `ioredis` is available for blacklist + rate-limit. Public paths: `/api/auth`, `/api/health`, `/login`, `/_next`.
- **Every API route MUST obtain ownerId via `getOwnerId()`** from `lib/auth-helpers.ts` — never trust a client-supplied `ownerId`, never read `demoOwnerId` directly. Pattern: `const ownerId = await getOwnerId();` (see `app/api/assets/route.ts`).
- **New routes MUST NOT** invent ad-hoc auth — reuse `getOwnerId()` / `requireAuth()` and the existing middleware.

### 2. Input Validation
- Always validate `request.json()` bodies: catch parse errors, check required fields, validate types.
- File uploads via `upload-intent`: **never trust client-supplied `contentType`** without server-side MIME verification after upload.
- `sizeBytes` from clients: cap at a reasonable maximum (e.g., 500 MB for video).
- Zod schemas should be used wherever `lib/schemas.ts` has a matching schema — add new schemas for new endpoints.

### 3. AI / LLM Security
- **Prompt injection is a real risk.** User-supplied store profile data (product names, descriptions) flows into AI prompts via `lib/services/script-engine.ts` and `ai-client.ts`. Never pass raw user input as system prompts.
- The `chatCompletion` system prompt should always be server-authored, never user-supplied.
- Log AI responses? Strip API keys and PII first.

### 4. Secrets & Environment
- `OPENAI_API_KEY`, `AVATAR_PROVIDER_API_KEY`, `DATABASE_URL`, `REDIS_URL`, S3 credentials — **NEVER log these, never serialize to JSON responses, never commit to git.**
- `lib/env.ts` accessor functions already trim values — use them instead of reading `process.env` directly.
- The `.env` file is in `.gitignore` — verify before adding new env vars.

### 5. Database
- Prisma's parameterized queries prevent SQL injection — **never use raw SQL with string interpolation.** If raw SQL is needed, use `$queryRaw` with template parameters only.
- Database URL contains credentials — never expose in error messages or logs.

### 6. Redis / Queue
- **Fallback connection** in `lib/queue.ts:15` uses `127.0.0.1:6379` with no password when `REDIS_URL` is unset. This is fine for local dev but **must be guarded in production** — ensure `REDIS_URL` is always set in deployed environments.
- Job payloads are stored in Redis — don't put API keys, passwords, or full PII in job payloads.
- **Middleware depends on Redis** for IP rate-limiting and JWT session-blacklist checks (`lib/session-blacklist.ts`). When Redis is unavailable the blacklist **fail-opens** (revoked sessions stay valid until JWT expiry) — so in production `REDIS_URL` must be set for logout / session revocation to actually take effect.

### 7. Object Storage (S3)
- Pre-signed upload URLs should have the shortest practical expiration.
- `storageKey` values should be opaque (UUID-based), not derived from user input.
- Never generate public-read URLs for user assets unless explicitly intended.

### 8. General Web Security
- **CORS:** Verify the app has appropriate CORS headers before production launch.
- **Rate limiting:** Implemented — Redis-backed per-IP limiting in `middleware.ts` (`rateLimitByIp`) plus per-owner API limiting in `lib/rate-limit.ts` (`applyRateLimit`, with separate read/write buckets). Confirm the correct bucket when adding new endpoints.
- **Dependencies:** Run `npm audit` periodically; this project has many dependencies.
- **Error messages:** Don't leak stack traces or internal paths to clients; `jsonError` already handles this, but ensure new code doesn't bypass it.

## Testing
- Framework: Vitest (run with `npm test`)
- Integration tests with `@testing-library/react`
- Repository tests should work against both Prisma and memory implementations
- CI runs: `npm test && npm run typecheck && npm run lint && npx prisma validate && npm run build`

## Common Pitfalls
- `request.json()` can only be called ONCE per request — store the result in a variable
- The memory repository is shared state (module-level `Map`) — tests may interfere with each other
- BullMQ FlowProducer connections must be explicitly closed after use to avoid leaks (see `render-projects/route.ts` for pattern)
- Next.js 16 edge runtime: some Node.js APIs are unavailable; prefer Web APIs where possible
