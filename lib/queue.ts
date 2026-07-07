import { Queue, FlowProducer } from "bullmq";
import type { Job, JobType } from "@/lib/types";

export const queueNames: Record<JobType, string> = {
  asset_analysis: "asset-analysis",
  avatar_generation: "avatar-generation",
  talking_head: "talking-head",
  video_render: "video-render",
  subtitle_generation: "subtitle-generation",
  quota_monthly_reset: "cron-quota-reset",
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
 *
 * BullMQ semantics: a parent is not processed until all its CHILDREN complete
 * (https://docs.bullmq.io/guide/flows). Therefore a job's DEPENDENCY must be
 * its CHILD (so the dependency runs first), and the ultimate dependent is the
 * root. Recurses to support arbitrary-depth chains.
 */
export type FlowNode = {
  name: string;
  queueName: string;
  data: Record<string, unknown>;
  opts: Record<string, unknown>;
  children?: FlowNode[];
};

export function toFlowJobs(jobs: Job[]): FlowNode[] {
  const jobMap = new Map(jobs.map((j) => [j.id, j]));
  // childrenOf[X] = jobs X depends on (X's dependencies become X's children).
  const childrenOf = new Map<string, Job[]>();
  for (const job of jobs) {
    for (const depId of job.dependsOnJobIds) {
      const dep = jobMap.get(depId);
      if (!dep) continue; // dependency outside this batch — caller handles ordering
      const list = childrenOf.get(job.id) ?? [];
      list.push(dep);
      childrenOf.set(job.id, list);
    }
  }

  function buildFlowNode(job: Job): FlowNode {
    const children = (childrenOf.get(job.id) ?? []).map(buildFlowNode);
    const { data, opts } = toQueuePayload(job);
    return {
      name: job.id,
      queueName: queueNames[job.type],
      data,
      opts,
      children: children.length > 0 ? children : undefined
    };
  }

  // Top-level = jobs that nothing in this batch depends on (the ultimate dependents).
  const dependedUpon = new Set<string>();
  for (const job of jobs) {
    for (const depId of job.dependsOnJobIds) {
      if (jobMap.has(depId)) dependedUpon.add(depId);
    }
  }
  const topLevel = jobs.filter((j) => !dependedUpon.has(j.id));
  return topLevel.map(buildFlowNode);
}
