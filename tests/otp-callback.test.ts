import { describe, expect, it } from "vitest";
import { buildOtpCallbackUrl } from "@/app/login/verify/otp-callback";

describe("buildOtpCallbackUrl", () => {
  it("builds the NextAuth email callback URL with encoded params", () => {
    const url = buildOtpCallbackUrl("a+b@example.com", "123456");
    expect(url).toBe(
      "/api/auth/callback/email?email=a%2Bb%40example.com&token=123456&callbackUrl=%2F",
    );
  });
});
