import { describe, expect, it } from "vitest";
import { generateOtpCode } from "@/lib/auth/otp";

describe("generateOtpCode", () => {
  it("returns a 6-digit numeric string (zero-padded)", () => {
    for (let i = 0; i < 100; i++) {
      const code = generateOtpCode();
      expect(code).toMatch(/^\d{6}$/);
    }
  });
});
