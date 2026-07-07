import { Worker, Queue } from "bullmq";
import { getRedisUrl } from "@/lib/env";
import { getJobRepository, getRenderRepository } from "@/lib/repositories";
import { queueNames } from "@/lib/queue";
import { registerProcessor, getProcessor } from "@/worker/processors/index";
import { finalizeProjectStatus } from "@/worker/finalize-project";
import { assetAnalysisProcessor } from "@/worker/processors/asset-analysis";
import { avatarGenerationProcessor } from "@/worker/processors/avatar-generation";
import { talkingHeadProcessor } from "@/worker/processors/talking-head";
import { videoRenderProcessor } from "@/worker/processors/video-render";
import { quotaResetProcessor } from "@/worker/processors/quota-reset";
import { nowIso } from "@/lib/ids";
import type { JobType } from "@/lib/types";

// Register processors
registerProcessor("asset_analysis", assetAnalysisProcessor);
registerProcessor("avatar_generation", avatarGenerationProcessor);
registerProcessor("talking_head", talkingHeadProcessor);
registerProcessor("video_render", videoRenderProcessor);
registerProcessor("subtitle_generation", videoRenderProcessor); // placeholder for now
registerProcessor("quota_monthly_reset", quotaResetProcessor);

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

      // Finalize render project status once all project jobs are done
      if (projectId) {
        await finalizeProjectStatus(
          jobRepo,
          renderRepo,
          projectId,
          (job.data.ownerId as string) ?? "demo_user"
        );
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

    // Finalize render project status once all project jobs are done
    if (projectId) {
      await finalizeProjectStatus(
        jobRepo,
        renderRepo,
        projectId,
        (job.data.ownerId as string) ?? "demo_user"
      );
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
  "talking_head",
  "video_render",
  "subtitle_generation",
  "quota_monthly_reset"
];

// ── Cron: Schedule monthly quota reset ──────────────────────────────────────

async function scheduleQuotaReset() {
  const cronQueue = new Queue(queueNames.quota_monthly_reset, { connection });
  await cronQueue.add(
    "quota-monthly-reset",
    { task: "quota_monthly_reset" },
    {
      repeat: { pattern: "0 0 1 * *" }, // 1st of every month at 00:00 UTC
      jobId: "quota-monthly-reset", // deduplicate
    },
  );
  console.log("[cron] Scheduled monthly quota reset (0 0 1 * *)");

  if (process.env.RUN_QUOTA_RESET_ON_STARTUP === "1") {
    await cronQueue.add(
      "quota-monthly-reset-immediate",
      { task: "quota_monthly_reset" },
      {},
    );
    console.log("[cron] Triggered immediate quota reset (RUN_QUOTA_RESET_ON_STARTUP=1)");
  }

  return cronQueue;
}

let cronQueue: Queue | null = null;
scheduleQuotaReset().then((q) => { cronQueue = q; }).catch((err) => {
  console.error("[cron] Failed to schedule quota reset:", err.message);
});

const workers = jobTypes.map(createWorker);

console.log(`Worker started with ${workers.length} queues: ${jobTypes.map((t) => queueNames[t]).join(", ")}`);

// Graceful shutdown
async function shutdown() {
  console.log("Shutting down workers...");
  await Promise.all(workers.map((w) => w.close()));
  if (cronQueue) await cronQueue.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
