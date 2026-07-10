import type { Job } from "@/lib/types";

/** 「生成进度」面板允许展示的 job 类型。 */
export const PANEL_JOB_TYPES = ["video_render", "avatar_generation", "talking_head"] as const;

/** 批次内展示顺序：形象训练 → 口播 → 视频合成。 */
const TYPE_ORDER: Record<string, number> = {
  avatar_generation: 0,
  talking_head: 1,
  video_render: 2
};

function batchKey(job: Job): string {
  return job.projectId ?? job.id;
}

/**
 * 从 owner 的全部 job 中选出「生成进度」面板应展示的子集：
 * 1. 只保留视频类 job（PANEL_JOB_TYPES）；
 * 2. 按 projectId（无则用 job id）分组，返回 createdAt 最新的那一组；
 * 3. 组内按 type 流水线顺序排序。
 *
 * 新任务的 job 时间戳最新 → 自动成为显示批次，旧批次随之隐藏；
 * 页面刷新后仍只显示最新一批，无需改 API/DB。
 */
export function selectLatestBatchJobs(jobs: Job[]): Job[] {
  const visible = jobs.filter((job) => (PANEL_JOB_TYPES as readonly string[]).includes(job.type));
  if (visible.length === 0) return [];

  let latestCreatedAt = "";
  for (const job of visible) {
    if (job.createdAt > latestCreatedAt) latestCreatedAt = job.createdAt;
  }
  const latestKey = batchKey(visible.find((job) => job.createdAt === latestCreatedAt) ?? visible[0]);

  return visible
    .filter((job) => batchKey(job) === latestKey)
    .sort((a, b) => (TYPE_ORDER[a.type] ?? 99) - (TYPE_ORDER[b.type] ?? 99));
}
