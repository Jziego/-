import { Queue } from "bullmq";
import type { Job, JobType } from "@/lib/types";

export const queueNames: Record<JobType, string> = {
  asset_analysis: "asset-analysis",
  avatar_generation: "avatar-generation",
  video_render: "video-render",
  slideshow_render: "slideshow-render",
  subtitle_generation: "subtitle-generation"
};

export function createBullQueue(type: JobType): Queue {
  const connection = process.env.REDIS_URL
    ? { url: process.env.REDIS_URL }
    : { host: "127.0.0.1", port: 6379 };

  return new Queue(queueNames[type], { connection });
}

export function toQueuePayload(job: Job) {
  return {
    name: job.type,
    data: {
      jobId: job.id,
      projectId: job.projectId,
      payload: job.payload,
      dependsOnJobIds: job.dependsOnJobIds
    },
    opts: {
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 5_000
      },
      removeOnComplete: 100,
      removeOnFail: 500
    }
  };
}
