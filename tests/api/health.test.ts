import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/health/route";

describe("GET /api/health", () => {
  it("returns ok status with mode and object storage check", async () => {
    const response = await GET();
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.status).toBeDefined();
    expect(body.mode).toMatch(/demo|production/);
    expect(body.checks.objectStorage).toMatch(/configured|missing/);
  });
});
