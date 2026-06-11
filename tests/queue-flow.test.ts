import { describe, expect, it } from "vitest";
import { toFlowJobs } from "@/lib/queue";
import { createId, nowIso } from "@/lib/ids";
import type { Job } from "@/lib/types";

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: createId("job"),
    ownerId: "demo_user",
    projectId: createId("project"),
    type: "video_render",
    status: "queued",
    progress: 0,
    payload: { aspectRatio: "9:16" },
    dependsOnJobIds: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ...overrides
  };
}

describe("toFlowJobs", () => {
  it("returns top-level jobs when there are no dependencies", () => {
    const jobs = [makeJob(), makeJob(), makeJob()];

    const flows = toFlowJobs(jobs);

    expect(flows.length).toBe(3);
    expect(flows.every((f) => !f.children || f.children.length === 0)).toBe(true);
  });

  it("nests child jobs under parent when dependsOnJobIds is set", () => {
    const parentJob = makeJob({ id: "job_parent", type: "avatar_generation" });
    const childJob = makeJob({
      id: "job_child",
      type: "video_render",
      dependsOnJobIds: ["job_parent"]
    });

    const flows = toFlowJobs([parentJob, childJob]);

    // Only parent should be top-level
    expect(flows.length).toBe(1);
    expect(flows[0]?.name).toBe("job_parent");
    expect(flows[0]?.children).toBeDefined();
    expect(flows[0]?.children!.length).toBe(1);
    expect(flows[0]?.children![0]?.name).toBe("job_child");
  });

  it("handles complex dependency chains: avatar → video → slideshow", () => {
    const avatar = makeJob({ id: "j1", type: "avatar_generation" });
    const video = makeJob({ id: "j2", type: "video_render", dependsOnJobIds: ["j1"] });
    const slideshow = makeJob({ id: "j3", type: "slideshow_render", dependsOnJobIds: [] });

    const flows = toFlowJobs([avatar, video, slideshow]);

    // avatar and slideshow are top-level (slideshow has no dependencies)
    expect(flows.length).toBe(2);

    const avatarFlow = flows.find((f) => f.name === "j1");
    const slideshowFlow = flows.find((f) => f.name === "j3");

    expect(avatarFlow?.children?.length).toBe(1);
    expect(avatarFlow?.children![0]?.name).toBe("j2");
    expect(slideshowFlow?.children).toBeUndefined();
  });

  it("skips dependencies not in the batch", () => {
    const child = makeJob({
      id: "j2",
      type: "video_render",
      dependsOnJobIds: ["j_not_in_batch"]
    });

    const flows = toFlowJobs([child]);

    // Child becomes top-level since its dependency isn't in the batch
    expect(flows.length).toBe(1);
    expect(flows[0]?.name).toBe("j2");
    expect(flows[0]?.children).toBeUndefined();
  });

  it("includes correct queueName and opts in flow nodes", () => {
    const job = makeJob({ id: "j1", type: "asset_analysis" });
    const flows = toFlowJobs([job]);
    const flow = flows[0]!;

    expect(flow.queueName).toBe("asset-analysis");
    expect(flow.data.jobId).toBe("j1");
    expect(flow.opts.attempts).toBe(3);
    expect((flow.opts.backoff as { type: string }).type).toBe("exponential");
  });
});
