# Dashboard「生成进度」最新批次过滤 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dashboard「生成进度」面板只展示最新一批视频生成 job（视频合成 / AI 形象训练 / 视频任务），新任务自动顶替旧批次，不再堆积历史。

**Architecture:** 新增纯函数 `selectLatestBatchJobs(jobs)` —— 先按 type 过滤到 `{video_render, avatar_generation, talking_head}`，再按 `projectId ?? id` 分组取 `createdAt` 最新的那一批。Dashboard 用一个 `useMemo` 派生该子集，SSE 订阅、轮询、时间线渲染、终态判定全部改用它。新任务的 job 时间戳最新 → 自动成为显示批次，页面刷新后仍只显示最新一批。纯前端，零 API/DB 改动。

**Tech Stack:** Next.js App Router、React 19、TypeScript、TanStack Query、Vitest + Testing Library。

**Spec:** `docs/superpowers/specs/2026-07-10-dashboard-progress-latest-batch-design.md`

---

## File Structure

| 文件 | 职责 | 动作 |
|---|---|---|
| `lib/dashboard-jobs.ts` | 纯函数 `selectLatestBatchJobs` + `PANEL_JOB_TYPES` 常量 | 新建 |
| `tests/dashboard-jobs.test.ts` | 上述纯函数的 6 条单元测试 | 新建 |
| `components/dashboard.tsx` | 接线（派生 `progressJobs`，改 SSE/轮询/时间线/标签） | 修改 |
| `tests/dashboard.test.tsx` | 2 条组件测试（只显示最新批次 + 类型过滤） | 追加 |

`selectLatestBatchJobs` 独立成文件（不放进 dashboard.tsx）以便单测，且 dashboard.tsx 已较大（~1150 行），拆出纯逻辑也有助于聚焦。

---

## Task 1: 纯函数 `selectLatestBatchJobs`（TDD）

**Files:**
- Create: `lib/dashboard-jobs.ts`
- Test: `tests/dashboard-jobs.test.ts`

- [ ] **Step 1: 写失败的单元测试**

创建 `tests/dashboard-jobs.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { createId } from "@/lib/ids";
import { selectLatestBatchJobs } from "@/lib/dashboard-jobs";
import type { Job } from "@/lib/types";

function makeJob(overrides: Partial<Job> & { type: Job["type"]; createdAt: string }): Job {
  return {
    id: createId("job"),
    ownerId: "demo_user",
    type: overrides.type,
    status: "completed",
    progress: 100,
    payload: {},
    dependsOnJobIds: [],
    createdAt: overrides.createdAt,
    updatedAt: overrides.createdAt,
    ...overrides
  };
}

describe("selectLatestBatchJobs", () => {
  it("filters out asset_analysis, subtitle_generation and quota_monthly_reset", () => {
    const jobs = [
      makeJob({ type: "asset_analysis", createdAt: "2026-07-10T00:00:00.000Z" }),
      makeJob({ type: "subtitle_generation", createdAt: "2026-07-10T00:00:00.000Z" }),
      makeJob({ type: "quota_monthly_reset", createdAt: "2026-07-10T00:00:00.000Z" }),
      makeJob({ type: "video_render", createdAt: "2026-07-10T00:00:00.000Z" })
    ];
    const result = selectLatestBatchJobs(jobs);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("video_render");
  });

  it("returns only the latest projectId batch when several exist", () => {
    const oldBatch = [
      makeJob({ type: "avatar_generation", projectId: "proj_old", createdAt: "2026-07-09T00:00:00.000Z" }),
      makeJob({ type: "video_render", projectId: "proj_old", createdAt: "2026-07-09T00:00:01.000Z" })
    ];
    const newBatch = [
      makeJob({ type: "avatar_generation", projectId: "proj_new", createdAt: "2026-07-10T00:00:00.000Z" }),
      makeJob({ type: "video_render", projectId: "proj_new", createdAt: "2026-07-10T00:00:01.000Z" })
    ];
    const result = selectLatestBatchJobs([...oldBatch, ...newBatch]);
    expect(result).toHaveLength(2);
    expect(result.every((job) => job.projectId === "proj_new")).toBe(true);
  });

  it("treats jobs sharing a projectId as one batch and returns all of them", () => {
    const jobs = [
      makeJob({ type: "avatar_generation", projectId: "proj_x", createdAt: "2026-07-10T00:00:00.000Z" }),
      makeJob({ type: "talking_head", projectId: "proj_x", createdAt: "2026-07-10T00:00:00.000Z" }),
      makeJob({ type: "video_render", projectId: "proj_x", createdAt: "2026-07-10T00:00:00.000Z" })
    ];
    const result = selectLatestBatchJobs(jobs);
    expect(result.map((job) => job.type).sort()).toEqual(["avatar_generation", "talking_head", "video_render"]);
  });

  it("treats a job without projectId as its own batch and prefers it when newest", () => {
    const jobs = [
      makeJob({ type: "video_render", projectId: "proj_old", createdAt: "2026-07-09T00:00:00.000Z" }),
      makeJob({ type: "talking_head", createdAt: "2026-07-10T00:00:00.000Z" })
    ];
    const result = selectLatestBatchJobs(jobs);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("talking_head");
    expect(result[0].projectId).toBeUndefined();
  });

  it("returns an empty array for empty input", () => {
    expect(selectLatestBatchJobs([])).toEqual([]);
  });

  it("sorts the batch in pipeline order regardless of input order", () => {
    const jobs = [
      makeJob({ type: "video_render", projectId: "proj_x", createdAt: "2026-07-10T00:00:00.000Z" }),
      makeJob({ type: "avatar_generation", projectId: "proj_x", createdAt: "2026-07-10T00:00:00.000Z" }),
      makeJob({ type: "talking_head", projectId: "proj_x", createdAt: "2026-07-10T00:00:00.000Z" })
    ];
    const result = selectLatestBatchJobs(jobs);
    expect(result.map((job) => job.type)).toEqual(["avatar_generation", "talking_head", "video_render"]);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败（红）**

Run: `npx vitest run tests/dashboard-jobs.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/dashboard-jobs"`（模块不存在）。

- [ ] **Step 3: 写最小实现**

创建 `lib/dashboard-jobs.ts`：

```ts
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
```

- [ ] **Step 4: 运行测试，确认通过（绿）**

Run: `npx vitest run tests/dashboard-jobs.test.ts`
Expected: PASS — 6 个测试全部通过。

- [ ] **Step 5: typecheck**

Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 6: 提交**

```bash
git add lib/dashboard-jobs.ts tests/dashboard-jobs.test.ts
git commit -m "$(cat <<'EOF'
feat(dashboard): add selectLatestBatchJobs pure selector

Filters jobs to {video_render, avatar_generation, talking_head}, groups
by projectId ?? id, and returns the newest batch by createdAt — the
foundation for a non-accumulating 生成进度 panel.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: 组件测试 —— 只显示最新批次 + 类型过滤（TDD 红）

**Files:**
- Modify: `tests/dashboard.test.tsx`（在文件末尾、最外层 `describe` 闭合 `});` 之前追加 2 个 `it`）

- [ ] **Step 1: 追加两条失败的组件测试**

在 `tests/dashboard.test.tsx` 的 `describe("AI video assistant dashboard", () => { ... })` 内、最后一个 `it` 之后追加：

```ts
  it("shows only the latest render batch in the progress panel", async () => {
    const oldBatch = [
      { id: "job_old_1", ownerId: "demo_user", projectId: "proj_old", type: "avatar_generation", status: "completed", progress: 100, payload: {}, dependsOnJobIds: [], createdAt: "2026-07-09T00:00:00.000Z", updatedAt: "2026-07-09T00:00:00.000Z" },
      { id: "job_old_2", ownerId: "demo_user", projectId: "proj_old", type: "talking_head", status: "completed", progress: 100, payload: {}, dependsOnJobIds: [], createdAt: "2026-07-09T00:00:01.000Z", updatedAt: "2026-07-09T00:00:01.000Z" },
      { id: "job_old_3", ownerId: "demo_user", projectId: "proj_old", type: "video_render", status: "completed", progress: 100, payload: {}, dependsOnJobIds: [], createdAt: "2026-07-09T00:00:02.000Z", updatedAt: "2026-07-09T00:00:02.000Z" }
    ];
    const newBatch = [
      { id: "job_new_1", ownerId: "demo_user", projectId: "proj_new", type: "avatar_generation", status: "completed", progress: 100, payload: {}, dependsOnJobIds: [], createdAt: "2026-07-10T00:00:00.000Z", updatedAt: "2026-07-10T00:00:00.000Z" },
      { id: "job_new_2", ownerId: "demo_user", projectId: "proj_new", type: "talking_head", status: "completed", progress: 100, payload: {}, dependsOnJobIds: [], createdAt: "2026-07-10T00:00:01.000Z", updatedAt: "2026-07-10T00:00:01.000Z" },
      { id: "job_new_3", ownerId: "demo_user", projectId: "proj_new", type: "video_render", status: "completed", progress: 100, payload: {}, dependsOnJobIds: [], createdAt: "2026-07-10T00:00:02.000Z", updatedAt: "2026-07-10T00:00:02.000Z" }
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        json: async () => {
          if (url === "/api/jobs") return { jobs: [...oldBatch, ...newBatch] };
          if (url === "/api/store-profiles") return { stores: [] };
          if (url === "/api/assets") return { assets: [] };
          if (url === "/api/asset-analyses") return { analyses: [] };
          if (url === "/api/avatars") return { avatars: [] };
          if (url === "/api/render-projects") return { renderProjects: [], jobs: [], outputs: [] };
          if (url === "/api/script-drafts") return { scripts: [] };
          return {};
        }
      }))
    );

    const { container } = renderDashboard();

    await screen.findByText("视频合成");
    const items = container.querySelectorAll(".timelineItem");
    expect(items).toHaveLength(3);
  });

  it("hides asset_analysis noise and only shows the latest video job", async () => {
    const jobs = [
      { id: "job_analysis", ownerId: "demo_user", projectId: "proj_a", type: "asset_analysis", status: "completed", progress: 100, payload: {}, dependsOnJobIds: [], createdAt: "2026-07-11T00:00:00.000Z", updatedAt: "2026-07-11T00:00:00.000Z" },
      { id: "job_render", ownerId: "demo_user", projectId: "proj_b", type: "video_render", status: "completed", progress: 100, payload: {}, dependsOnJobIds: [], createdAt: "2026-07-10T00:00:00.000Z", updatedAt: "2026-07-10T00:00:00.000Z" }
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        json: async () => {
          if (url === "/api/jobs") return { jobs };
          if (url === "/api/store-profiles") return { stores: [] };
          if (url === "/api/assets") return { assets: [] };
          if (url === "/api/asset-analyses") return { analyses: [] };
          if (url === "/api/avatars") return { avatars: [] };
          if (url === "/api/render-projects") return { renderProjects: [], jobs: [], outputs: [] };
          if (url === "/api/script-drafts") return { scripts: [] };
          return {};
        }
      }))
    );

    const { container } = renderDashboard();

    await screen.findByText("视频合成");
    expect(container.querySelectorAll(".timelineItem")).toHaveLength(1);
    expect(screen.queryByText("AI 识别素材")).toBeNull();
  });
```

- [ ] **Step 2: 运行测试，确认失败（红）**

Run: `npx vitest run tests/dashboard.test.tsx`
Expected: FAIL ——
- `"shows only the latest render batch..."`：`Expected length: 3, Received length: 6`（当前未过滤，新旧两批共 6 条都渲染）。
- `"hides asset_analysis noise..."`：`Expected length: 1, Received length: 2`，且 `screen.queryByText("视频合成")` 可能找不到（当前标签是 "视频合成中"）。

- [ ] **Step 3: 暂不实现，先提交红测试（可选，记录意图）**

> 说明：TDD 红阶段通常不单独提交；若团队偏好红绿分离，可跳过本步直接进入 Task 3。这里默认**不单独提交**，待 Task 3 绿后一并提交。

---

## Task 3: 接线 dashboard.tsx（TDD 绿）

**Files:**
- Modify: `components/dashboard.tsx`

- [ ] **Step 1: 引入纯函数**

在 `components/dashboard.tsx` 顶部 import 区（`import type { ... } from "@/lib/types";` 这一行之后）追加：

```ts
import { selectLatestBatchJobs } from "@/lib/dashboard-jobs";
```

- [ ] **Step 2: 更新 jobTypeLabels**

把 `components/dashboard.tsx` 中的：

```ts
const jobTypeLabels: Record<string, string> = {
  asset_analysis: "AI 识别素材",
  avatar_generation: "AI 形象训练",
  video_render: "视频合成中",
  subtitle_generation: "字幕生成"
};
```

替换为：

```ts
const jobTypeLabels: Record<string, string> = {
  avatar_generation: "AI 形象训练",
  talking_head: "视频任务",
  video_render: "视频合成"
};
```

- [ ] **Step 3: jobs 查询的轮询改为基于最新批次**

把 jobs `useQuery` 的 `refetchInterval`：

```ts
    refetchInterval: (query) => {
      const currentJobs = localJobs ?? query.state.data ?? [];
      return currentJobs.some((job) => job.status === "queued" || job.status === "processing") ? 5000 : false;
    }
```

替换为：

```ts
    refetchInterval: (query) => {
      const currentJobs = selectLatestBatchJobs(localJobs ?? (query.state.data ?? []));
      return currentJobs.some((job) => job.status === "queued" || job.status === "processing") ? 5000 : false;
    }
```

- [ ] **Step 4: 派生 progressJobs，并让 outputs 轮询与 SSE 都基于它**

把这一段：

```ts
  // Completed render outputs surface here once video_render finishes; poll in
  // lockstep with jobs so a freshly-completed video appears without a reload.
  const { data: serverOutputs = [] } = useQuery({
    queryKey: ["render-outputs"],
    queryFn: fetchRenderOutputs,
    refetchInterval: (localJobs ?? serverJobs).some((job) => job.status === "queued" || job.status === "processing")
      ? 5000
      : false
  });

  // SSE real-time progress for active jobs
  const activeJobs = localJobs ?? serverJobs;
  const jobProgressSSE = useJobProgressSSE(activeJobs);
```

替换为：

```ts
  // Latest video-generation batch shown in the 生成进度 panel. Derived (not
  // stored): new tasks have the newest createdAt, so they auto-replace the
  // previous batch — no accumulation, survives reload. See selectLatestBatchJobs.
  const progressJobs = useMemo(() => selectLatestBatchJobs(localJobs ?? serverJobs), [localJobs, serverJobs]);

  // Completed render outputs surface here once video_render finishes; poll in
  // lockstep with the latest batch so a freshly-completed video appears without
  // a reload.
  const { data: serverOutputs = [] } = useQuery({
    queryKey: ["render-outputs"],
    queryFn: fetchRenderOutputs,
    refetchInterval: progressJobs.some((job) => job.status === "queued" || job.status === "processing")
      ? 5000
      : false
  });

  // SSE real-time progress for the latest batch's active jobs only.
  const jobProgressSSE = useJobProgressSSE(progressJobs);
```

> Hook 顺序说明：`progressJobs` 是一个 `useMemo`，插在 jobs `useQuery` 与 outputs `useQuery` 之间，hook 调用顺序在每次渲染保持稳定，符合 React hooks 规则。`useMemo` 已在第 4 行导入。

- [ ] **Step 5: jobsWithProgress 改用 progressJobs，移除冗余派生**

先删除这一行（位于 store/asset/avatar/script 派生之后）：

```ts
  const jobs = localJobs ?? serverJobs;
```

再把 `jobsWithProgress` 的 `useMemo`：

```ts
  // Merge SSE real-time progress into the job list for display
  const jobsWithProgress = useMemo(() => {
    if (jobProgressSSE.size === 0) return jobs;
    return jobs.map((job) => {
      const sseState = jobProgressSSE.get(job.id);
      if (!sseState) return job;
      return { ...job, status: sseState.status, progress: sseState.progress, error: sseState.error ?? job.error };
    });
  }, [jobs, jobProgressSSE]);
```

替换为：

```ts
  // Merge SSE real-time progress into the latest-batch job list for display
  const jobsWithProgress = useMemo(() => {
    if (jobProgressSSE.size === 0) return progressJobs;
    return progressJobs.map((job) => {
      const sseState = jobProgressSSE.get(job.id);
      if (!sseState) return job;
      return { ...job, status: sseState.status, progress: sseState.progress, error: sseState.error ?? job.error };
    });
  }, [progressJobs, jobProgressSSE]);
```

> `hasTerminalJobs`、时间线渲染（`jobsWithProgress.map(...)`）无需改动 —— 它们已经基于 `jobsWithProgress`，现在自然只反映最新批次。

- [ ] **Step 6: 运行组件测试，确认通过（绿）**

Run: `npx vitest run tests/dashboard.test.tsx`
Expected: PASS —— 包括新增的 2 条与原有全部测试。

- [ ] **Step 7: 全量测试**

Run: `npm test`
Expected: 全部通过（含 Task 1 的 6 条 + 新增 2 条 + 既有用例）。

- [ ] **Step 8: 提交**

```bash
git add components/dashboard.tsx tests/dashboard.test.tsx
git commit -m "$(cat <<'EOF'
feat(dashboard): show only latest batch in 生成进度 panel

Wire selectLatestBatchJobs into the dashboard: derive progressJobs from
the job list and route SSE subscription, polling, timeline render and
terminal-state detection through it. New tasks auto-replace the previous
batch; asset_analysis/subtitle_generation noise is filtered out. Also
align jobTypeLabels (视频合成中→视频合成, add 视频任务, drop unused).

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: 全量 CI 验证

**Files:** 无（仅运行验证命令）

- [ ] **Step 1: typecheck**

Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 2: 全量测试**

Run: `npm test`
Expected: 全绿。

- [ ] **Step 3: lint**

Run: `npm run lint`
Expected: 0 error。

- [ ] **Step 4: build**

Run: `npm run build`
Expected: 构建成功。

- [ ] **Step 5: 若 1-4 有任何修复，提交**

```bash
git add -A
git commit -m "chore(dashboard): CI gate fixes for progress-panel filter

Co-Authored-By: Claude <noreply@anthropic.com>"
```

（若全绿无需修复，跳过本步。）

---

## Self-Review（计划完成后自检，无需执行）

**Spec 覆盖：**
- §4.1 类型过滤 → Task 1 实现 + Task 2 第二条测试。✅
- §4.2 最新批次（projectId ?? id）→ Task 1 实现 + Task 1 第 2/4 条测试。✅
- §4.3 自动顶替 → Task 1 第 2 条 + Task 2 第一条测试。✅
- §4.4 批内排序 → Task 1 第 6 条测试。✅
- §4.5 空状态 → 既有逻辑未改（jobsWithProgress 为空时 timeline 走 empty-state 分支）。✅
- §4.6 清理按钮 → `hasTerminalJobs` 现基于过滤后批次，逻辑不变。✅
- §5 纯函数 → Task 1。✅
- §6 接线 → Task 3。✅
- §7 标签 → Task 3 Step 2。✅

**Placeholder 扫描：** 无 TBD/TODO，每个代码步骤含完整代码。✅

**类型一致性：** `selectLatestBatchJobs(jobs: Job[]): Job[]`、`PANEL_JOB_TYPES`、`progressJobs` 在 Task 1/3 与测试中命名一致；`useJobProgressSSE` 入参为 `Pick<Job,"id"|"status"|"progress"|"error">[]`，传入 `progressJobs`（`Job[]`）兼容。✅

**已知限制（不在本计划范围）：** `allJobs = localJobs ?? serverJobs` 维持原 `??` 语义；若用户先点「开始生成视频」（设置 localJobs）再点「创建 AI 形象」提交独立口播，独立口播会被 localJobs 遮蔽暂不显示。spec §9 已将其列为后续事项，主流程（渲染即最新批次）不受影响。
