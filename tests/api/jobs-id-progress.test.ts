import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET } from "@/app/api/jobs/[id]/progress/route";
import { getJobRepository } from "@/lib/repositories";
import { resetRuntimeStateForTests } from "@/lib/runtime-store";
import { createId } from "@/lib/ids";
import type { Job } from "@/lib/types";

const savedDbUrl = process.env.DATABASE_URL;

function makeJob(ownerId: string, status: Job["status"] = "completed"): Job {
  return {
    id: createId("job"),
    ownerId,
    projectId: createId("proj"),
    type: "video_render",
    status,
    progress: status === "completed" ? 100 : 0,
    payload: {},
    dependsOnJobIds: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("GET /api/jobs/[id]/progress — IDOR guard", () => {
  beforeEach(() => {
    delete process.env.DATABASE_URL;
    resetRuntimeStateForTests();
  });
  afterEach(() => {
    if (savedDbUrl) process.env.DATABASE_URL = savedDbUrl;
  });

  it("returns 404 for another owner's job before opening the stream", async () => {
    const job = makeJob("other_user");
    await getJobRepository().createMany([job]);
    const res = await GET(
      new Request(`http://localhost/api/jobs/${job.id}/progress`),
      ctx(job.id),
    );
    expect(res.status).toBe(404);
  });

  it("returns 200 for the owner's own terminal job", async () => {
    const job = makeJob("demo_user", "completed");
    await getJobRepository().createMany([job]);
    const res = await GET(
      new Request(`http://localhost/api/jobs/${job.id}/progress`),
      ctx(job.id),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
  });
});
