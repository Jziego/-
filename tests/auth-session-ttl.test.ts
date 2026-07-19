import { describe, expect, it } from "vitest";
import { SESSION_MAX_AGE_SECONDS } from "@/auth";

describe("session TTL alignment", () => {
  it("exports a 30-day constant (NextAuth v5 default JWT maxAge)", () => {
    expect(SESSION_MAX_AGE_SECONDS).toBe(30 * 24 * 60 * 60);
  });
});
