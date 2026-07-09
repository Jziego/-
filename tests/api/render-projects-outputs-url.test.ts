import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET } from "@/app/api/render-projects/outputs/[id]/url/route";
import { getRenderRepository } from "@/lib/repositories";
import { resetRuntimeStateForTests } from "@/lib/runtime-store";
import { createId, nowIso } from "@/lib/ids";
import type { VideoOutput, VideoOutputKind } from "@/lib/types";

// Keep tests on the in-memory repositories regardless of host DATABASE_URL.
const savedDbUrl = process.env.DATABASE_URL;

function createTestOutput(
  ownerId: string,
  overrides: Partial<VideoOutput> = {}
): VideoOutput {
  return {
    id: createId("output"),
    ownerId,
    renderProjectId: null,
    storageKey: `renders/proj_${createId("vid")}/output.mp4`,
    aspectRatio: "9:16",
    durationSeconds: 30,
    kind: "final_composite" as VideoOutputKind,
    status: "ready",
    createdAt: nowIso(),
    ...overrides
  };
}

function callRoute(id: string): Promise<Response> {
  const req = new Request(`http://localhost/api/render-projects/outputs/${id}/url`);
  return GET(req, { params: Promise.resolve({ id }) });
}

describe("GET /api/render-projects/outputs/[id]/url", () => {
  beforeEach(() => {
    delete process.env.DATABASE_URL;
    resetRuntimeStateForTests();
    // getSignedUrl signs locally without a network call; dummy creds are enough
    // to exercise the real storage path end-to-end in the route test.
    process.env.OBJECT_STORAGE_ENDPOINT = "http://127.0.0.1:9000";
    process.env.OBJECT_STORAGE_BUCKET = "ai-video-assistant";
    process.env.OBJECT_STORAGE_ACCESS_KEY_ID = "testkey";
    process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY = "testsecret";
    process.env.OBJECT_STORAGE_REGION = "us-east-1";
    // S3 client is module-cached; reset so it picks up the test env vars.
    delete process.env.OBJECT_STORAGE_PUBLIC_URL;
  });

  afterEach(() => {
    if (savedDbUrl) process.env.DATABASE_URL = savedDbUrl;
  });

  it("returns a presigned url for the owner's output", async () => {
    const { resetS3ClientForTests } = await import("@/lib/storage");
    resetS3ClientForTests();

    const output = createTestOutput("demo_user");
    await getRenderRepository().createOutput(output);

    const res = await callRoute(output.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.url).toBe("string");
    // Path-style presigned URL embeds the key — proves the route forwarded
    // the right storageKey, not some other key.
    expect(body.url).toContain(output.storageKey);
  });

  it("returns 404 when the output does not exist", async () => {
    const { resetS3ClientForTests } = await import("@/lib/storage");
    resetS3ClientForTests();

    const res = await callRoute("output_missing");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  it("returns 404 when the output belongs to another owner (IDOR guard)", async () => {
    const { resetS3ClientForTests } = await import("@/lib/storage");
    resetS3ClientForTests();

    // Requester resolves to demo_user (demoOwnerId); output is foreign.
    const output = createTestOutput("other_user");
    await getRenderRepository().createOutput(output);

    const res = await callRoute(output.id);
    expect(res.status).toBe(404);
  });
});
