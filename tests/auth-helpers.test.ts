import { describe, expect, it, vi } from "vitest";

// The auth-helpers module imports from @/auth which pulls in next-auth, which
// requires next/server — unavailable in the jsdom test environment.
vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

describe("UnauthorizedError", () => {
  it("has the correct name and message", async () => {
    const { UnauthorizedError } = await import("@/lib/auth-helpers");
    const err = new UnauthorizedError();
    expect(err.name).toBe("UnauthorizedError");
    expect(err.message).toBe("Unauthorized");
  });
});
