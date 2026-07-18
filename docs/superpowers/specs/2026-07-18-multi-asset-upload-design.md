# 素材库多素材上传 + 成片全量使用（方案 A）

- 日期：2026-07-18
- 范围：`components/dashboard.tsx` 状态重构 + 网格 UI；`lib/api-client.ts` 新增两个调用；`lib/repositories/*` 新增 `deleteById`；`lib/storage.ts` 新增 `deleteObject`；新增 2 个 API 路由（`DELETE /api/assets/[id]`、`GET /api/assets/[id]/preview-url`）
- 不涉及：Prisma schema 改动、worker、render pipeline、ffmpeg 合成链路（均已是多素材原生）

## 1. 背景与问题

素材库（`components/dashboard.tsx` 的 `.uploadZone` / `.mediaItem`）当前只能上传并展示**一个**素材，根因是前端从状态到 UI 全程按单值假设：

- 状态 `localAsset: Asset | null`（dashboard.tsx:254）单值。
- `handleFileInputChange` 只读 `event.target.files?.[0]`（dashboard.tsx:593-599），`<input>` 无 `multiple`（dashboard.tsx:859-865）。
- 完成态只渲染一个 `.mediaItem`（dashboard.tsx:883-903）。
- 派生 `asset = serverAssets.find((item) => item.storeId === store.id)`（dashboard.tsx:326-327）取首个。
- 一键生成处 `selectedAssetIds: [asset.id]`（dashboard.tsx:662）硬编码单个。
- 脚本生成处 `assetAnalysisIds: [analysis.id]`（dashboard.tsx:656）只传 1 个 analysis。

用户诉求：素材库可上传多个素材，成片时把素材都用上。

## 2. 关键事实（探索结论）

**后端从数据模型到 ffmpeg 合成已原生支持多素材，瓶颈纯在前端：**

- `RenderProject.selectedAssetIds: String[]`（prisma/schema.prisma:156；types.ts:133；schemas.ts:122 `z.array(z.string().min(1)).min(1)`）。
- `worker/processors/video-render.ts:100-110` 取整个 `selectedAssetIds` 列表（非首个）。
- `buildTimeline`（lib/services/video-compose.ts:30-82）已支持多 scene × 多 asset：先 `assetHints ∩ tags` 匹配，无匹配则 `round-robin` 在多个 broll 场景间分配不同素材。
- `buildFilterGraph` 的 `assetInputIndex: Record<string, number>` 为每个素材分配独立 ffmpeg 输入（video-compose.ts:191-256；video-render.ts:182-196）。
- `AssetAnalysis.assetId @unique` 与 `Asset` 1:1（schema.prisma:101-112）。

**附带正确性 bug**：脚本生成（`createScriptDraft`）只接收 1 个 analysis，AI 仅产出 1 个 broll 场景。即便 `selectedAssetIds` 传 5 个，`buildTimeline` 没有足够 broll 场景去安置其余素材 —— "都用上"落空。修法：`assetAnalysisIds` 传全部勾选素材的 analysis。

## 3. 方案选择

采用 **方案 A：前端顺序上传 + 最小后端增量**。

核心模型转变：素材从「单值」变为「集合 + 选择子集」。

```
素材库（store 维度池，DB 持久化）
  asset_1 [✓] asset_2 [✓] asset_3 [ ] asset_4 [✓]
        └──────── 勾选进入 ────────┘
                    ↓
   selectedAssetIds = [asset_1, asset_2, asset_4]
   assetAnalysisIds = [analysis_1, analysis_2, analysis_4]
                    ↓
   POST /api/script-drafts（AI 看到多素材标签 → 多个 broll 场景）
                    ↓
   POST /api/render-projects { selectedAssetIds, scriptDraftId }
                    ↓
   worker video_render：buildTimeline 把多素材分配到多 broll 场景
```

被否决的备选：
- B（新增批量上传端点）：confirm/analyze 仍 N 次写，治标不治本；PUT 直传 S3 本不走我们 API。
- C（放宽上传路径写限流）：重新打开刚修复（commit `3b7cbc2`）的 429 死亡螺旋风险。

## 4. 行为规格

1. **多文件选择**：`<input type="file" multiple accept="video/*,image/*,audio/*">`；支持拖拽（`onDrop` 取 `dataTransfer.files`）。
2. **顺序上传**：逐个文件 intent→PUT→confirm→analyze，不并行（保护写限流）。
3. **失败隔离**：单个文件失败标记为 failed，不阻断整批；提供单文件重试。
4. **默认全选**：页面加载该 store 下所有素材默认勾选；新上传素材自动勾选。
5. **勾选/取消**：每张卡片左上角 checkbox 切换 `selectedAssetIds`。
6. **删除**：卡片右上角 × → 确认 → 硬删（DB 行 + best-effort S3 对象），从库与选择集移除。
7. **缩略图**：视频 `<video preload="metadata">`（首帧）、图片 `<img>`、音频静态图标；src 来自 preview-url。
8. **成片门禁**：`selectedAssets.length === 0` 时禁用"一键生成"按钮 + 提示"请至少勾选一个素材"。
9. **训练视频**：数字人训练取 `selectedAssets.find(a => a.type === "video")?.id`（第一个勾选的视频）；无视频时训练步骤提示。
10. **软上限**：单 store 12 个素材，超出前端拦截。

## 5. 后端改动

### 5.1 存储层 `lib/storage.ts`

新增 `deleteObject(storageKey: string): Promise<void>`：封装 S3 `DeleteObjectCommand`，**best-effort** —— 对象不存在（404/NoSuchKey）不抛错，DB 删除不因 S3 清理失败而回滚。复用已有 `createPresignedGetUrl`（产物预览特性已加）。

### 5.2 仓库层 `lib/repositories/`

`AssetRepository` 接口（types.ts:19-23）新增：
```ts
deleteById(id: string): Promise<boolean>;  // 返回是否真的删了一行
```
- **memory**（memory.ts:45-58）：`Map.delete(id)`，连带删 analysis Map 里 `assetId === id` 的项；返回是否原存在。
- **prisma**（prisma.ts:85-102）：`$transaction` 先删 `assetAnalysis`（FK 约束、schema 无级联声明、必须先删子表）再删 `asset`；`count === 0` 返回 false。

### 5.3 路由层 `app/api/assets/`

**A. `DELETE /api/assets/[id]/route.ts`（新增）**
1. `getOwnerId()`。
2. `findById(id)` → null 返 404。
3. **IDOR 守卫**：`asset.ownerId !== ownerId` 返 403（与 confirm 路由:37-40 一致）。
4. `deleteById(id)`（事务删 analysis + asset）。
5. best-effort `deleteObject(asset.storageKey)`（try/catch 吞错、仅记日志）。
6. `jsonOk({ id })` 200。

**B. `GET /api/assets/[id]/preview-url/route.ts`（新增）**
1. `getOwnerId()`。
2. `findById(id)` → null 返 404。
3. **IDOR 守卫**：owner 校验。
4. `createPresignedGetUrl(asset.storageKey, 300)`（5 分钟过期，安全规则 7）。
5. `jsonOk({ url, mimeType: asset.mimeType, type: asset.type })`。

### 5.4 不需要改的

- schema 零改动（`selectedAssetIds` 已是数组、`AssetAnalysis` 1:1 已存在）。
- 不新增 `findByIds` 批量方法（worker 现有 `Promise.all(map findById)` 够用，YAGNI）。
- render pipeline、worker、ffmpeg 链路全部不动。

## 6. 前端改动（`components/dashboard.tsx` + `lib/api-client.ts`）

### 6.1 状态重构

| 旧 | 新 |
|---|---|
| `localAsset: Asset \| null` | `localAssets: Asset[]`（本会话新上传、乐观追加、去重 by id）|
| `localAnalysis: AssetAnalysis \| null` | `localAnalyses: AssetAnalysis[]`（按 assetId 关联）|
| 无 | `selectedAssetIds: Set<string>`（默认全选）|
| 无 | `uploadingFiles: { id, name, progress, status: "uploading"\|"failed" }[]` |

派生：
```ts
const assets = dedupById([...localAssets, ...serverAssets.filter(a => a.storeId === store.id)]);
const analysesByAssetId = new Map([...serverAnalyses, ...localAnalyses].map(a => [a.assetId, a]));
const selectedAssets = assets.filter(a => selectedAssetIds.has(a.id));
```
`selectedAssetIds` 由 `useEffect` 在 `assets` 首次加载时 seed 全部 id（一次性），之后仅由用户勾选/上传/删除驱动。

工作流完成判据（dashboard.tsx:433）从 `Boolean(asset && analysis)` 改为 `assets.length > 0`。

### 6.2 多文件输入

`handleFileInputChange` 遍历 `Array.from(event.target.files)` 调 `handleAssetUploads(files)`；`<input>` 加 `multiple`；`.uploadZone` 加 `onDrop`。

### 6.3 顺序上传循环（替换单文件 `handleAssetUpload`）

```
for (const file of files) {            // 顺序，不并行
  uploadingFiles.push({ id, name, progress:0, status:"uploading" });
  try {
    intent = createUploadIntentApi(...);
    await uploadFileToStorage(intent.uploadUrl, file, ..., onProgress);
    asset = confirmAssetUpload(...);
    analysis = analyzeAssetApi(...);
    localAssets.push(asset); localAnalyses.push(analysis);
    selectedAssetIds.add(asset.id);     // 新上传自动勾选
  } catch (e) {
    uploadingFiles[i].status = "failed";
  }
}
```
- 顶部总进度"上传中 2/5" + 整体进度条。
- 失败文件显示重试按钮（单文件重传）。
- 整批结束 invalidate `["assets"]`、`["asset-analyses"]`。

### 6.4 网格 UI（替换 dashboard.tsx:883-940 单 `.mediaItem`）

`.uploadZone` 完成态改 `display:grid`，每个 `.mediaItem` 卡片：
- 缩略图区：按 `asset.type` 渲染 `<video preload="metadata">` / `<img>` / 音频图标，src 来自 preview-url。
- 左上角 checkbox：切换选择。
- 右上角 ×：确认 → `deleteAsset(id)` → 移除 + invalidate。
- 文件名 + meta（`name · 类型 · 大小` 或 `durationSeconds 秒`）。
- 上传中态：该卡自身进度条。

底部摘要"已选 N / 共 M"。空态（`assets.length === 0`）保留原 SVG + 提示。

### 6.5 成片与脚本生成接线（dashboard.tsx:653-662）

```ts
const draft = await createScriptDraftApi({
  storeId: store.id,
  assetAnalysisIds: selectedAssets
    .map(a => analysesByAssetId.get(a.id)?.id)
    .filter(Boolean),                  // 关键修复：传全部勾选 analysis
  purpose, platform: "douyin",
});
// 渲染项目
selectedAssetIds: selectedAssets.map(a => a.id),  // 替换 [asset.id]
```

### 6.6 API 客户端增量（`lib/api-client.ts`）

```ts
deleteAsset(id): Promise<void>                                    // DELETE /api/assets/[id]
getAssetPreviewUrl(id): Promise<{ url, mimeType, type }>          // GET /api/assets/[id]/preview-url
```

### 6.7 preview-url 获取策略（关键，避免重蹈 429）

- react-query，key `["asset-preview", assetId]`。
- `staleTime: 4min`（< 5min URL 过期、自动刷新）、`refetchInterval` 不设、`refetchOnWindowFocus: false`、`retry: false`。
- **不进入轮询周期**。当初 429 死亡螺旋来自 mount query × 轮询放大；preview 仅卡片 mount 取一次、缓存期内不重取。

## 7. 限流与约束核算

**写限流（20/min）**：每素材上传 = 3 写（intent、confirm、analyze；PUT 走 S3 不计）。顺序上传可持续 ~6 个/分钟。软上限 12 个；一次性顺序上传 ≈ 2 分钟，接近写桶上限，个别 429 走第 4.3 条失败标记 + 重试，不致命。

**读限流（60/min）**：dashboard mount 现有 ~7 个 read query + 活跃时 5s 轮询 ×2。preview-url：12 个一次性 read、严格不轮询、缓存 4min。峰值 7 + 12 = 19 read/min，远低于 60。安全。

**其他**：单文件沿用 `MAX_UPLOAD_BYTES` 200MB（storage.ts:4）；MIME 沿用 `video/*, image/*, audio/*`；删除硬删无回收站（YAGNI）；老的单素材数据天然 `assets.length === 1` + 默认全选，无需迁移。

## 8. 边界与安全

- **IDOR**：DELETE 与 preview-url 两个新路由都从 `getOwnerId()` 注入 owner，不接受客户端 body 传 ownerId；均做 `asset.ownerId === ownerId` 校验（安全规则 1/4）。
- **FK 级联**：prisma schema 无 `onDelete` 级联声明，`deleteById` 必须事务内先删 `assetAnalysis` 再删 `asset`，否则违反引用约束。
- **S3 删除 best-effort**：对象已不存在不阻断 DB 删除；DB 是真理来源。
- **preview URL 短过期**：5 分钟，符合安全规则 7；不生成长期 public URL。
- **Secrets**：新路由不输出 storageKey 内部细节，仅返回短期 presigned URL；不暴露任何密钥（规则 4）。
- **prompt 注入**：本特性不动 script-engine 的 system prompt；用户素材信息仍以服务端组装的标签形式进 userPrompt（规则 3 不变）。

## 9. 不在范围内

- 不新增 `findByIds` 批量仓库方法。
- 不做素材排序/拖拽重排。
- 不做服务端 ffmpeg 抽帧缩略图（用前端原生元素）。
- 不改 render pipeline / worker / ffmpeg 链路。
- 不按素材数计费（配额仍按 render 次数）。
- 不做软删/回收站。

## 10. 测试计划（TDD）

先写测试、见红，再实现。

**后端**（路径对齐现有约定：`tests/api/<kebab>.test.ts` 扁平、仓库仿 `tests/repositories/store.test.ts`）

| 测试 | 文件 | 覆盖 |
|---|---|---|
| `deleteById`（memory + prisma 双实现） | `tests/repositories/asset.test.ts`（新建） | 删存在返回 true、删不存在返回 false、连删关联 analysis、prisma 事务先删 analysis 再删 asset |
| `deleteObject` | `tests/storage.test.ts`（追加） | 对象不存在（NoSuchKey）不抛错 |
| DELETE 路由 | `tests/api/assets-delete.test.ts`（新建） | 404 不存在、403 IDOR、200 成功删 + 触发 S3 删 |
| preview-url 路由 | `tests/api/assets-preview-url.test.ts`（新建） | 404、403 IDOR、200 返回 url + mimeType + type |

**前端**（追加到 `tests/dashboard.test.tsx`，复用 `vi.stubGlobal("fetch")` harness）

| 测试 | 覆盖 |
|---|---|
| 多文件解析 | `handleFileInputChange` 解析多个 File |
| 顺序上传循环 | mock api-client：3 文件依次调 intent/confirm/analyze、失败标记不阻断后续、新上传自动勾选 |
| 选择状态 | 默认全选 seed、勾选/取消切换、`selectedAssets` 派生 |
| 成片门禁 | 0 勾选时按钮禁用 |
| 传全修复 | mock fetch 校验 script-drafts 与 render-projects 请求体含全部选中 id |
| 删除 | 调 `deleteAsset` 后从库与选择集移除 |

**回归**：`npm run typecheck && npm test && npm run lint && npx prisma validate && npm run build` 全绿。worker/video-render 链路不动，无需新增集成测试（已有多素材支持）。
