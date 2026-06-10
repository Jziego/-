import type { JobType } from "@/lib/types";
import type { Job } from "bullmq";

export type ProcessorFn = (job: Job) => Promise<unknown>;

const registry = new Map<JobType, ProcessorFn>();

export function registerProcessor(type: JobType, fn: ProcessorFn): void {
  registry.set(type, fn);
}

export function getProcessor(type: JobType): ProcessorFn | undefined {
  return registry.get(type);
}
