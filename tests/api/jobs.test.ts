import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET, DELETE } from "@/app/api/jobs/route";
import { getJobRepository } from "@/lib/repositories";
import { resetRuntimeStateForTests } from "@/lib/runtime-store";
import { createId } from "@/lib/ids";
import type { Job } from "@/lib/types";

const savedDbUrl = process.env.DATABASE_URL;

function makeJob(ownerId: string, createdAt: string, type: Job["type"] = "video_render"): Job {
  return {
    id: createId("job"),
    ownerId,
    projectId: createId("proj"),
    type,
    status: "completed",
    progress: 100,
    payload: {},
    dependsOnJobIds: [],
    createdAt,
    updatedAt: createdAt
  };
}

describe("GET /api/jobs", () => {
  beforeEach(() => {
    delete process.env.DATABASE_URL;
    resetRuntimeStateForTests();
  });

  afterEach(() => {
    if (savedDbUrl) process.env.DATABASE_URL = savedDbUrl;
  });

  it("returns jobs sorted newest-first", async () => {
    const repo = getJobRepository();
    await repo.createMany([
      makeJob("demo_user", "2026-01-01T00:00:01Z"),
      makeJob("demo_user", "2026-01-03T00:00:03Z"),
      makeJob("demo_user", "2026-01-02T00:00:02Z")
    ]);

    const res = await GET(new Request("http://localhost/api/jobs"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jobs[0].createdAt).toBe("2026-01-03T00:00:03Z");
    expect(body.jobs[2].createdAt).toBe("2026-01-01T00:00:01Z");
  });

  it("caps the result count so history doesn't pile up in the dashboard", async () => {
    const repo = getJobRepository();
    const many: Job[] = [];
    // 35 jobs with ascending createdAt (seconds 00..34)
    for (let i = 0; i < 35; i++) {
      many.push(makeJob("demo_user", `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`));
    }
    await repo.createMany(many);

    const res = await GET(new Request("http://localhost/api/jobs"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jobs.length).toBeLessThanOrEqual(30);
    // newest-first: the most recent createdAt must come first
    expect(body.jobs[0].createdAt).toBe("2026-01-01T00:00:34Z");
  });
});

describe("DELETE /api/jobs", () => {
  beforeEach(() => {
    delete process.env.DATABASE_URL;
    resetRuntimeStateForTests();
  });

  afterEach(() => {
    if (savedDbUrl) process.env.DATABASE_URL = savedDbUrl;
  });

  it("deletes terminal jobs (completed/failed) but keeps active ones", async () => {
    const repo = getJobRepository();
    await repo.createMany([
      makeJob("demo_user", "2026-01-01T00:00:01Z"),
      { ...makeJob("demo_user", "2026-01-01T00:00:02Z"), status: "failed", progress: 0, error: "boom" },
      { ...makeJob("demo_user", "2026-01-01T00:00:03Z"), status: "processing", progress: 50 },
      { ...makeJob("demo_user", "2026-01-01T00:00:04Z"), status: "queued", progress: 0 }
    ]);

    const res = await DELETE(new Request("http://localhost/api/jobs", { method: "DELETE" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted).toBe(2); // 1 completed + 1 failed

    const remaining = await getJobRepository().listByOwner("demo_user");
    expect(remaining).toHaveLength(2);
    expect(remaining.every((j) => j.status === "processing" || j.status === "queued")).toBe(true);
  });

  it("only deletes the requesting owner's jobs (IDOR guard)", async () => {
    const repo = getJobRepository();
    await repo.createMany([
      makeJob("demo_user", "2026-01-01T00:00:01Z"),
      makeJob("other_user", "2026-01-01T00:00:02Z")
    ]);

    const res = await DELETE(new Request("http://localhost/api/jobs", { method: "DELETE" }));
    expect(res.status).toBe(200);

    // demo_user's job gone, other_user's untouched
    expect(await getJobRepository().listByOwner("demo_user")).toHaveLength(0);
    expect(await getJobRepository().listByOwner("other_user")).toHaveLength(1);
  });
});
