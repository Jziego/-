import { describe, it, expect } from "vitest";
import { renderOtpEmail } from "@/lib/auth/otp-email";

describe("renderOtpEmail", () => {
  it("contains the code, fallback link and 10-minute notice", () => {
    const html = renderOtpEmail("123456", "https://app.example.com/api/auth/callback/email?token=123456");
    expect(html).toContain("123456");
    expect(html).toContain("https://app.example.com/api/auth/callback/email?token=123456");
    expect(html).toContain("10 分钟");
  });
});
