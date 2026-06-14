import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

// ── Mock next/headers ─────────────────────────────────────────────────────────
// next-auth calls headers() / cookies() from "next/headers" internally.
// In vitest + jsdom there is no Next.js request context, so we provide
// minimal stubs that return empty state. Tests that need specific header
// or cookie values should mock these at the individual test level.

vi.mock("next/headers", () => ({
  headers: vi.fn(() => new Headers()),
  cookies: vi.fn(() => ({
    get: vi.fn(() => undefined),
    set: vi.fn(),
    delete: vi.fn(),
    getAll: vi.fn(() => []),
    has: vi.fn(() => false),
  })),
}));
