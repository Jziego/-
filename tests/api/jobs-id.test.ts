import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET } from "@/app/api/jobs/[id]/route";
import { getJobRepository } from "@/lib/repositories";
import { resetRuntimeStateForTests } from "@/lib/runtime-store";
import { createId } from "@/lib/ids";
import type { Job } from "@/lib/types";

const savedDbUrl = process.env.DATABASE_URL;

function makeJob(ownerId: string): Job {
  return {
    id: createId("job"),
    ownerId,
    projectId: createId("proj"),
    type: "video_render",
    status: "completed",
    progress: 100,
    payload: {},
    dependsOnJobIds: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("GET /api/jobs/[id] — IDOR guard", () => {
  beforeEach(() => {
    delete process.env.DATABASE_URL;
    resetRuntimeStateForTests();
  });
  afterEach(() => {
    if (savedDbUrl) process.env.DATABASE_URL = savedDbUrl;
  });

  it("returns 200 for the requesting owner's own job", async () => {
    const job = makeJob("demo_user");
    await getJobRepository().createMany([job]);
    const res = await GET(new Request(`http://localhost/api/jobs/${job.id}`), ctx(job.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.job.id).toBe(job.id);
  });

  it("returns 404 for another owner's job (no existence leak)", async () => {
    const job = makeJob("other_user");
    await getJobRepository().createMany([job]);
    const res = await GET(new Request(`http://localhost/api/jobs/${job.id}`), ctx(job.id));
    expect(res.status).toBe(404);
  });

  it("returns 404 for a missing job", async () => {
    const res = await GET(new Request("http://localhost/api/jobs/job_missing"), ctx("job_missing"));
    expect(res.status).toBe(404);
  });
});
