# 设计：talking-head 异步化 + 真实视频合成

**日期**：2026-07-06
**状态**：已批准（设计评审），待 spec 复审 → writing-plans
**关联**：交接简报"两个待优化项"（数字人挪进 BullMQ worker；真实 ffmpeg 合成）

---

## 1. 背景与目标

两个耦合的优化：

- **opt1（解除 HTTP 同步阻塞）**：`POST /api/avatars/talking-head` 当前在请求线程内同步完成 HeyGen 创建 + 1–5 分钟轮询 + 下载 + 上传 R2，无 job、无异步返回。目标：路由立即返回 202 + jobId，worker 异步跑，前端走既有 SSE 拿进度。
- **opt2（真实视频合成）**：`worker/processors/video-render.ts` 当前是占位（睡 500ms、造假 `renders/<id>/output-<vid>.mp4`）。目标：用 ffmpeg 把"选中素材 + 字幕 + BGM + 数字人口播视频"按 Mode C（数字人全屏 + B-roll 插播）合成最终短视频。

两者必须一起设计：opt2 的 video_render 依赖 talking-head 的产物 → 必须先定 job 编排。

---

## 2. 现状（已核实）

### 2.1 talking-head 子系统
- `app/api/avatars/talking-head/route.ts:5-23`：POST 同步 `await requestAvatarTalkingHead`，返回 `jsonOk({ result }, 201)`。**无 job、无鉴权、无 IDOR 校验**。
- `lib/services/avatar-provider.ts:80-126`：`requestAvatarTalkingHead`，成功返回 `{ mode:"talking_head", videoAssetId, durationSeconds }`，`allowFallback` 时返回**伪造** `{ mode:"tts_voiceover", audioAssetId: createId("tts") }`（不真合成 TTS，不落 R2）。
- `lib/services/providers/heygen.ts:137-207`：`generateTalkingHead` 把 create（POST `/v3/videos`）+ 轮询（GET `/v3/videos/{id}`，默认 5s×60=5min）+ 下载 + `putObjectFromBuffer("avatars/<id>.mp4")` 揉成一个阻塞调用，返回 `videoAssetId`（实为 R2 storageKey）。30s/请求 超时，**无退避重试**。
- **产物零持久化**：mp4 只写 R2 key，不落 Asset / VideoOutput，不关联 RenderProject。路由拿到 key 直接吐回客户端，刷新即丢。
- `components/dashboard.tsx:596`：口播文本**硬编码** `"今天来店里尝尝招牌产品"`，未接 `ScriptDraft.voiceover`。

### 2.2 render-pipeline 与 worker 基建
- `lib/services/render-pipeline.ts:35-75`：`planRenderJobs` 规划 `[avatar_generation?] → video_render`，video_render 的 `dependsOnJobIds` 指向前面所有 job。
- `lib/queue.ts:4-11`：`queueNames` 6 个映射。`toQueuePayload`（`:27-46`）`attempts:3, exponential 5s`。`toFlowJobs`（`:55-108`）把 flat job 列表翻译成 FlowProducer 树。
- `worker/index.ts:137-144`：`jobTypes` 数组驱动为每个 type 起 `new Worker(concurrency:2)`。
- `worker/processors/video-render.ts:13-49`：占位 —— 睡 500ms，造假 storageKey，写 `VideoOutput(status:"ready")`，不在 processor 里设 RenderProject status（交给 `finalizeProjectStatus`）。
- `worker/finalize-project.ts:17-55`：集中处理 project 终态（全 completed 且有 render 产物 → ready；全 failed → failed）。
- `app/api/jobs/[id]/progress/route.ts`：SSE 实现是**轮询 DB**（1s/次，5min 超时），非 Redis pub/sub。
- `lib/use-job-progress.ts`：`useJobProgressSSE(jobs)`，仅对 queued/processing 的 job 开 EventSource。
- `app/api/render-projects/route.ts:30-202`：POST 一键成片，校验 + 消费配额 + planRenderJobs + FlowProducer 入队，返回 **201**（应为 202）。`:83-87` 无条件把 `recoverRenderFailure`（slideshow 降级 job）和主链**并行入队**，而非失败后兜底。

### 2.3 ⚠️ 关键发现：`toFlowJobs` parent/child 方向反转（b7，critical）

BullMQ FlowProducer 语义（[官方文档](https://docs.bullmq.io/guide/flows)）：*"parent job will not be moved to wait status until all its children have been processed"* —— **child 先跑，parent 等 child 完成才跑**。

因此对于依赖关系"A 必须先于 B 运行"，正确映射是 **A=child、B=parent**（A 作为 B 的 child，A 先跑，B 后跑）。

但 `lib/queue.ts:55-108` 的实现把**依赖者（dependent）注册成 child、被依赖项（dependency）注册成 parent**（`:70-77` 遍历 `job.dependsOnJobIds`，把 `job` 推进 `childrenOf[depId]`）。结果是：执行顺序与依赖关系**正好对调**。

现有 job 全是秒级 mock/占位（avatar_generation 立即 ready、video_render 睡 500ms），所以这个反向 bug 从未暴露。但本设计新建的**三级真实 DAG 会被它彻底反向执行**（video_render 先于 talking_head 先于 avatar_generation）。

该 bug 还被 `tests/queue-flow.test.ts:32-65` **固化成测试**（用误导性的 `parentJob`/`childJob` 命名断言"无依赖项是 flow parent"）。**修复必须同步改 `toFlowJobs` 和它的测试。**

### 2.4 数据模型（prisma/schema.prisma）
- `RenderProject`（`:151-171`）：`selectedAssetIds String[]`、`avatarProfileId?`、`aspectRatio`、`subtitleStyle`、`bgmTrackId?`、`status String`。无 enum，status 是裸 String（项目约定）。
- `Job`（`:173-187`）：`type String`、`status String`、`progress Int`、`payload Json`、`dependsOnJobIds String[]`、`error?`。
- `VideoOutput`（`:189-200`）：`storageKey`、`coverStorageKey?`、`aspectRatio`、`durationSeconds Float`、`status String`。**无 `kind` 字段区分产物类型**。
- `ScriptDraft`（`:131-149`）：`scenes Json`、`voiceover String`、`captions String[]`。
- `ScriptScene`（lib/types.ts:101-106）：`order`、`text`、`durationSeconds`、`assetHints String[]`。**已有 durationSeconds + assetHints，B-roll 切点和字幕时间轴可从 scenes 派生，无需 AI 重新生成时间。**
- `Asset`（`:78-99`）：`type String`（约定 `image`/`video`）、`storageKey`、`durationSeconds?`、`tags`、`businessTags`。

### 2.5 ffmpeg 依赖现状
- `worker/Dockerfile`：`node:20-alpine`（`:8`），仅 `apk add --no-cache openssl`（`:12`）。**无 ffmpeg，无 CJK 字体。**
- `package.json`：有 `bullmq`、`ioredis`；**无 `fluent-ffmpeg`、无 `ffmpeg-static`、无 `child_process` 调用。**
- ffmpeg 可行性（[核验](https://pkgs.alpinelinux.org/package/edge/community/x86/ffmpeg)）：Alpine community repo 有 ffmpeg v8.1.2（含 libx264/libass）；`node:20-alpine` 官方镜像**默认启用 community repo**；与现有 `apk add openssl` 同路径开箱即用。**结论：维持 Alpine base，无需换 debian-slim。** CJK 字体用 `font-noto-cjk`（备选 `font-wqy-zenhei`）。
- 实证状态：本地 Docker build 因 Docker Hub 不可达（未配代理）未完成；ffmpeg 结论基于 web 证据 + 现有 openssl 先例。**实证留给 CI（ubuntu runner 自带 ffmpeg）+ 首次 Zeabur worker 部署。**

---

## 3. 决策（已与用户对齐）

| 决策 | 选择 |
|---|---|
| talking-head 架构 | **新增独立 `talking_head` JobType，双入口复用同一 processor**（独立预览路由 + 一键成片管线）。DAG：`avatar_generation → talking_head → video_render`。 |
| 合成画面 | **Mode C：数字人全屏 + B-roll 插播**。时间轴/B-roll 切点/字幕全从 `ScriptDraft.scenes` 派生。 |
| 既有 bug | **6 个全修**（探索后又发现 b7，共 7 个，详见 §6）。 |
| ffmpeg 方案 | **fluent-ffmpeg + 系统 ffmpeg（apk）**。不引入 ffmpeg-static。 |

---

## 4. 设计

### §A Job DAG 与新 JobType

新增 `talking_head` JobType（`lib/types.ts:25-31` 的 `JobType` 联合 + `lib/queue.ts:4-11` 的 `queueNames` 加 `talking_head: "talking-head"` + `worker/index.ts:137-144` 的 `jobTypes` 数组）。

一键成片管线变为三级 FlowProducer 树（依赖 §H 修复后的 `toFlowJobs`）：

```
POST /api/render-projects  →  video_render (root/parent)
                                └─ talking_head (child = video_render 的依赖)
                                     └─ avatar_generation (child = talking_head 的依赖，仅当 profile 未就绪)
```

- BullMQ children-first → avatar_generation 先跑 → talking_head → video_render。✅
- `avatar_generation`：profile 供给（已存在，逻辑不变；顺手清 b6 死代码）。
- `talking_head`：profile + 脚本文本 → 合成口播视频。**双入口**：
  - 独立预览路由 `/api/avatars/talking-head`：入队单 job（无 video_render 包裹），profile 已就绪时也无 avatar_generation。
  - 一键成片管线：作为 video_render 的 child。
- BullMQ FlowProducer 的 parent-child **不传产物**，所以 talking_head 必须把 mp4 落库（§B），video_render 启动时按 projectId 查（§F）。

### §B 数据模型变更

顺应项目"无 Prisma enum、status/type 裸 String"的约定。

| 改动 | 位置 | 说明 |
|---|---|---|
| `VideoOutput.kind` 新字段 | `prisma/schema.prisma:189-200` + `lib/types.ts` + `lib/repositories/types.ts`/`mappers.ts` | `String`，取值 `"talking_head" \| "final_composite" \| "slideshow"`。**需 Prisma migration**（新增列，默认值给现存行填 `"final_composite"`）。 |
| `ScriptScene.role` 新字段 | `lib/types.ts:101-106` + `lib/services/script-engine.ts`（含 `buildTemplateScenes:279` 和 AI schema `:25-35`） | `"presenter" \| "broll"`。**scenes 是 Json 字段，无需 DB migration**（仅类型 + builder）。默认：hook 场（order=1）和 CTA 场（末位）= presenter，中间产品场 = broll。AI 生成时在 prompt 里要求返回 role；template fallback 在 `buildTemplateScenes` 里写死。 |
| `talking_head` job payload | 新 | `{ avatarProfileId, scriptText, providerAvatarId, providerVoiceId }`。`scriptText` 从 `ScriptDraft.voiceover` 取（修 b2）。 |
| `video_render` job payload 扩展 | `render-pipeline.ts:57-72` | 加 `compositionMode: "presenter_broll" \| "asset_only"`，由 `includeAvatar` 决定。 |
| `VideoOutput.renderProjectId` 改可空 | `prisma/schema.prisma:192,199` + `lib/types.ts` + mappers | 由必填 FK 改为 `String?` + `project RenderProject?`。承载预览 talking-head 产物（`renderProjectId=null`，§8 Q1）。需 migration + 处理 `output.project` 的 strict-null 分支。 |
| `BgmTrack` 新 model | `prisma/schema.prisma` 新增 | `id`、`name`、`storageKey`（指向 R2 `bgm/<trackId>.mp3`）、`durationSeconds`、`category`、`createdAt`。**系统级曲目库（无 ownerId）**，前端列出供选曲。worker 按 `bgmTrackId` 查 `storageKey` → R2 GET。需 migration + seed 3–5 首。 |

**跨 job 取产物**：repository 新增 `findTalkingHeadOutputByProject(projectId): Promise<VideoOutput | null>`（按 `renderProjectId + kind="talking_head"` 取最新一条）。video_render processor 启动时调它。

### §C HeyGen provider 重构（opt1 核心）

`lib/services/providers/heygen.ts` 把 `generateTalkingHead`（`:137-207`）拆成三段，让 processor 能塞进度上报：

```
createTalkingHeadJob(input)              → POST /v3/videos → { videoId }
pollTalkingHeadStatus(videoId, onProgress) → 轮询，onProgress(attempt, max) 回调
downloadAndStore(videoId)                → 下载 mp4 + putObjectFromBuffer → storageKey
```

- 轮询仍在 worker 内同步跑（worker 是后台进程，阻塞无碍），但 `onProgress` 回调让 processor 调 `job.updateProgress(Math.round(attempt/max*100))`，**接通进度链路**（修 SSE 静止问题）。
- 保留 30s/请求超时 + 5min 轮询上限。BullMQ `attempts:3` 已提供退避重试。
- `requestAvatarTalkingHead`（`avatar-provider.ts:80-126`）的**假 tts 兜底删除**（`:122`，修 b3）；失败就抛错 → 走 §G 优雅降级。
- `tests/providers/heygen.test.ts` 更新：拆分后的三段各自 mock fetch。

### §D talking_head processor（新增）

`worker/processors/talking-head.ts`：

```
1. 读 payload { avatarProfileId, scriptText, providerAvatarId, providerVoiceId } + projectId + ownerId
2. provider = createProviderFromEnv()
3. { videoId } = createTalkingHeadJob(...)
4. pollTalkingHeadStatus(videoId, (a,m) => job.updateProgress(round(a/m*60)))  // 进度留头部空间给下载
5. storageKey = downloadAndStore(videoId)   // R2 key avatars/<videoId>.mp4
6. durationSeconds = status.duration
7. VideoOutput { renderProjectId: projectId, kind:"talking_head", storageKey, durationSeconds, aspectRatio:"9:16", status:"ready" }
   → getRenderRepository().createOutput(...)
8. job.updateProgress(100)
```

在 `worker/processors/index.ts` 注册 + `worker/index.ts` 起 Worker。独立预览路由入队的 talking_head job 没有 projectId —— step 7 写一条 `kind:"talking_head"`、`renderProjectId=null` 的 VideoOutput（详见 §8 Q1）；管线入口则填真实 projectId。

### §E talking-head 路由异步重写（修 b1、b2、b4）

`app/api/avatars/talking-head/route.ts`：

```
POST body: { avatarProfileId, scriptDraftId }   // scriptText 改由 scriptDraftId 查
1. ownerId = getOwnerId()   // 修 b1
2. rateLimit (applyRateLimit)   // 与 app/api/avatars/route.ts 对齐
3. avatar = getAvatarRepository().findById(avatarProfileId)
4. IDOR guard: avatar.ownerId === ownerId，否则 404/403   // 修 b1
5. draft = getScriptRepository().findById(scriptDraftId); IDOR guard
6. scriptText = draft.voiceover   // 修 b2
7. 消费配额：调 `consumeQuota(ownerId)`（预览也扣，§8 Q2 已定）；不足返 402
8. 创建 talking_head Job（无 projectId，ownerId=ownerId）+ DB 持久化
9. hasRedis() ? 入队 : 同步兜底（dev）
10. jsonOk({ jobId, statusEndpoint: "/api/jobs/<id>/progress" }, 202)   // 修 b4
```

前端 `components/dashboard.tsx:596` 改为：POST 拿 jobId → `useJobProgressSSE([jobId])` → 完成后展示 R2 预签名 URL 的口播视频。

### §F video_render processor — 真实 ffmpeg 合成（Mode C）

**依赖**：`fluent-ffmpeg`（npm，`complexFilter` API + `onProgress`）+ 系统 ffmpeg（worker Dockerfile apk）。`@types/fluent-ffmpeg` 入 devDependencies。

**Dockerfile**（`worker/Dockerfile:12`）：
```dockerfile
RUN apk add --no-cache openssl ffmpeg font-noto-cjk font-dejavu-sans
```

**processor 流程**（`worker/processors/video-render.ts` 重写）：

```
1. 查 talking-head 产物：th = findTalkingHeadOutputByProject(projectId)
   mode = th ? "presenter_broll" : "asset_only"   // 无产物自动降级（§G）
2. 读 ScriptDraft.scenes、selectedAssetIds、bgmTrackId、aspectRatio、subtitleStyle
3. 拉输入到 worker /tmp（R2 GET → 本地文件）：
     th.mp4（若有）、选中素材（image/video）、bgm（按 bgmTrackId 查 `BgmTrack.storageKey` → R2 GET，§B）
4. timeline = buildTimeline(scenes, th?.durationSeconds)   // 纯函数，可单测
5. ass = generateAss(timeline, subtitleStyle)             // 纯函数，可单测，写 /tmp/subs.ass
6. 跑 ffmpeg（fluent-ffmpeg complexFilter，详见下）→ /tmp/output.mp4
7. 上传 R2 renders/<projectId>/output-<vid>.mp4
8. VideoOutput { kind:"final_composite", storageKey, durationSeconds, aspectRatio, status:"ready" }
   → createOutput(...)
9. job.updateProgress(100)
```

**可单测的纯函数**（TDD 重点，不依赖 ffmpeg）：
- `buildTimeline(scenes, thDuration?) → Segment[]`：累计 `durationSeconds` 得每段 `[start, end]`；role 来自 `scene.role`；broll 段按 `assetHints` ∩ `Asset.tags/businessTags` 选素材，回退轮询 `selectedAssetIds`。
- `generateAss(timeline, style) → string`：每段一条 Dialogue 行（start/end 来自 timeline，text 来自 scene.text）；`[V4+ Styles]` 头由 `subtitleStyle` 映射（v1 提供 3 个预设：`default`/`bold_bottom`/`minimal`）。
- `resolveCompositionMode(thOutput) → "presenter_broll" | "asset_only"`：纯逻辑。

**ffmpeg 装配策略**（v1 用单 pass `filter_complex`；若实现时发现过于脆，回退多 pass：clips → concat → 烧字幕 → 混音）：
- presenter 段：`[th.mp4]trim=start=X:duration=Y,setpts=PTS-STARTPTS,scale=W:H,setsar=1,fps=30`
- broll 段：图 `loop`/视频 `trim` 到该段时长，`scale=W:H,setsar=1,fps=30`
- `concat=n` 拼视频轨
- 音频：`[th.mp4]aformat` 取全程 voiceover（若短于 timeline，末尾 `apad` 补静音）
- BGM：`[bgm]volume=-20dB` 后 `amix` voiceover（v1 不做 sidechain ducking，YAGNI）
- 烧字幕：`subtitles=/tmp/subs.ass`（需 CJK 字体，§2.5）
- scale/pad 到 `aspectRatio`（9:16 → 1080×1920），H.264 + aac 输出

**fluent-ffmpeg `onProgress(({percent}) => job.updateProgress(percent))`** → 前端 SSE 看到真实 0→100。

**asset_only 模式**：跳过 presenter 段，所有段用选中素材轮播，其余逻辑相同。

### §G 失败处理与降级（修 b3、b5）

- **删除 `recoverRenderFailure` 的无条件并行入队**（`render-projects/route.ts:83-87`，修 b5）。
- talking_head 失败（BullMQ 3 次重试耗尽）→ 无 talking-head VideoOutput → video_render 启动时 `resolveCompositionMode` 返回 `"asset_only"` → **自动降级出纯素材片**，不造假 assetId（修 b3）。
- **移除 `slideshow_render` job 类型**（`queueNames`、`jobTypes`、processor 注册、`recoverRenderFailure`）—— 降级内化进 video_render 的 asset_only 模式。同步删 `tests/queue-flow.test.ts:50-65` 里引用 slideshow 的测试用例（或改写）。
- talking-head 音频短于 timeline、HeyGen 截断等边界：`apad` 补静音 + log 警告，不 fail。

### §H 修复 toFlowJobs（b7，critical，DAG 落地前提）

`lib/queue.ts:55-108`：parent/child 方向反转。正确语义：**dependency=child（先跑）、dependent=parent（后跑）**。

修复要点：
1. `childrenOf` 改为映射 **dependent.id → [它的 dependencies]**（把 dependency 作为 dependent 的 child）。
2. `topLevel` 改为 **不被任何 in-batch job 依赖的 job**（即不出现在任何 job 的 `dependsOnJobIds` 里的 job —— 这些是终极 dependent，即 video_render）。
3. 保留"依赖全在 batch 外 → 视为 top-level"的行为（外部依赖由调用方保证顺序）。

**TDD**：重写 `tests/queue-flow.test.ts`，把误导性的 `parentJob`/`childJob` 改名为 `firstStep`/`lastStep`，断言：
- 三级链 A→B→C：`flows` 长度 1，root = C，C.children[0] = B，B.children[0] = A。
- BullMQ 语义注释：children-first → A、B、C 顺序执行。
- 外部依赖 job 仍为 top-level。

**回归**：`tests/api/render-projects.test.ts:173` 和 `tests/render-pipeline.test.ts:82` 断言的是 `dependsOnJobIds`（planRenderJobs 的输出，不涉及 toFlowJs 树），不受影响 —— 但要补一个端到端断言：实际入队的 flow 树 root 是 video_render。

### §I 进度上报修复

- 各 processor 在有意义节点调 `job.updateProgress`：talking_head（HeyGen 轮询进度 + 下载）、video_render（fluent-ffmpeg onProgress）。
- worker 主循环 `worker.on("progress")`（`worker/index.ts:124-132`）已把 BullMQ progress 写回 DB —— processor 一旦调 updateProgress，DB → SSE 链路自动通。
- SSE 端点维持 DB 轮询（v1 不升级 Redis pub/sub，YAGNI）；5min/连接上限由前端 EventSource 重连兜住。

### §J Dockerfile 与依赖

- `worker/Dockerfile:12` 加 `ffmpeg font-noto-cjk font-dejavu-sans`（§F）。
- `package.json` dependencies 加 `fluent-ffmpeg`；devDependencies 加 `@types/fluent-ffmpeg`。
- **CI**（`.github/workflows/`）：ubuntu runner 自带 ffmpeg，集成测试可直接跑；如缺失则加 setup。本地 dev：README 补"装 ffmpeg"说明（mac `brew install ffmpeg`，Win 见 README:82）。

---

## 5. Bug 清单（共 7 个，全修）

| # | 位置 | 问题 | 修复落点 |
|---|---|---|---|
| b1 | `app/api/avatars/talking-head/route.ts` | 无鉴权、无 IDOR 校验 | §E（路由重写） |
| b2 | `components/dashboard.tsx:596` | 口播文本硬编码，未接 ScriptDraft.voiceover | §E + §B payload |
| b3 | `lib/services/avatar-provider.ts:122` | tts 兜底造假 assetId | §C（删除）+ §G（降级） |
| b4 | `app/api/render-projects/route.ts:164` / talking-head 路由 | 异步受理返回 201 | §E（改 202） |
| b5 | `app/api/render-projects/route.ts:83-87` | recoverRenderFailure 并行入队 | §G（删除） |
| b6 | `worker/processors/avatar-generation.ts:25-46` | 重复 findById 死代码 | 顺手清 |
| **b7** | **`lib/queue.ts:55-108` + `tests/queue-flow.test.ts`** | **toFlowJobs parent/child 反转，DAG 会反向执行** | **§H（critical）** |

---

## 6. 测试策略（TDD）

| 层 | 测试 | 备注 |
|---|---|---|
| render-pipeline 单测 | `planRenderJobs` 含 talking_head；依赖链 avatar⊂talking⊂video；includeAvatar=false 时不含 | 扩展 `tests/render-pipeline.test.ts` |
| toFlowJobs 单测 | 三级链 root=video_render；children-first 顺序；外部依赖 top-level | 重写 `tests/queue-flow.test.ts`（§H） |
| heygen provider 单测 | create/poll/download 三段各自 mock fetch；onProgress 回调触发 | 更新 `tests/providers/heygen.test.ts` |
| 纯函数单测 | buildTimeline、generateAss、resolveCompositionMode | 新增 `tests/video-compose.test.ts` |
| video_render 集成 | 最小 "图+字幕+BGM → mp4" 冒烟，ffprobe 断言非空；Mode C 与 asset_only 两路径 | CI（ubuntu 自带 ffmpeg）；本地 skip if 无 ffmpeg |
| 降级路径 | talking_head 失败 → video_render 出 asset_only 片 | 集成测试 mock |
| 路由 | talking-head 路由：未鉴权 401、IDOR 404、返回 202+jobId | 扩展 `tests/api/` |

---

## 7. 实现顺序（writing-plans 会展开）

1. **b7 修复**（toFlowJobs + 测试重写）—— 单独提交，先解锁 DAG 正确性，可独立验证。
2. **数据模型**：`VideoOutput.kind` + migration；`ScriptScene.role`（仅类型 + builder）。
3. **talking_head 全链路**：provider 拆分（§C）→ processor（§D）→ 队列注册 → 路由异步化（§E）→ 前端 SSE。
4. **ffmpeg 依赖**：Dockerfile + package.json。
5. **video_render 真实合成**：纯函数（buildTimeline/generateAss）→ ffmpeg 装配 → Mode C → asset_only 降级（§F、§G）。
6. **收尾**：删 slideshow_render、修进度上报、清 b6、b4/b5 收口。

---

## 8. 风险与开放问题

- **R1（最高）§F Mode C filter graph 复杂度**：单 pass `complexFilter` 可能在实现时过脆。缓解：纯函数先全单测覆盖；ffmpeg 装配允许回退多 pass；集成测试兜底。若 Mode C 时间预算超支，**回退到"asset_only 先出片，数字人产物存库不嵌画面"**（设计的 §3 备选），不阻塞 opt1。
- **R2 CJK 字体**：已 web 核验 `font-noto-cjk` 可装；首次 Zeabur 部署实证。若缺失，备选 `font-wqy-zenhei`。
- **R3 talking-head 音视频时长对齐**：HeyGen 产物时长与 scenes 累计时长可能漂移；`apad`/末帧 pad 兜底，log 警告。
- **Q1 独立预览的 talking-head 产物持久化** ✅ 已定：写一条 `kind:"talking_head"` 的 VideoOutput。**schema 影响**：`VideoOutput.renderProjectId` 当前是必填 FK（`schema.prisma:192,199`），预览产物无 project → 改为**可空**（`String?` + `project RenderProject?`）。预览产物 `renderProjectId=null`，管线产物照常填 projectId。`findTalkingHeadOutputByProject(projectId)` 按 `renderProjectId+kind` 查，天然只命中管线产物（预览不会被 video_render 误取）。需 migration + 顺手处理读取 `output.project` 的 strict-null 分支。
- **Q2 预览是否扣配额** ✅ 已定：**扣配额**。talking-head 调用消耗 HeyGen 额度，预览也扣（防滥用），复用既有 `consumeQuota(ownerId)`；配额不足返回 402，与 render-projects 一致。
- **Q3 BGM 库来源** ✅ 已定：**R2 固定前缀 `bgm/<trackId>.mp3` + 新 `BgmTrack` 系统级曲目库表**（id/name/storageKey/durationSeconds/category）。加/换曲目只上传 R2 + 改表，不重建镜像、不重部署；前端可列曲目 + 预签名 URL 试听。v1 seed 3–5 首。详见 §B。

---

## 9. 不做（YAGNI）

- Ken Burns 推拉镜、sidechain ducking、卡拉OK 逐字高亮字幕 —— v1 不做。
- SSE 升级 Redis pub/sub —— DB 轮询够用。
- 真实 TTS provider 接入（b3 删除假兜底后，降级是"出无声/纯素材片"，不引入新 TTS 服务）。
- 字幕样式全自定义 UI —— v1 只提供 3 个预设。
