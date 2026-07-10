import { describe, expect, it } from "vitest";
import { createId } from "@/lib/ids";
import { selectLatestBatchJobs } from "@/lib/dashboard-jobs";
import type { Job } from "@/lib/types";

function makeJob(overrides: Partial<Job> & { type: Job["type"]; createdAt: string }): Job {
  return {
    id: createId("job"),
    ownerId: "demo_user",
    status: "completed",
    progress: 100,
    payload: {},
    dependsOnJobIds: [],
    updatedAt: overrides.createdAt,
    ...overrides
  };
}

describe("selectLatestBatchJobs", () => {
  it("filters out asset_analysis, subtitle_generation and quota_monthly_reset", () => {
    const jobs = [
      makeJob({ type: "asset_analysis", createdAt: "2026-07-10T00:00:00.000Z" }),
      makeJob({ type: "subtitle_generation", createdAt: "2026-07-10T00:00:00.000Z" }),
      makeJob({ type: "quota_monthly_reset", createdAt: "2026-07-10T00:00:00.000Z" }),
      makeJob({ type: "video_render", createdAt: "2026-07-10T00:00:00.000Z" })
    ];
    const result = selectLatestBatchJobs(jobs);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("video_render");
  });

  it("returns only the latest projectId batch when several exist", () => {
    const oldBatch = [
      makeJob({ type: "avatar_generation", projectId: "proj_old", createdAt: "2026-07-09T00:00:00.000Z" }),
      makeJob({ type: "video_render", projectId: "proj_old", createdAt: "2026-07-09T00:00:01.000Z" })
    ];
    const newBatch = [
      makeJob({ type: "avatar_generation", projectId: "proj_new", createdAt: "2026-07-10T00:00:00.000Z" }),
      makeJob({ type: "video_render", projectId: "proj_new", createdAt: "2026-07-10T00:00:01.000Z" })
    ];
    const result = selectLatestBatchJobs([...oldBatch, ...newBatch]);
    expect(result).toHaveLength(2);
    expect(result.every((job) => job.projectId === "proj_new")).toBe(true);
  });

  it("treats jobs sharing a projectId as one batch and returns all of them", () => {
    const jobs = [
      makeJob({ type: "avatar_generation", projectId: "proj_x", createdAt: "2026-07-10T00:00:00.000Z" }),
      makeJob({ type: "talking_head", projectId: "proj_x", createdAt: "2026-07-10T00:00:00.000Z" }),
      makeJob({ type: "video_render", projectId: "proj_x", createdAt: "2026-07-10T00:00:00.000Z" })
    ];
    const result = selectLatestBatchJobs(jobs);
    expect(result.map((job) => job.type).sort()).toEqual(["avatar_generation", "talking_head", "video_render"]);
  });

  it("treats a job without projectId as its own batch and prefers it when newest", () => {
    const jobs = [
      makeJob({ type: "video_render", projectId: "proj_old", createdAt: "2026-07-09T00:00:00.000Z" }),
      makeJob({ type: "talking_head", createdAt: "2026-07-10T00:00:00.000Z" })
    ];
    const result = selectLatestBatchJobs(jobs);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("talking_head");
    expect(result[0].projectId).toBeUndefined();
  });

  it("returns an empty array for empty input", () => {
    expect(selectLatestBatchJobs([])).toEqual([]);
  });

  it("sorts the batch in pipeline order regardless of input order", () => {
    const jobs = [
      makeJob({ type: "video_render", projectId: "proj_x", createdAt: "2026-07-10T00:00:00.000Z" }),
      makeJob({ type: "avatar_generation", projectId: "proj_x", createdAt: "2026-07-10T00:00:00.000Z" }),
      makeJob({ type: "talking_head", projectId: "proj_x", createdAt: "2026-07-10T00:00:00.000Z" })
    ];
    const result = selectLatestBatchJobs(jobs);
    expect(result.map((job) => job.type)).toEqual(["avatar_generation", "talking_head", "video_render"]);
  });
});
