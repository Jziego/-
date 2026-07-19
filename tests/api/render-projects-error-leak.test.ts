import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getScriptRepository } from "@/lib/repositories";
import { resetRuntimeStateForTests } from "@/lib/runtime-store";
import { createId, nowIso } from "@/lib/ids";
import type { ScriptDraft } from "@/lib/types";

// Hoisted state lets the module-level vi.mock factory (which runs BEFORE any
// `beforeEach`) trigger the throw only inside the one assertion that needs it.
// Outside that test the queue mock is inert (just provides shape-compatible stubs).
const state = vi.hoisted(() => ({ shouldThrow: false }));

// Secret with the exact shape of a real ioredis/BullMQ error — internal host
// and port that must NEVER reach the HTTP response body.
const SECRET = "connect ECONNREFUSED redis-cluster.internal.svc:6379";

// Mock @/lib/queue at module level (hoisted). The real implementation pulls
// `bullmq` and constructs connections we don't want during tests.
vi.mock("@/lib/queue", () => ({
  createBullQueue: () => ({ add: vi.fn(), close: vi.fn() }),
  createFlowProducer: () => {
    if (state.shouldThrow) {
      throw new Error(SECRET);
    }
    return { add: vi.fn(), close: vi.fn() };
  },
  toFlowJobs: (jobs: { id: string }[]) => [
    { name: jobs[0]!.id, queueName: "video-render", data: {}, opts: {}, children: [] },
  ],
  toQueuePayload: (j: { id: string }) => ({ data: { jobId: j.id }, opts: {} }),
}));

// Ensure tests use memory repositories even when DATABASE_URL is configured.
const savedDbUrl = process.env.DATABASE_URL;
const savedRedisUrl = process.env.REDIS_URL;

function makeScriptDraft(): ScriptDraft {
  return {
    id: createId("script"),
    ownerId: "demo_user",
    storeId: createId("store"),
    purpose: "promotion",
    platform: "douyin",
    title: "t",
    hook: "h",
    scenes: [{ order: 1, text: "x", durationSeconds: 2, assetHints: [], role: "presenter" }],
    voiceover: "v",
    captions: ["c"],
    cta: "cta",
    generationMode: "ai",
    complianceWarnings: [],
    createdAt: nowIso(),
  };
}

function req(body: unknown): Request {
  return new Request("http://localhost/api/render-projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/render-projects — error leak", () => {
  beforeEach(() => {
    delete process.env.DATABASE_URL;
    resetRuntimeStateForTests();
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    state.shouldThrow = false;
    // Suppress the expected console.error from the route's catch block.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    if (savedDbUrl) process.env.DATABASE_URL = savedDbUrl;
    if (savedRedisUrl) process.env.REDIS_URL = savedRedisUrl;
    else delete process.env.REDIS_URL;
    vi.restoreAllMocks();
  });

  it("does not leak internal Redis error messages to the client on enqueue failure", async () => {
    const draft = makeScriptDraft();
    await getScriptRepository().create(draft);

    // Trigger the outer enqueue try-block to throw an infrastructure-shaped error.
    state.shouldThrow = true;

    const { POST } = await import("@/app/api/render-projects/route");
    const res = await POST(req({ scriptDraftId: draft.id }));
    const body = await res.json();
    const serialized = JSON.stringify(body);

    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toMatch(/redis-cluster|ECONNREFUSED|6379/i);
  });
});
