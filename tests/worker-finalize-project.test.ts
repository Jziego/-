import { beforeEach, describe, expect, it } from "vitest";
import { MemoryJobRepository, MemoryRenderRepository } from "@/lib/repositories/memory";
import { resetRuntimeStateForTests } from "@/lib/runtime-store";
import { finalizeProjectStatus } from "@/worker/finalize-project";
import type { Job, RenderProject } from "@/lib/types";

const OWNER = "owner_test";
const PROJECT_ID = "render_test";

function sampleProject(overrides: Partial<RenderProject> = {}): RenderProject {
  const now = new Date().toISOString();
  return {
    id: PROJECT_ID,
    ownerId: OWNER,
    storeId: "store_test",
    scriptDraftId: "script_test",
    selectedAssetIds: ["asset_test"],
    purpose: "store_traffic",
    aspectRatio: "9:16",
    subtitleStyle: "bold_bottom",
    status: "processing",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function sampleJob(overrides: Partial<Job>): Job {
  const now = new Date().toISOString();
  return {
    id: "job_test",
    ownerId: OWNER,
    projectId: PROJECT_ID,
    type: "video_render",
    status: "completed",
    progress: 100,
    payload: {},
    dependsOnJobIds: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("finalizeProjectStatus", () => {
  let jobRepo: MemoryJobRepository;
  let renderRepo: MemoryRenderRepository;

  beforeEach(() => {
    resetRuntimeStateForTests();
    jobRepo = new MemoryJobRepository();
    renderRepo = new MemoryRenderRepository();
  });

  it("sets project ready when all jobs completed and a video_render succeeded", async () => {
    await renderRepo.createProject(sampleProject({ status: "processing" }));
    await jobRepo.createMany([
      sampleJob({ id: "j1", type: "avatar_generation", status: "completed" }),
      sampleJob({ id: "j2", type: "video_render", status: "completed" }),
    ]);

    await finalizeProjectStatus(jobRepo, renderRepo, PROJECT_ID, OWNER);

    const project = await renderRepo.findProjectById(PROJECT_ID);
    expect(project?.status).toBe("ready");
  });

  it("sets project ready when all jobs completed and a slideshow_render succeeded", async () => {
    await renderRepo.createProject(sampleProject({ status: "processing" }));
    await jobRepo.createMany([
      sampleJob({ id: "j1", type: "avatar_generation", status: "completed" }),
      sampleJob({ id: "j2", type: "slideshow_render", status: "completed" }),
    ]);

    await finalizeProjectStatus(jobRepo, renderRepo, PROJECT_ID, OWNER);

    const project = await renderRepo.findProjectById(PROJECT_ID);
    expect(project?.status).toBe("ready");
  });

  it("sets project failed when all jobs failed", async () => {
    await renderRepo.createProject(sampleProject({ status: "processing" }));
    await jobRepo.createMany([
      sampleJob({ id: "j1", type: "avatar_generation", status: "failed" }),
      sampleJob({ id: "j2", type: "video_render", status: "failed" }),
    ]);

    await finalizeProjectStatus(jobRepo, renderRepo, PROJECT_ID, OWNER);

    const project = await renderRepo.findProjectById(PROJECT_ID);
    expect(project?.status).toBe("failed");
  });

  it("sets project ready when some jobs failed but a render succeeded", async () => {
    await renderRepo.createProject(sampleProject({ status: "processing" }));
    await jobRepo.createMany([
      sampleJob({ id: "j1", type: "avatar_generation", status: "failed" }),
      sampleJob({ id: "j2", type: "video_render", status: "completed" }),
    ]);

    await finalizeProjectStatus(jobRepo, renderRepo, PROJECT_ID, OWNER);

    const project = await renderRepo.findProjectById(PROJECT_ID);
    expect(project?.status).toBe("ready");
  });

  it("leaves project processing when not all jobs are done", async () => {
    await renderRepo.createProject(sampleProject({ status: "processing" }));
    await jobRepo.createMany([
      sampleJob({ id: "j1", type: "video_render", status: "completed" }),
      sampleJob({ id: "j2", type: "avatar_generation", status: "processing" }),
    ]);

    await finalizeProjectStatus(jobRepo, renderRepo, PROJECT_ID, OWNER);

    const project = await renderRepo.findProjectById(PROJECT_ID);
    expect(project?.status).toBe("processing");
  });

  it("leaves project processing when all completed but no render job succeeded", async () => {
    await renderRepo.createProject(sampleProject({ status: "processing" }));
    await jobRepo.createMany([
      sampleJob({ id: "j1", type: "avatar_generation", status: "completed" }),
    ]);

    await finalizeProjectStatus(jobRepo, renderRepo, PROJECT_ID, OWNER);

    const project = await renderRepo.findProjectById(PROJECT_ID);
    expect(project?.status).toBe("processing");
  });

  it("does not throw and leaves project unchanged when project has no jobs", async () => {
    await renderRepo.createProject(sampleProject({ status: "processing" }));

    await expect(
      finalizeProjectStatus(jobRepo, renderRepo, PROJECT_ID, OWNER)
    ).resolves.toBeUndefined();

    const project = await renderRepo.findProjectById(PROJECT_ID);
    expect(project?.status).toBe("processing");
  });
});
