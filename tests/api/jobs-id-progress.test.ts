import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/jobs/[id]/progress/route";
import { getJobRepository } from "@/lib/repositories";
import { MemoryJobRepository } from "@/lib/repositories/memory";
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

describe("GET /api/jobs/[id]/progress — slim polling", () => {
  beforeEach(() => {
    delete process.env.DATABASE_URL;
    resetRuntimeStateForTests();
  });
  afterEach(() => {
    if (savedDbUrl) process.env.DATABASE_URL = savedDbUrl;
  });

  it("polls with findProgressById (4 slim columns) instead of full-row findById", async () => {
    const job = makeJob("demo_user", "processing");
    await getJobRepository().createMany([job]);
    const findByIdSpy = vi.spyOn(MemoryJobRepository.prototype, "findById");
    const progressSpy = vi.spyOn(MemoryJobRepository.prototype, "findProgressById");

    vi.useFakeTimers();
    try {
      const res = await GET(
        new Request(`http://localhost/api/jobs/${job.id}/progress`),
        ctx(job.id),
      );
      expect(res.status).toBe(200);
      // 开流前的属主校验 + 初始状态允许一次全行读取
      expect(findByIdSpy).toHaveBeenCalledTimes(1);
      expect(progressSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2000); // 触发 2 次 1s 轮询

      expect(progressSpy).toHaveBeenCalled();
      // 轮询阶段绝不能再拉全行（payload JSON 列）
      expect(findByIdSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("MemoryJobRepository.findProgressById", () => {
  beforeEach(() => {
    resetRuntimeStateForTests();
  });

  it("returns exactly the 4 progress columns for an existing job", async () => {
    const repo = new MemoryJobRepository();
    const job = makeJob("demo_user", "failed");
    job.error = "render crashed";
    await repo.createMany([job]);

    const progress = await repo.findProgressById(job.id);

    expect(progress).not.toBeNull();
    expect(Object.keys(progress!).sort()).toEqual(["error", "id", "progress", "status"]);
    expect(progress).toEqual({
      id: job.id,
      status: "failed",
      progress: 0,
      error: "render crashed"
    });
  });

  it("returns null for a missing job", async () => {
    const repo = new MemoryJobRepository();
    expect(await repo.findProgressById("job_missing")).toBeNull();
  });
});
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
