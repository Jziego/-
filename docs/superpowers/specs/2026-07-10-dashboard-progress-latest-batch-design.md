# Dashboard「生成进度」面板：只保留最新批次（方案 A）

- 日期：2026-07-10
- 范围：`components/dashboard.tsx` 前端展示逻辑 + 新增纯函数 + 标签微调
- 不涉及：API、数据库、worker、队列

## 1. 背景与问题

Dashboard 的「生成进度」面板（`components/dashboard.tsx:1036-1083`）当前把 owner 的全部 job（最多 30 条，由 commit `322672e` 加 cap）都铺在时间线上，导致：

1. **类型噪音**：上传素材产生的 `asset_analysis`（"AI 识别素材"）等辅助 job 也混进视频生成进度面板。
2. **历史堆积**：多次「一击生成」后，旧批次（avatar_generation / talking_head / video_render）的完成态 job 全部滞留面板；页面刷新后 `localJobs=null` 回退到 `serverJobs`（30 条），历史一次性全堆出来。

用户诉求：面板只保留三类（视频合成 / AI 形象训练 / 视频任务），每次有新任务就刷新，不要堆积之前的进度。

## 2. 根因

- 渲染流程（`lib/services/render-pipeline.ts:43-83`）一次性创建 3 个 job：`avatar_generation`、`talking_head`、`video_render`，**共享同一个 `projectId`**。
- 「AI 形象 → 口播预览」路径（`app/api/avatars/talking-head/route.ts:66`）创建的 `talking_head` job **无 `projectId`**（独立预览）。
- `Job.projectId` 可空（`lib/types.ts:147`），是天然的「批次键」。
- `localJobs` 仅在 `simulateOneClickRender` 里 `setLocalJobs(plannedJobs)` 一次，从不清理；这是会话内堆积与刷新回退堆积的共同来源。

## 3. 方案选择

采用 **方案 A：派生「最新批次」**——纯前端计算，零新增状态。

等价转换：「留最近一批」≡「取 `createdAt` 最新的那一批」。因为新任务的 job 时间戳必然最新，会自动顶替旧批次成为面板显示项，天然实现「每次有新任务就刷新、不堆积」，且页面刷新后仍只显示最新一批。无需改 API/DB，无需显式清空逻辑。

被否决的备选：
- B（扩展 `localJobs` 显式批次）：刷新即丢失「当前批次」语义，边界 case 多。
- C（服务端按 `projectId` 过滤）：要改 API+repo，过度工程。

## 4. 行为规格

1. **类型过滤**：面板只展示 `type ∈ { video_render, avatar_generation, talking_head }`。`asset_analysis`、`subtitle_generation`、`quota_monthly_reset` 一律不展示。
2. **最新批次**：在通过类型过滤的 job 中，按 `批次键 = job.projectId ?? job.id` 分组，只展示 `max(createdAt)` 那一组。
   - 渲染流程 → 一组 3 个 job（共享 projectId）。
   - 独立口播 → 单 job 自成一组（键为其 id）。若它是最新操作，面板只显示这 1 条——符合「每次有新任务就刷新」。
3. **自动顶替**：新批次出现后，旧批次从面板消失（DB 历史保留，仅 UI 不展示）。
4. **批次内排序**：按 type 优先级 `avatar_generation(0) < talking_head(1) < video_render(2)`，自上而下即流水线顺序。
5. **空状态**：无任何视频类 job 时，维持现有「当前任务队列 / 准备中」空态。
6. **「清理已完成」按钮**：行为不变（`DELETE /api/jobs` 清 owner 全部终态 job、清 DB 历史）。按钮显隐条件随最新批次的终态判定（`hasTerminalJobs` 改基于过滤后的批次）。

## 5. 核心纯函数

新建 `lib/dashboard-jobs.ts`（独立文件便于单测）：

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
 * 1. 只保留视频类 job；
 * 2. 按 projectId 分组，返回 createdAt 最新的那一组；
 * 3. 组内按 type 流水线顺序排序。
 *
 * 新任务的 job 时间戳最新 → 自动成为显示批次，旧批次随之隐藏。
 */
export function selectLatestBatchJobs(jobs: Job[]): Job[] {
  const visible = jobs.filter((job) =>
    (PANEL_JOB_TYPES as readonly string[]).includes(job.type)
  );
  if (visible.length === 0) return [];

  let latestCreatedAt = "";
  for (const job of visible) {
    if (job.createdAt > latestCreatedAt) latestCreatedAt = job.createdAt;
  }
  const latestKey = batchKey(
    visible.find((job) => job.createdAt === latestCreatedAt) ?? visible[0]
  );

  return visible
    .filter((job) => batchKey(job) === latestKey)
    .sort((a, b) => (TYPE_ORDER[a.type] ?? 99) - (TYPE_ORDER[b.type] ?? 99));
}
```

## 6. `components/dashboard.tsx` 接线改动

- 引入 `selectLatestBatchJobs`。
- 在 jobs/outputs 两个 `useQuery` 之后，新增派生值：
  ```ts
  const allJobs = localJobs ?? serverJobs;
  const progressJobs = useMemo(() => selectLatestBatchJobs(allJobs), [allJobs]);
  ```
- 把以下消费点全部从「全量 jobs」改用 `progressJobs`：
  - `useJobProgressSSE(progressJobs)`（SSE 只订阅最新批次的 job 进度）。
  - `jobsWithProgress` 的 `useMemo`（SSE 进度合并到 `progressJobs` 而非全量）。
  - `hasTerminalJobs`（基于过滤后批次判定）。
  - 时间线渲染（`jobsWithProgress.map(...)`）。
  - jobs 查询的 `refetchInterval`：`selectLatestBatchJobs(localJobs ?? query.state.data ?? []).some(活跃) ? 5000 : false`（轮询只在最新批次还有 queued/processing 时进行，避免对隐藏的旧批次空轮询）。
  - render-outputs 查询的 `refetchInterval`：同样改用 `progressJobs.some(活跃)`。

接线顺序：jobs `useQuery` → `allJobs` / `progressJobs` memo → render-outputs `useQuery`（其 `refetchInterval` 闭包引用 `progressJobs`）→ `useJobProgressSSE(progressJobs)`。

## 7. 标签对齐（`jobTypeLabels`）

- `video_render`：`"视频合成中"` → **`"视频合成"`**（进行/完成态已由右侧 `jobStatusLabels` 体现，标题无需「中」字）。
- 显式补 `talking_head: "视频任务"`（不再依赖 `?? "视频任务"` 兜底，语义更清晰；兜底仍保留作安全网）。
- 删除 `asset_analysis`、`subtitle_generation` 两个不再被展示的条目。

最终：
```ts
const jobTypeLabels: Record<string, string> = {
  avatar_generation: "AI 形象训练",
  talking_head: "视频任务",
  video_render: "视频合成"
};
```

## 8. 边界与安全

- **无 projectId 的 job**：`batchKey` 回退到 `job.id`，每个独立口播自成一批，符合预期。
- **同批次 createdAt 并列**：渲染流程的 3 个 job 由 `createMany` 写入，createdAt 可能并列；`find` 取第一个命中即得到批次键，随后 `filter` 按 `batchKey` 取全组，排序由 `TYPE_ORDER` 决定，结果稳定。
- **跨批次时间戳比较**：用 ISO 8601 字符串字典序比较（`nowIso()` 产出统一格式），等价于时间顺序比较。
- **IDOR / 鉴权**：本改动纯前端展示，不新增任何路由；job 数据仍由 `GET /api/jobs` 经 owner 限定返回，无新增暴露面。
- **限流**：轮询范围从「全量 30」收窄到「最新批次 ≤3」，请求量只减不增，对既有 429 限流修复无负面影响。

## 9. 不在范围内

- 不删除 DB 中的历史 job（保留审计；`322672e` 的 cap 仍生效）。
- 不改动 `localJobs` 的写入时机（仍由 `simulateOneClickRender` 即时反馈用）。
- 不调整「产物预览」区域逻辑（`completedOutputs` 维持现状）。
- 不引入 job 顺序配置 UI。

## 10. 测试计划（TDD）

先写测试、见红，再实现。

**单元测试**（`tests/dashboard-jobs.test.ts`）覆盖 `selectLatestBatchJobs`：
1. 过滤掉 `asset_analysis` / `subtitle_generation` / `quota_monthly_reset`。
2. 多个 `projectId` 批次时，只返回 createdAt 最新的那一批。
3. 共享 `projectId` 的 3 个渲染 job 视为一组、全部返回。
4. 无 `projectId` 的独立 job 自成一批；当其 createdAt 最新时单独返回。
5. 空输入 → `[]`。
6. 批内按 `avatar_generation → talking_head → video_render` 排序（即便传入乱序）。

**组件测试**（追加到 `tests/dashboard.test.tsx`，复用 `vi.stubGlobal("fetch")` harness）：
7. `/api/jobs` 返回两个批次的渲染 job（旧批 createdAt 更早）→ 面板时间线只渲染最新批次的 3 个标题（`AI 形象训练` / `视频任务` / `视频合成`），旧批次标题不出现。
8. `/api/jobs` 返回含 `asset_analysis` 噪音 + 一个 `video_render` → 面板只见 `视频合成`，不见 `AI 识别素材`。

**回归**：`npm run typecheck && npm test && npm run lint && npm run build` 全绿。
