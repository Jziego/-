import { Queue, FlowProducer } from "bullmq";
import type { Job, JobType } from "@/lib/types";

export const queueNames: Record<JobType, string> = {
  asset_analysis: "asset-analysis",
  avatar_generation: "avatar-generation",
  video_render: "video-render",
  slideshow_render: "slideshow-render",
  subtitle_generation: "subtitle-generation"
};

function getConnection() {
  return process.env.REDIS_URL
    ? { url: process.env.REDIS_URL }
    : { host: "127.0.0.1", port: 6379 };
}

export function createBullQueue(type: JobType): Queue {
  return new Queue(queueNames[type], { connection: getConnection() });
}

export function createFlowProducer(): FlowProducer {
  return new FlowProducer({ connection: getConnection() });
}

export function toQueuePayload(job: Job) {
  return {
    data: {
      jobId: job.id,
      projectId: job.projectId,
      ownerId: job.ownerId,
      payload: job.payload,
      dependsOnJobIds: job.dependsOnJobIds
    },
    opts: {
      attempts: 3,
      backoff: {
        type: "exponential" as const,
        delay: 5_000
      },
      removeOnComplete: 100,
      removeOnFail: 500
    }
  };
}

/**
 * Build a BullMQ FlowProducer job tree from a flat list of jobs.
 * Jobs with dependsOnJobIds become children of their dependencies.
 * Jobs without dependencies are top-level.
 *
 * Returns an array of flow job definitions suitable for FlowProducer.add().
 */
export function toFlowJobs(jobs: Job[]): Array<{
  name: string;
  queueName: string;
  data: Record<string, unknown>;
  opts: Record<string, unknown>;
  children?: Array<{
    name: string;
    queueName: string;
    data: Record<string, unknown>;
    opts: Record<string, unknown>;
  }>;
}> {
  const jobMap = new Map(jobs.map((j) => [j.id, j]));
  const childrenOf = new Map<string, Job[]>();

  for (const job of jobs) {
    for (const depId of job.dependsOnJobIds) {
      if (!jobMap.has(depId)) continue; // dependency not in this batch
      const children = childrenOf.get(depId) ?? [];
      children.push(job);
      childrenOf.set(depId, children);
    }
  }

  function buildFlowNode(job: Job) {
    const children = childrenOf.get(job.id) ?? [];
    const childJobs = children.map((child) => {
      const { data, opts } = toQueuePayload(child);
      return {
        name: child.id,
        queueName: queueNames[child.type],
        data,
        opts
      };
    });

    const { data, opts } = toQueuePayload(job);
    return {
      name: job.id,
      queueName: queueNames[job.type],
      data,
      opts,
      children: childJobs.length > 0 ? childJobs : undefined
    };
  }

  // Return top-level jobs (those whose dependencies are not in this batch)
  const topLevel = jobs.filter((j) => {
    if (j.dependsOnJobIds.length === 0) return true;
    // If all dependencies are outside this batch, treat as top-level
    return j.dependsOnJobIds.every((depId) => !jobMap.has(depId));
  });
  return topLevel.map(buildFlowNode);
}
