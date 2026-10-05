import { Queue, FlowProducer } from "bullmq";
import { Redis } from "ioredis";
import { attachRedisErrorLogging } from "@/lib/redis-error-logging";
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

/**
 * Zeabur 托管 Redis 的 /etc/redis-stack.conf 是只读挂载，CONFIG REWRITE 无法持久化，
 * maxmemory/noeviction 在容器重启后丢失。worker 每次启动自愈重设（幂等，瞬时连接，
 * 失败仅告警不阻塞启动）。可用 REDIS_MAXMEMORY_BYTES 覆盖默认 512MB。
 */
export async function applyRedisGuardrails(): Promise<void> {
  const redisUrl = process.env.REDIS_URL;
  const client = redisUrl
    ? new Redis(redisUrl, { lazyConnect: true })
    : new Redis({ host: "127.0.0.1", port: 6379, lazyConnect: true });
  // 先挂监听再 connect：连接期间的 error（如 ECONNRESET）不再 unhandled。
  attachRedisErrorLogging(client, "guardrails");
  try {
    await client.connect();
    const maxmemory = process.env.REDIS_MAXMEMORY_BYTES ?? "536870912";
    await client.config("SET", "maxmemory", maxmemory);
    await client.config("SET", "maxmemory-policy", "noeviction");
    console.log(`[redis] 护栏已应用：maxmemory=${maxmemory} noeviction`);
  } catch (err) {
    console.warn(`[redis] 护栏应用失败（不影响启动）：${(err as Error).message}`);
  } finally {
    client.disconnect();
  }
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
