import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/env", () => ({
  hasRedis: vi.fn(),
  getRedisUrl: vi.fn(),
}));

const mockPipeline = {
  set: vi.fn().mockReturnThis(),
  exec: vi.fn().mockResolvedValue([]),
};

const mockRedis = {
  set: vi.fn().mockResolvedValue("OK"),
  exists: vi.fn().mockResolvedValue(0),
  pipeline: vi.fn(() => mockPipeline),
};

vi.mock("ioredis", () => ({
  Redis: vi.fn().mockImplementation(function () {
    return mockRedis;
  }),
}));

import { revokeSession, isSessionRevoked, _resetRedis } from "@/lib/session-blacklist";
import { hasRedis, getRedisUrl } from "@/lib/env";

describe("session-blacklist", () => {
  beforeEach(() => {
    _resetRedis();
    vi.clearAllMocks();
  });

  it("isSessionRevoked returns false when Redis is unavailable", async () => {
    vi.mocked(hasRedis).mockReturnValue(false);

    const result = await isSessionRevoked("test-jti-123");
    expect(result).toBe(false);
  });

  it("revokeSession is a no-op when Redis is unavailable", async () => {
    vi.mocked(hasRedis).mockReturnValue(false);

    await expect(revokeSession("test-jti-123", 3600)).resolves.toBeUndefined();
  });

  it("isSessionRevoked returns false for unknown jti when Redis is available", async () => {
    vi.mocked(hasRedis).mockReturnValue(true);
    vi.mocked(getRedisUrl).mockReturnValue("redis://localhost:6379");

    const result = await isSessionRevoked("unknown-jti-xyz");
    expect(result).toBe(false);
  });

  it("revokeSession sets a key with TTL when Redis is available", async () => {
    vi.mocked(hasRedis).mockReturnValue(true);
    vi.mocked(getRedisUrl).mockReturnValue("redis://localhost:6379");

    await revokeSession("revoke-me", 600);
    expect(mockRedis.set).toHaveBeenCalledWith("revoked:revoke-me", "1", "EX", 600);
  });

  it("isSessionRevoked returns true for a revoked jti", async () => {
    vi.mocked(hasRedis).mockReturnValue(true);
    vi.mocked(getRedisUrl).mockReturnValue("redis://localhost:6379");
    vi.mocked(mockRedis.exists).mockResolvedValue(1);

    const result = await isSessionRevoked("revoked-jti");
    expect(result).toBe(true);
    expect(mockRedis.exists).toHaveBeenCalledWith("revoked:revoked-jti");
  });
});
