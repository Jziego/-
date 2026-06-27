import { auth } from "@/auth";
import { getAppMode } from "@/lib/env";
import { NextResponse } from "next/server";
import { rateLimitByIp, getClientIp } from "@/lib/rate-limit";
import { isSessionRevoked } from "@/lib/session-blacklist";

// Middleware runs on the Node.js runtime (not Edge) so that ioredis is available
// for JWT session-blacklist checks and Redis-backed IP rate limiting. Under Edge
// runtime ioredis is unavailable and isSessionRevoked() silently fail-opens.
export const runtime = "nodejs";

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

  // API routes: IP rate limit (before auth, Redis-backed, multi-instance safe)
  if (pathname.startsWith("/api/")) {
    const ip = getClientIp(req.headers);
    const ipCheck = await rateLimitByIp(ip);
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

    // JWT blacklist check (session revocation).
    // isSessionRevoked returns false when Redis is unconfigured (fail-open), but
    // may throw on a transient Redis connection error (enableOfflineQueue: false).
    // Wrap in try/catch and fail-open to avoid 500ing every request during a blip.
    const jti = (req.auth.user as { jti?: string })?.jti;
    if (jti) {
      try {
        if (await isSessionRevoked(jti)) {
          const response = NextResponse.json(
            { error: "Session revoked", code: "session_revoked" },
            { status: 401 },
          );
          response.cookies.delete("authjs.session-token");
          return response;
        }
      } catch (err) {
        console.warn(
          "[middleware] session blacklist check failed, fail-open:",
          err instanceof Error ? err.message : String(err),
        );
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
  const jti = (req.auth.user as { jti?: string })?.jti;
  if (jti) {
    try {
      if (await isSessionRevoked(jti)) {
        const response = NextResponse.redirect(new URL("/login", req.url));
        response.cookies.delete("authjs.session-token");
        return response;
      }
    } catch (err) {
      console.warn(
        "[middleware] session blacklist check failed, fail-open:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return NextResponse.next();
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
