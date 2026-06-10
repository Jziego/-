import { Worker } from "bullmq";
import { getRedisUrl } from "@/lib/env";
import { getJobRepository } from "@/lib/repositories";
import { queueNames } from "@/lib/queue";
import { registerProcessor, getProcessor } from "@/worker/processors/index";
import { assetAnalysisProcessor } from "@/worker/processors/asset-analysis";
import { videoRenderProcessor } from "@/worker/processors/video-render";
import { nowIso } from "@/lib/ids";
import type { JobType } from "@/lib/types";

// Register processors
registerProcessor("asset_analysis", assetAnalysisProcessor);
registerProcessor("video_render", videoRenderProcessor);
registerProcessor("slideshow_render", videoRenderProcessor); // same placeholder
registerProcessor("avatar_generation", videoRenderProcessor); // same placeholder

const connection = getRedisUrl()
  ? { url: getRedisUrl()! }
  : { host: "127.0.0.1", port: 6379 };

function createWorker(type: JobType): Worker {
  const jobRepo = getJobRepository();
  const queueName = queueNames[type];
  const process = getProcessor(type);

  if (!process) {
    console.warn(`No processor registered for type: ${type}`);
  }

  const worker = new Worker(
    queueName,
    async (job) => {
      const jobId = job.data.jobId as string;
      console.log(`[${type}] Processing job ${jobId}`);

      try {
        await jobRepo.update(jobId, { status: "processing", updatedAt: nowIso() });
      } catch {
        // DB may not be available — continue processing anyway
      }

      if (!process) {
        throw new Error(`No processor registered for job type: ${type}`);
      }

      const result = await process(job);

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
    console.error(`[${type}] Failed job ${jobId}: ${err.message}`);

    try {
      await jobRepo.update(jobId, {
        status: "failed",
        error: err.message,
        updatedAt: nowIso()
      });
    } catch {
      // Update best-effort
    }
  });

  worker.on("ready", () => {
    console.log(`[${type}] Worker ready (queue: ${queueName})`);
  });

  return worker;
}

const jobTypes: JobType[] = [
  "asset_analysis",
  "avatar_generation",
  "video_render",
  "slideshow_render"
];

const workers = jobTypes.map(createWorker);

console.log(`Worker started with ${workers.length} queues`);

// Graceful shutdown
async function shutdown() {
  console.log("Shutting down workers...");
  await Promise.all(workers.map((w) => w.close()));
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
