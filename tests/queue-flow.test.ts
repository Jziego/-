import { describe, it, expect } from "vitest";
import { toFlowJobs } from "@/lib/queue";
import type { Job, JobType } from "@/lib/types";

function makeJob(overrides: Partial<Job> & { id: string; type: JobType }): Job {
  return {
    ownerId: "owner_test",
    projectId: "proj_test",
    status: "queued",
    progress: 0,
    payload: {},
    dependsOnJobIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as Job;
}

describe("toFlowJobs", () => {
  it("returns a single top-level flow for independent jobs", () => {
    const job = makeJob({ id: "j1", type: "video_render" });
    const flows = toFlowJobs([job]);
    expect(flows).toHaveLength(1);
    expect(flows[0]?.name).toBe("j1");
    expect(flows[0]?.children).toBeUndefined();
  });

  it("makes a dependency the CHILD of its dependent (child runs first)", () => {
    const firstStep = makeJob({ id: "j1", type: "avatar_generation", dependsOnJobIds: [] });
    const lastStep = makeJob({ id: "j2", type: "video_render", dependsOnJobIds: ["j1"] });
    const flows = toFlowJobs([firstStep, lastStep]);
    expect(flows).toHaveLength(1);
    expect(flows[0]?.name).toBe("j2"); // dependent is the root
    expect(flows[0]?.children?.[0]?.name).toBe("j1"); // dependency is the child
  });

  it("recurses for 3-level chains (avatar -> talking_head -> video_render)", () => {
    const avatar = makeJob({ id: "j1", type: "avatar_generation", dependsOnJobIds: [] });
    const talking = makeJob({ id: "j2", type: "talking_head", dependsOnJobIds: ["j1"] });
    const render = makeJob({ id: "j3", type: "video_render", dependsOnJobIds: ["j2"] });
    const flows = toFlowJobs([avatar, talking, render]);
    expect(flows).toHaveLength(1);
    expect(flows[0]?.name).toBe("j3");
    expect(flows[0]?.children?.[0]?.name).toBe("j2");
    expect(flows[0]?.children?.[0]?.children?.[0]?.name).toBe("j1");
  });

  it("treats a job whose dependencies are all outside the batch as top-level", () => {
    const child = makeJob({ id: "j1", type: "video_render", dependsOnJobIds: ["j_not_in_batch"] });
    const flows = toFlowJobs([child]);
    expect(flows).toHaveLength(1);
    expect(flows[0]?.name).toBe("j1");
    expect(flows[0]?.children).toBeUndefined();
  });
});
