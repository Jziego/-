import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-client";
import { fetchJobs } from "@/lib/api-client";
import { shouldRetryQuery } from "@/lib/query-config";

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("shouldRetryQuery", () => {
  it("never retries a 429 rate-limit error (stops death-spiral)", () => {
    expect(shouldRetryQuery(0, new ApiError("rate_limited", 429))).toBe(false);
    expect(shouldRetryQuery(1, new ApiError("rate_limited", 429))).toBe(false);
  });

  it("never retries other 4xx client errors (401/404)", () => {
    expect(shouldRetryQuery(0, new ApiError("Unauthorized", 401))).toBe(false);
    expect(shouldRetryQuery(0, new ApiError("Not found", 404))).toBe(false);
  });

  it("retries a 5xx server error once, then stops", () => {
    expect(shouldRetryQuery(0, new ApiError("boom", 500))).toBe(true);
    expect(shouldRetryQuery(1, new ApiError("boom", 500))).toBe(false);
  });

  it("retries a non-ApiError (network blip) once, then stops", () => {
    expect(shouldRetryQuery(0, new Error("network"))).toBe(true);
    expect(shouldRetryQuery(1, new Error("network"))).toBe(false);
  });
});

describe("api() error contract", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("throws ApiError carrying the HTTP status on a 429", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ error: "rate_limited", retryAfter: 30 }, 429)
    );
    const p = fetchJobs();
    await expect(p).rejects.toBeInstanceOf(ApiError);
    await expect(p).rejects.toMatchObject({ status: 429, message: "rate_limited" });
  });

  it("still surfaces the error message for downstream message-based handlers", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ error: "Object storage is not configured" }, 503)
    );
    await expect(fetchJobs()).rejects.toMatchObject({
      message: "Object storage is not configured",
      status: 503
    });
  });
});
