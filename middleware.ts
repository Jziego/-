import { auth } from "@/auth";
import { getAppMode } from "@/lib/env";
import { NextResponse } from "next/server";

// ── In-memory IP rate limiter (coarse, per-instance) ─────────────────────────
//
// IMPORTANT LIMITATIONS (by design — this is a first line of defense, not the
// primary rate limiter; per-route L2 limits in lib/rate-limit.ts provide the
// authoritative enforcement):
//
// 1. Per-instance, not global: the Map lives in process memory. In multi-instance
//    deployments (serverless, edge, or multi-container), each instance has its
//    own counter. A malicious client routed across N instances gets N× the limit.
//    The per-route rate limiter (Redis-backed) catches what this misses.
//
// 2. Edge Runtime caveat: setInterval is unavailable in Edge, so expired entries
//    are only evicted on access (checkIpRateLimit's `entry.reset <= now` branch).
//    This means the Map grows unbounded in pure Edge deployments; the per-route
//    rate limiter and Cloudflare's own DDoS protection mitigate this.
//
// 3. IP spoofing: x-forwarded-for can be forged if not behind a trusted proxy.
//    Cloudflare sets this header reliably; if deployed elsewhere, ensure a
//    trusted proxy layer strips client-supplied x-forwarded-for headers.

const IP_RATE_LIMIT_WINDOW = 60_000; // 60 seconds
const IP_RATE_LIMIT_MAX = 60;        // 60 requests per window

const ipStore = new Map<string, { count: number; reset: number }>();

// Purge expired IP entries every 60s
if (typeof setInterval !== "undefined") {
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of ipStore) {
      if (entry.reset <= now) ipStore.delete(key);
    }
  }, 60_000);
}

function checkIpRateLimit(ip: string): { allowed: boolean } {
  const now = Date.now();
  const entry = ipStore.get(ip);
  if (!entry || entry.reset <= now) {
    ipStore.set(ip, { count: 1, reset: now + IP_RATE_LIMIT_WINDOW });
    return { allowed: true };
  }
  entry.count++;
  return { allowed: entry.count <= IP_RATE_LIMIT_MAX };
}

function getClientIpFromHeaders(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim() || "unknown";
  return request.headers.get("x-real-ip") ?? "unknown";
}

// ── Middleware ────────────────────────────────────────────────────────────────

export default auth(async (req) => {
  // demo: allow all traffic
  if (getAppMode() === "demo") return NextResponse.next();

  const { pathname } = req.nextUrl;

  // Public paths (accessible without login)
  if (
    pathname.startsWith("/api/auth") ||
    pathname === "/api/health" ||
    pathname.startsWith("/login") ||
    pathname.startsWith("/_next")
  ) {
    return NextResponse.next();
  }

  // IP-based rate limit for API routes (before auth, coarse protection)
  if (pathname.startsWith("/api/")) {
    const ip = getClientIpFromHeaders(req as unknown as Request);
    const ipCheck = checkIpRateLimit(ip);
    if (!ipCheck.allowed) {
      return NextResponse.json(
        { error: "rate_limited", message: "Too many requests" },
        { status: 429 },
      );
    }
  }

  // API routes: auth + blacklist check
  if (pathname.startsWith("/api/")) {
    if (!req.auth) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // JWT blacklist check (session revocation)
    // Wrapped in try/catch because isSessionRevoked uses ioredis which may
    // not be available in Edge runtime — fail-open is safe here.
    const jti = (req.auth.user as any)?.jti as string | undefined;
    if (jti) {
      try {
        const { isSessionRevoked } = await import("@/lib/session-blacklist");
        const revoked = await isSessionRevoked(jti);
        if (revoked) {
          const response = NextResponse.json(
            { error: "Session revoked", code: "session_revoked" },
            { status: 401 },
          );
          response.cookies.delete("authjs.session-token");
          return response;
        }
      } catch {
        // ioredis unavailable in Edge runtime — fail-open
      }
    }

    return NextResponse.next();
  }

  // Page routes: redirect to /login with callbackUrl
  if (!req.auth) {
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("callbackUrl", req.nextUrl.pathname);
    return NextResponse.redirect(loginUrl);
  }

  // JWT blacklist check for page routes
  const jti = (req.auth.user as any)?.jti as string | undefined;
  if (jti) {
    try {
      const { isSessionRevoked } = await import("@/lib/session-blacklist");
      const revoked = await isSessionRevoked(jti);
      if (revoked) {
        const response = NextResponse.redirect(new URL("/login", req.url));
        response.cookies.delete("authjs.session-token");
        return response;
      }
    } catch {
      // ioredis unavailable in Edge — fail-open
    }
  }

  return NextResponse.next();
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
