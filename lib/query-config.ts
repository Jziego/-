import { ApiError } from "@/lib/api-client";

/**
 * react-query retry policy for the dashboard.
 *
 * Problem this solves: the dashboard issues many /api requests (mount queries,
 * 5s polling, refetch-on-focus). With react-query's default `retry: 3`, a single
 * 429 rate-limit response fans out into 3 retries, each another /api request —
 * which exhausts the L0 IP rate limit (60/min) further and sustains a 429
 * death-spiral that blocks even unrelated requests (e.g. asset upload).
 *
 * Rule: never retry 4xx (they won't self-correct; 429 especially must not
 * amplify). Allow a single bounded retry for transient 5xx / network errors.
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
    return false;
  }
  return failureCount < 1;
}
