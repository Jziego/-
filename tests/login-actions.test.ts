import { describe, it, expect, vi, beforeEach } from "vitest";

// `@/auth` pulls in next-auth which needs next/server — mock it out for jsdom.
// vi.hoisted lets the factory reference the mock safely (vi.mock is hoisted).
const { signInMock } = vi.hoisted(() => ({ signInMock: vi.fn() }));
vi.mock("@/auth", () => ({
  signIn: signInMock,
  signOut: vi.fn(),
  auth: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({
  rateLimitLogin: vi.fn().mockResolvedValue(true),
  getClientIp: vi.fn().mockReturnValue("127.0.0.1"),
}));

// session-blacklist imports ioredis; stub it so module evaluation stays hermetic.
vi.mock("@/lib/session-blacklist", () => ({
  revokeSession: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

import { sendMagicLink } from "@/app/login/actions";

describe("sendMagicLink", () => {
  beforeEach(() => {
    signInMock.mockReset();
    signInMock.mockResolvedValue(undefined);
  });

  it("sends the magic-link with redirectTo=/ so users land on the dashboard after clicking the link, not trapped on /login/verify", async () => {
    await sendMagicLink("owner@example.com");

    expect(signInMock).toHaveBeenCalledWith(
      "email",
      expect.objectContaining({ email: "owner@example.com", redirectTo: "/" })
    );
  });
});
