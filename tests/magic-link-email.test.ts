import { describe, it, expect } from "vitest";
import { renderMagicLinkEmail } from "@/lib/auth/magic-link-email";

describe("renderMagicLinkEmail", () => {
  const url =
    "https://app.example.com/api/auth/callback/email?callbackUrl=%2F&token=abc&email=owner%40example.com";

  it("embeds the magic-link as a clickable anchor", () => {
    const html = renderMagicLinkEmail(url);
    expect(html).toContain(`href="${url}"`);
  });

  it("also surfaces the raw URL as copyable text for email clients that block anchor clicks", () => {
    const html = renderMagicLinkEmail(url);
    // URL must appear at least twice: once inside href, once as copyable text.
    const occurrences = html.split(url).length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
    // And there must be a human hint telling the user to copy the link.
    expect(html).toMatch(/复制|无法点击|无法打开/);
  });
});
