# Phase 1：录入与素材基础 — 设计文档

- **日期**：2026-07-23
- **状态**：spec 已确定，待写 plan
- **归属**：[视频生成体验改造总路线图](./2026-07-23-video-pipeline-overhaul-roadmap.md) Phase 1「录入与素材基础」
- **覆盖需求**：#1 门店档案 AI 建议（"重新生成一批"）/ ★ 素材标签可靠性 + 兜底

---

## 1. 背景与目标

路线图把 Phase 1 定为"录入与素材基础"。探索代码后发现两件事：

1. **门店档案 AI 建议是纯新增**——门店数据今天只喂给脚本生成（`script-engine.ts:buildUserPrompt`），没有任何"为门店档案字段生成建议"的能力。用户手填 `mainProducts`/`sellingPoints`/`targetCustomers` 等数组字段成本高。
2. **素材标签"已完成"是假象**——数据结构（`Asset.tags`/`AssetAnalysis`）确实在了，但可靠性兜底几乎全缺，且失败静默：
   - `Asset.tags`/`Asset.businessTags` **永远是空 `[]`**（confirm 写空、`classifyAsset` 从不回写），真正的标签只在 `AssetAnalysis` 上。
   - **没有 analysis 状态字段**——pending/failed/succeeded 无法观测，只能靠"有没有 AssetAnalysis 行"猜。
   - 规则兜底（`inferBusinessTags`）**只覆盖餐饮/烘焙**，其他行业拿到近乎空的 `businessTags`/`keywords` → `matchAssetsToScenes` 拿到空 features → **分镜出现"待匹配"空洞**。
   - 上传时还**硬编码假输入**喂给 AI（`dashboard.tsx:697-698`：永远 `["food","person","storefront"]` + 餐饮话术转写），对非餐饮门店是主动误导——这是非餐饮标签烂的根因之一，不只是规则兜底的锅。

**目标**：
- (A) 门店档案：AI 一键建议难填字段，用户审阅后保存。
- (B) 素材标签：让分类失败**可见且可恢复**，非餐饮也有合理兜底，分镜不再因空标签断档。
- (C) 停止向 AI 撒谎——去掉硬编码假输入。

核心设计原则：**失败可见，但分镜不断**——AI 挂了仍写规则兜底标签，下游 `matchAssetsToScenes` 不至于拿到全空 features。

---

## 2. 非目标（明确不做，留后）

- 标签可视化（展示 `keywords`/`recommendedUses`）+ 手动编辑 UI —— Phase 1 决策留后；现有 `StoryboardConfirm` 已能手动 pin 素材兜底。
- 回写 `Asset.tags`/`Asset.businessTags`（数据一致性 ③）—— 留后。
- 分类移入 BullMQ 队列（方案 2）—— 留后；本 Phase 保持同步路径。
- 真实 CV（图像识别）+ ASR（语音转写）—— 独立 epic，本 Phase 只做"诚实输入"（不硬编码假值）。
- 分区导航 hub-spoke、store 表单抽独立组件 —— Phase 3。
- 上传循环并行化（`Promise.all`）—— 后续优化，不入本 Phase。

---

## 3. 设计决策（含理由）

| # | 决策 | 理由 |
|---|---|---|
| D1 | 门店建议**输入仅** `name`+`industry`+`location` | 门店档案是第一步（在素材上传前），不依赖素材；契合主流程 |
| D2 | 门店建议**输出 5 字段**：`mainProducts`/`sellingPoints`/`targetCustomers`/`promotions`/`brandTone` | 这 5 个是难填的自由文本/数组；`name`/`industry`/`location` 是事实性不建议 |
| D3 | 建议结果**预填表单不自动保存**，用户审阅后走现有"保存" | 避免覆盖用户已有输入；最小改动复用现有 upsert |
| D4 | 标签可靠性走**方案 1（同步路径加固）**，不入队 | 精准命中三件事且不动近期上线的多素材上传流（低风险）；方案 2 重构成本/回归风险与"打基础"性价比不匹配 |
| D5 | 新增 `AssetAnalysis.analysisStatus`（pending/succeeded/failed），**3 态** | rule-only（无 AI key / worker 路径）算 `succeeded`——不是失败，且此时 reanalyze 也无 AI 可升级，标 failed 会误导 |
| D6 | AI 失败时 `status=failed` **但仍写规则兜底标签** | "失败可见"与"分镜不断"两者兼得 |
| D7 | reanalyze **强制走 AI**（`analysisUnavailable:false`）；无 AI key 返 503 | reanalyze 的语义就是"升级到 AI 标签"，无 AI 时是 no-op |
| D8 | 规则兜底扩到零售/美业/教育/生活服务 | 消除非餐饮"近乎空标签" |
| D9 | 去掉硬编码假 `visualLabels`/`transcript`，无真实 CV/ASR 时传空 | 消除餐饮偏见；`inferTagsFromFilename` 仍跑，文件名命中仍得标签 |

---

## 4. Part A：门店档案 AI 建议

### 4.1 数据模型
无 schema 变更。复用 `StoreProfile`（`prisma/schema.prisma:53-76`）现有字段。

### 4.2 服务层（新增）
`lib/services/store-suggest.ts`：

```ts
export interface StoreSuggestionInput {
  name: string;
  industry: string;
  location?: string;
}
export interface StoreSuggestion {
  mainProducts: string[];
  sellingPoints: string[];
  targetCustomers: string[];
  promotions: string[];
  brandTone: string;
}
export async function suggestStoreProfile(input: StoreSuggestionInput): Promise<StoreSuggestion>;
```

- **system prompt 服务端写死**（CLAUDE.md 规则 3：绝不把用户输入当 system prompt），约束输出 5 字段语义（主营产品/卖点/目标客群/促销/品牌调性各几条）。
- user prompt 由 `sanitizePromptField` 处理后的 name/industry/location 拼装。
- 调 `chatCompletionJSON<StoreSuggestion>`，带 JSON schema 约束（4 个 `string[]` + `brandTone` `string`），`temperature: 0.6`，`maxTokens: 800`。
- AI 返回 `null`（空响应）→ 抛 `StoreSuggestionError`，由路由转 502。**不静默返兜底垃圾**。
- 对返回做防御性规整：非数组字段兜底为 `[]`、截断超长、去重。

### 4.3 API（新增）
`POST /api/store-profiles/suggest`（新路由，与现有 `app/api/store-profiles/route.ts` 同级目录下 `suggest/route.ts`）：

- 鉴权：`const ownerId = await getOwnerId();`（CLAUDE.md 规则 1，canonical pattern = `app/api/assets/route.ts`）。
- 限流：写桶 `applyRateLimit`（AI 调用昂贵，先复用写桶；若实测被滥用再加 AI 专属桶）。
- 入参 Zod 校验：`{ name: z.string().min(1), industry: z.string().min(1), location?: z.string() }`，`safeParse` 失败 400。
- `request.json()` try/catch 包裹，解析失败 400（CLAUDE.md 规则 2）。
- 成功 200 返 `StoreSuggestion`；AI 失败 502 `{ message: "AI 建议生成失败，请重试或手动填写" }`。用 `jsonOk`/`jsonError`，不泄漏 stack/内部路径（规则 8）。

### 4.4 UI（`components/dashboard.tsx`）
- **单个** "AI 建议·重新生成一批" 按钮，在 step2 和 step3 都渲染（同一 handler）。一次点击 = 一次 API 调用，**填充全部 5 个建议字段**（step2 的 mainProducts/targetCustomers/sellingPoints + step3 的 promotions/brandTone）；step3 字段虽当前不可见，值已写入表单 state，用户前进到 step3 即见。
- 启用条件：step1 的 `name`+`industry` 已填（未填禁用 + tooltip「先填写店名和行业」）。
- 点击：`pendingAction` 置位 → 调 `POST /api/store-profiles/suggest`（`lib/api-client.ts` 加 `suggestStoreProfileApi`）→ 成功把返回数组 CSV join 后**预填对应表单字段**（复用 `storeProfileToFormValues` 的反向逻辑），**不调 saveStore**；失败 toast。
- "重新生成"语义：**覆盖建议字段**（而非追加），因为是 regenerate。

### 4.5 错误处理
| 场景 | 行为 |
|---|---|
| AI 空/错 | 路由 502，UI toast，不写脏数据 |
| name/industry 缺失 | 按钮 disabled；路由 400 |
| 无 auth | 401 |

---

## 5. Part B：素材标签可靠性兜底

### 5.1 数据模型 + 迁移
`AssetAnalysis`（`prisma/schema.prisma:101-112`）新增：

```prisma
analysisStatus String @default("pending")  // pending | succeeded | failed
```

- 同步 `lib/types.ts` 的 `AssetAnalysis` 类型、`lib/repositories/memory.ts`、prisma→type mapper（`lib/repositories/mappers.ts`）。
- 迁移：`prisma migrate dev --name add_asset_analysis_status`；**手动在生成的 migration SQL 里追加回填**：
  ```sql
  UPDATE "AssetAnalysis" SET "analysisStatus" = 'succeeded';
  ```
  （存量行已有标签，不应显示为 pending。）

### 5.2 `classifyAsset` 改造（`lib/services/assets.ts:194-237`）
返回的 `AssetAnalysis` 对象新增 `analysisStatus`：

- `!analysisUnavailable && hasAI()` 分支：
  - AI 成功 → `analysisStatus: "succeeded"`
  - catch（空/解析错）→ **仍跑 `ruleBasedClassify` 拿兜底标签**（保持现有行为），但 `analysisStatus: "failed"`，`confidence` 降到 `0.3`。日志保留 `[assets] AI classification failed...`。
- rule-only 分支（`analysisUnavailable` 或无 key）→ `analysisStatus: "succeeded"`（按配置跑完，非失败）。
- confidence 精确逻辑：`aiFailed ? 0.3 : (analysisUnavailable ? 0.35 : calculateConfidence(...))`。当前代码（assets.ts:233）只区分 `analysisUnavailable ? 0.35 : calculateConfidence`，需加 `aiFailed` 分支。

> 注意：`classifyAsset` 返回的对象由调用方（analyze / reanalyze 路由）持久化，`analysisStatus` 需随对象流入 `AssetAnalysisRepository.create/update`。

### 5.3 规则兜底扩展（`lib/services/assets.ts:279-306`）
- `inferBusinessTags`：当前 `if (industry.includes("餐饮")||includes("烘焙"))` 之后**新增分支**覆盖零售/美业/教育培训/生活服务，每行配关键词→业务标签映射（如美业→"造型展示"/"门店环境"；零售→"新品"/"促销"；教育→"课程展示"；生活服务→"门店环境"/"口碑"）。
- `extractBusinessKeywords`：扩充候选词列表（不再只 `["牛肉面","可颂",...]`）。
- `inferTagsFromFilename`（267-277）保留不动——文件名启发式与行业无关，通用。

### 5.4 Repository（补 update）
`AssetAnalysisRepository`（`lib/repositories/types.ts:27-32`）当前只有 `create/findByAssetId/listByIds/listByOwner`，**补 `update(assetId, data)`**：
- 接口、prisma 实现、memory 实现三处都加。
- `update` 覆盖 `analysisStatus` + 各 tag 字段，按 `assetId`（unique）定位。

### 5.5 Reanalyze API（新增）
`POST /api/assets/[id]/reanalyze`（新路由）：

- 鉴权：`getOwnerId()`。
- **IDOR 所有权校验**：加载 asset，`asset.ownerId !== ownerId` → 403（同其他 `[id]` 路由模式，规则 1）。
- 限流：写桶。
- 加载 asset + 其 store（行业上下文，复用现有 `getStoreRepository().findById(asset.storeId)`）。
- 无 AI key（`!hasAI()`）→ 503 `{ message: "未配置 AI，无法重新分析" }`（D7）。
- 调 `classifyAsset({ asset, store, analysisUnavailable: false })` 强制走 AI。
- 用 `getAssetAnalysisRepository().update(assetId, result)` 更新现有 `AssetAnalysis` 行（而非新建——`assetId` 唯一）。
- 返 200 + 更新后的 analysis；AI 失败时 analysis 已是 `failed`+兜底标签，仍返 200（分析完成，只是降级），UI 据状态提示。

### 5.6 UI（`components/dashboard.tsx` "AI 自动分类"卡片 ~1121-1134）
- `GET /api/asset-analyses` 响应已带 `analysisStatus`（mapper 改后自动）。
- 每个选中素材显**状态徽章**：
  - `succeeded` → 绿「已分析」
  - `failed` → 琥珀「分析失败·已用兜底」+ **"重新分析"按钮**
  - `pending` → 灰「分析中」
- "重新分析"按钮：调 `POST /api/assets/[id]/reanalyze`（`lib/api-client.ts` 加 `reanalyzeAssetApi`），loading 态，成功后用 react-query `invalidateQueries(["asset-analyses"])` 刷新。

### 5.7 错误处理
| 场景 | 行为 |
|---|---|
| 上传时 classify AI 空/错 | status=`failed` + 规则兜底标签；分镜不断；UI 露"重新分析" |
| reanalyze AI 再失败 | status 保持 `failed`，标签仍兜底；返 200 |
| 无 AI key reanalyze | 503 |
| reanalyze 越权 | 403 |
| reanalyze asset 不存在 | 404 |

---

## 6. Part C：诚实输入

`components/dashboard.tsx:694-699` 上传循环里的 `analyzeAssetApi` 调用，**删除**：

```ts
visualLabels: ["food", "person", "storefront"],
transcript: `${store.mainProducts[0]}刚出锅，午餐出餐很快`
```

改为不传这两个字段（或传 `visualLabels: []`、省略 `transcript`）。`classifyAsset` 已用 `input.visualLabels ?? []`（assets.ts:197）和 `input.transcript ?` 条件处理缺省，无需改服务层。`inferTagsFromFilename` 仍跑，文件名命中（如 `牛肉面.mp4`）仍得标签。

> 后果：AI 失去假的视觉/语音信号，分类更依赖文件名+门店上下文，**更多素材会落到规则兜底或 `failed`**——但这是诚实的，且 D5/D6 的状态+兜底+reanalyze 给了用户恢复路径。真实 CV/ASR 是后续 epic。

---

## 7. 安全考量（映射 CLAUDE.md）

| 规则 | 本设计如何遵守 |
|---|---|
| 1 认证 | 两个新路由都用 `getOwnerId()`；reanalyze 加 IDOR 所有权校验；不直接读 `demoOwnerId` |
| 2 输入校验 | suggest 入参 Zod `safeParse`；`request.json()` try/catch；reanalyze 校验 asset 归属 |
| 3 AI/LLM 安全 | system prompt 全部服务端写死；用户输入（name/industry/location/filename）一律 `sanitizePromptField`；不把用户输入当 system prompt |
| 4 密钥 | `OPENAI_API_KEY` 不入日志/响应；`hasAI()` 仅返布尔 |
| 8 错误信息 | 用 `jsonOk`/`jsonError`，不泄漏 stack/路径；reanalyze 失败用规范化消息 |

---

## 8. 测试策略（TDD，red-green）

### 单元
- `lib/services/store-suggest.ts`：成功解析 5 字段并防御性规整；AI 返 `null`→抛 `StoreSuggestionError`；输入经 `sanitizePromptField`（断言 prompt 里不含原始危险字符）。
- `lib/services/assets.ts` `classifyAsset`：AI 成功→`analysisStatus:"succeeded"`；AI 抛错→`"failed"` 且仍含规则兜底标签 + confidence 低；rule-only→`"succeeded"`。
- `inferBusinessTags`：扩后覆盖零售/美业/教育/生活服务（断言各行业命中对应标签）。
- `extractBusinessKeywords`：扩充候选词命中。

### Repository
- `AssetAnalysisRepository.update`：prisma + memory 双实现（按既有 repository 测试模式）。

### API
- `POST /api/store-profiles/suggest`：无 auth 401；缺 name/industry 400；AI 失败 502；成功 200 形状正确（mock `chatCompletionJSON`）。
- `POST /api/assets/[id]/reanalyze`：401/403（越权）/404/503（无 key）/200；AI 失败→返 200 且 analysis.status=`failed`。

### UI（React Testing Library）
- 门店建议按钮：未填 name+industry 时 disabled；成功预填表单；失败 toast。
- 标签徽章：三态渲染；"重新分析"按钮点击流程（mock fetch + invalidate）。

---

## 9. 文件变更清单

| 文件 | 变更 |
|---|---|
| `prisma/schema.prisma` | `AssetAnalysis` 加 `analysisStatus` |
| `prisma/migrations/<ts>_add_asset_analysis_status/` | 新迁移 + 回填 SQL |
| `lib/types.ts` | `AssetAnalysis` 类型加 `analysisStatus` |
| `lib/repositories/types.ts` | `AssetAnalysisRepository` 加 `update` |
| `lib/repositories/prisma.ts` | 实现 `update` |
| `lib/repositories/memory.ts` | 实现 `update` + analysisStatus 字段 |
| `lib/repositories/mappers.ts` | prisma→type mapper 带 `analysisStatus` |
| `lib/services/store-suggest.ts` | **新增** `suggestStoreProfile` |
| `lib/services/assets.ts` | `classifyAsset` 返 `analysisStatus`；扩 `inferBusinessTags`/`extractBusinessKeywords` |
| `lib/schemas.ts` | 加 `storeSuggestionInputSchema` |
| `lib/api-client.ts` | 加 `suggestStoreProfileApi` + `reanalyzeAssetApi` |
| `app/api/store-profiles/suggest/route.ts` | **新增** POST |
| `app/api/assets/[id]/reanalyze/route.ts` | **新增** POST |
| `app/api/asset-analyses/route.ts` | 无代码改（mapper 改后自动带 status） |
| `components/dashboard.tsx` | 门店建议按钮 + 标签徽章 + reanalyze 按钮 + 删假输入(697-698) |
| `tests/store-suggest.test.ts` | **新增** |
| `tests/api-store-profiles-suggest.test.ts` | **新增** |
| `tests/assets.test.ts`（或现有 classify 测试文件） | 加 analysisStatus + 规则扩展用例 |
| `tests/repositories.test.ts`（或对应文件） | 加 `update` 用例 |
| `tests/api-assets-reanalyze.test.ts` | **新增** |
| `tests/dashboard.test.tsx` | 加按钮/徽章用例 |

无新依赖。`chatCompletionJSON`/`sanitizePromptField`/fluent-ffmpeg 等均已就绪。

---

## 10. 未来 epic（记 backlog）

- 真实 CV（图像标签）+ ASR（语音转写）—— 彻底解决输入质量。
- 分类移入 BullMQ 队列（方案 2）—— 解除上传串行阻塞。
- 回写 `Asset.tags`/`businessTags` —— 统一数据源。
- 标签可视化 + 手动编辑 UI。
