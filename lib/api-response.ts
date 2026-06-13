import { NextResponse } from "next/server";
import type { RateLimitResult } from "@/lib/rate-limit";

export function jsonOk<T>(data: T, status = 200): NextResponse<T> {
  return NextResponse.json(data, { status });
}

export function jsonError(message: string, status = 400): NextResponse<{ error: string }> {
  return NextResponse.json({ error: message }, { status });
}

// ── Quota exhausted (402) ──────────────────────────────────────────────────

export function jsonQuotaError(plan: string): Response {
  return Response.json(
    {
      error: "quota_exhausted",
      plan,
      message: `Your ${plan} plan quota is exhausted`,
    },
    { status: 402 },
  );
}

// ── Rate limited (429) ─────────────────────────────────────────────────────

export function jsonRateLimited(result: RateLimitResult): Response {
  const retryAfter = Math.max(
    0,
    result.reset - Math.floor(Date.now() / 1000),
  );
  const headers: Record<string, string> = {
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": String(result.reset),
    "Retry-After": String(retryAfter),
  };
  return Response.json(
    { error: "rate_limited", retryAfter },
    { status: 429, headers },
  );
}
