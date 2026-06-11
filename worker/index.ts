import { Worker } from "bullmq";
import { getRedisUrl } from "@/lib/env";
import { getJobRepository, getRenderRepository } from "@/lib/repositories";
import { queueNames } from "@/lib/queue";
import { registerProcessor, getProcessor } from "@/worker/processors/index";
import { assetAnalysisProcessor } from "@/worker/processors/asset-analysis";
import { avatarGenerationProcessor } from "@/worker/processors/avatar-generation";
import { videoRenderProcessor } from "@/worker/processors/video-render";
import { nowIso } from "@/lib/ids";
import type { JobType } from "@/lib/types";

// Register processors
registerProcessor("asset_analysis", assetAnalysisProcessor);
registerProcessor("avatar_generation", avatarGenerationProcessor);
registerProcessor("video_render", videoRenderProcessor);
registerProcessor("slideshow_render", videoRenderProcessor); // slideshow uses same render pipeline
registerProcessor("subtitle_generation", videoRenderProcessor); // placeholder for now

const connection = getRedisUrl()
  ? { url: getRedisUrl()! }
  : { host: "127.0.0.1", port: 6379 };

function createWorker(type: JobType): Worker {
  const jobRepo = getJobRepository();
  const renderRepo = getRenderRepository();
  const queueName = queueNames[type];
  const process = getProcessor(type);

  if (!process) {
    console.warn(`No processor registered for type: ${type}`);
  }

  const worker = new Worker(
    queueName,
    async (job) => {
      const jobId = job.data.jobId as string;
      const projectId = job.data.projectId as string;
      console.log(`[${type}] Processing job ${jobId} (project: ${projectId})`);

      // Update job status to processing
      try {
        await jobRepo.update(jobId, { status: "processing", progress: 0, updatedAt: nowIso() });
      } catch {
        // DB may not be available — continue processing anyway
      }

      // Update render project status to processing
      if (projectId) {
        try {
          await renderRepo.updateProject(projectId, { status: "processing", updatedAt: nowIso() });
        } catch {
          // Best-effort
        }
      }

      if (!process) {
        throw new Error(`No processor registered for job type: ${type}`);
      }

      const result = await process(job);

      // Update job status to completed
      try {
        await jobRepo.update(jobId, {
          status: "completed",
          progress: 100,
          updatedAt: nowIso()
        });
      } catch {
        // Update best-effort
      }

      console.log(`[${type}] Completed job ${jobId}`);
      return result;
    },
    { connection, concurrency: 2 }
  );

  worker.on("failed", async (job, err) => {
    if (!job) return;
    const jobId = job.data.jobId as string;
    const projectId = job.data.projectId as string;
    console.error(`[${type}] Failed job ${jobId}: ${err.message}`);

    // Update job status to failed
    try {
      await jobRepo.update(jobId, {
        status: "failed",
        error: err.message,
        updatedAt: nowIso()
      });
    } catch {
      // Update best-effort
    }

    // Update render project if all jobs for this project have failed
    if (projectId) {
      try {
        const allJobs = await jobRepo.listByOwner(job.data.ownerId as string ?? "demo_user");
        const projectJobs = allJobs.filter((j) => j.projectId === projectId);
        const allDone = projectJobs.every((j) => j.status === "completed" || j.status === "failed");
        const allFailed = projectJobs.every((j) => j.status === "failed");

        if (allFailed) {
          await renderRepo.updateProject(projectId, { status: "failed", updatedAt: nowIso() });
        } else if (allDone) {
          // Some completed, some failed — project is still "ready" if video_render succeeded
          const hasCompletedRender = projectJobs.some(
            (j) => (j.type === "video_render" || j.type === "slideshow_render") && j.status === "completed"
          );
          if (hasCompletedRender) {
            await renderRepo.updateProject(projectId, { status: "ready", updatedAt: nowIso() });
          }
        }
      } catch {
        // Best-effort
      }
    }
  });

  worker.on("ready", () => {
    console.log(`[${type}] Worker ready (queue: ${queueName})`);
  });

  worker.on("progress", async (job, progress) => {
    if (!job) return;
    const jobId = job.data.jobId as string;
    try {
      await jobRepo.update(jobId, { progress: progress as number, updatedAt: nowIso() });
    } catch {
      // Best-effort
    }
  });

  return worker;
}

const jobTypes: JobType[] = [
  "asset_analysis",
  "avatar_generation",
  "video_render",
  "slideshow_render",
  "subtitle_generation"
];

const workers = jobTypes.map(createWorker);

console.log(`Worker started with ${workers.length} queues: ${jobTypes.map((t) => queueNames[t]).join(", ")}`);

// Graceful shutdown
async function shutdown() {
  console.log("Shutting down workers...");
  await Promise.all(workers.map((w) => w.close()));
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
