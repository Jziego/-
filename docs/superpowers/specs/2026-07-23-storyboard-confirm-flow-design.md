# Phase 2 · 核心分镜确认流 设计文档

- **日期**: 2026-07-23
- **阶段**: [总路线图](./2026-07-23-video-pipeline-overhaul-roadmap.md) Phase 2
- **状态**: 设计已与用户确认，待写实现计划
- **范围**: 把「一键直渲染」改造为「生成分镜脚本 → 用户确认/修改 → 再渲染」，含时长档位、素材自动匹配、BGM 选曲、字幕样式选择

---

## 1. 背景与目标

当前 `simulateOneClickRender`（`components/dashboard.tsx:755`）把「生成脚本」和「建渲染项目」紧挨着执行，用户看不到生成的脚本，也无法修改就进入了渲染。

本阶段在两者之间插入一个**确认环节**：AI 先产出一条**分镜脚本**（口播文案 + 每镜自动匹配的素材 + 建议字幕样式 + 建议 BGM），用户在确认界面可逐镜改文案、换素材、调字幕/BGM，确认后才触发数字人渲染与视频合成。

### 目标

- 生成 → **确认** → 渲染 的显式三段流程，确认前不建渲染项目。
- 每镜文案自动匹配一个素材（简化版匹配，基于现有 `AssetAnalysis`）。
- 时长落在营销甜点区，由用户选档位控制。
- BGM 可选、字幕样式可选（复用现有 3 预设）。

### 非目标（YAGNI，不在本阶段）

- 「换个表达方向」（换语气重写整稿）→ Phase 3。
- 拖拽分镜排序 → Phase 3。
- 字幕网感深度样式扩充（新增综艺体预设 / 逐字高亮）→ Phase 3。本阶段仅复用现有 3 预设做下拉选择。
- 分区导航 hub-spote 重构 → Phase 3。
- 上传时 AI 打标签的可靠性增强 / 标签可视化编辑 UI → Phase 1（标签体系已存在，本阶段只消费）。

---

## 2. 现状基线（已确认的代码事实）

| 实体 | 位置 | 说明 |
|---|---|---|
| `ScriptDraft` | `prisma/schema.prisma:131` | `scenes Json` 可自由扩展；已有 title/hook/voiceover/captions/cta/generationMode/complianceWarnings |
| `ScriptScene` 类型 | `lib/types.ts` | 现有 `{ order, text, durationSeconds, assetHints, role }` |
| `Asset.tags` / `businessTags` | `schema.prisma:92-93` | **已存在** |
| `AssetAnalysis` | `schema.prisma:101` | 1:1 于 Asset；`visualTags/businessTags/keywords/recommendedUses/confidence/transcript`，上传时由 worker `classifyAsset`（`lib/services/assets.ts:194`）AI 填充 |
| `createScriptDraft` | `lib/services/script-engine.ts:128` | 三级降级：forcedRawCopy → AI(`createScriptDraftWithAI`) → 模板(`createTemplateScriptDraft`)；输入 `ScriptDraftInput{store, assetAnalyses, purpose, platform?, forcedRawCopy?}` |
| `collectAssetHints` | `lib/services/script-engine.ts:325` | 已从 assetAnalyses 收集提示词（匹配的先例） |
| `POST /api/script-drafts` | `app/api/script-drafts/route.ts` | 已存在，接收 `assetAnalysisIds`，内部 fetch 分析后调 `createScriptDraft` |
| `POST /api/render-projects` | 已存在 | 已接收 `subtitleStyle` / `bgmTrackId` / `selectedAssetIds[]` |
| `BgmTrack` | `schema.prisma:203` | 系统级曲目（无 ownerId）：name/storageKey/durationSeconds/category；seed 3 首 |
| ffmpeg 混音 | `lib/services/video-compose.ts:296` | presenter 模式 amix ducked（配音 + BGM −20dB）；asset_only 模式 BGM −12dB |
| `buildTimeline` | `lib/services/video-compose.ts:57` | asset-driven 真实时长，presenter 模式按 TTS 配音时长封顶并缩放 |
| 字幕预设 | `lib/services/video-compose.ts:159` | `SUBTITLE_PRESETS`：default / bold_bottom / minimal；`resolveSubtitlePreset:187` |
| **缺** `PATCH /api/script-drafts/[id]` | — | 编辑分镜用，需新建 |
| **缺** `GET /api/bgm-tracks` | — | 选曲列表，需新建 |
| **bug** | `dashboard.tsx:783` | 硬编码 `bgmTrackId:"bgm_warm"`（seed 无此 id → 实际静音） |

---

## 3. 流程 / 状态机

```
现在:  [开始生成视频] → createScriptDraft → 立即 createRenderProject → 渲染
改为:  [生成分镜脚本] → createScriptDraft(增强: 时长档位+匹配+建议)
                     → 【确认界面 · 可编辑】
                     → (用户改文案/换素材/调字幕BGM → PATCH script-draft)
                     → [确认渲染] → createRenderProject(用编辑后 draft) → 渲染
```

- 「开始生成视频」按钮语义变为「生成分镜脚本」：只 `POST /api/script-drafts`（带 `targetDurationSec`），**不**建渲染项目。
- 确认界面读该 draft，用户编辑后 `PATCH /api/script-drafts/[id]` 持久化改动。
- 「确认渲染」把 draft 的 `matchedAssetId` 汇总为 `selectedAssetIds`，连同 `subtitleStyle`/`bgmTrackId` 建 `RenderProject`。
- `simulateOneClickRender` 拆成 `generateStoryboard` + `confirmAndRender` 两段。

---

## 4. 分镜脚本数据结构（扩展，不改 schema）

`ScriptDraft.scenes` 是 `Json`，扩展 `ScriptScene`（`lib/types.ts`）：

```ts
interface ScriptScene {
  order: number;
  text: string;              // 口播文案（用户可改）
  durationSeconds: number;   // 该镜预估时长
  role: SceneRole;           // presenter | broll
  assetHints: string[];      // 既有
  // —— 新增 ——
  desiredTags: string[];     // 该镜期望的素材标签/关键词（匹配器用）
  matchedAssetId: string | null;  // 自动匹配命中的素材；null = 待匹配
  matchTag: string | null;        // 命中依据（便于 UI 展示"为什么是它"）
}
```

`ScriptDraft` 顶层新增（同样落在既有字段或前端派生，无需 migration）：

| 字段 | 来源 | 说明 |
|---|---|---|
| `targetDurationSec` | 用户档位 | 15 / 30 / 60 |
| `estimatedDurationSec` | 引擎计算 | 各镜 durationSeconds 之和 |
| `suggestedSubtitleStyle` | AI 建议 | 取自现有 3 预设之一 |
| `suggestedBgmTrackId` | AI 建议 | 取自 BgmTrack 列表，按 purpose/brandTone 启发式选 |

> **持久化边界（本阶段零 migration）**：`scenes` 落在既有 `ScriptDraft.scenes Json`，编辑经 PATCH 持久化（跨会话可恢复）。`estimatedDurationSec` 前端从 scenes 派生即可。`suggestedSubtitleStyle` / `suggestedBgmTrackId` 及用户最终的字幕/BGM 选择**只在前端持有**（生成响应返回建议值），「确认渲染」时随 `POST /api/render-projects` 提交——因 `ScriptDraft` 表无字幕/BGM 列，不为它们加 migration；用户离开再回时字幕/BGM 回到 AI 建议默认值（可接受，因建议可复现）。

---

## 5. 时长档位控制（决策：B 档位制）

技术前提：**视频时长 ≈ TTS 配音长度**。所以控时长 = 在生成时控制文案量，而非事后拉伸。

- 档位：`short ≈ 15s` / `medium ≈ 30s`（默认）/ `long ≈ 60s`。
- `createScriptDraftWithAI` 的 system/user prompt 按档位给约束：
  - short → 2~3 镜，每镜口播 ≤ 12 字；
  - medium → 4~6 镜，每镜 ~20 字；
  - long → 6~10 镜。
  （现有 prompt 已有"15-30 秒"软提示 `script-engine.ts:69`，此处改为按档位参数化。）
- `estimatedDurationSec` = Σ scene.durationSeconds（AI 每镜估时）。
- `buildTimeline` 现有 TTS 封顶逻辑保留；`target` 作为软目标，落点只要在 15~60s 即视为达标（硬约束由档位保证，不追求精确命中）。

---

## 6. 素材自动匹配（简化版 + 定义 tags 契约）

### 契约（消费现有数据，不新建表）

- 素材侧可用特征（**已存在**）：`AssetAnalysis.businessTags ∪ keywords ∪ recommendedUses`（fallback 用 `Asset.businessTags` / `tags`）。
- 分镜侧：每个 scene 的 `desiredTags` = `scene.assetHints`（既有）∪ 从 `scene.text` 抽取的关键词。

### 匹配算法 `matchAssetsToScenes(scenes, assetsWithAnalysis)`

```
for each scene:
  desired = scene.desiredTags
  best = null; bestScore = 0
  for each asset (附带其 analysis 特征集 features):
    score = |desired ∩ features|            // 重叠计数
    // 去重鼓励：若 asset 已被前一镜命中且仍有别的候选，降权
    if score > bestScore and not (justUsed(asset) and hasAlternative):
      best = asset; bestScore = score
  scene.matchedAssetId = best?.id ?? null
  scene.matchTag = 命中的那个重叠标签 ?? null
```

- `bestScore == 0`（无任何重叠）→ `matchedAssetId = null`，UI 显示「待匹配」，用户手动选。
- 这是**简化版**：纯集合重叠 + 防连续重复。Phase 1 会增强（更智能的标签体系 / 相似度模型 / 置信度阈值）。
- 兜底：若素材库为空或全部 null，渲染时该镜用纯色背景/上一镜画面（沿用现有 broll 无素材处理）。

### 与生成的关系

- AI 生成 scenes 后，**立即**对每个 scene 跑匹配器，把 `matchedAssetId`/`matchTag` 写进 scene，再返回给前端。所以用户一进确认界面就看到"已匹配"。
- 用户「换素材」→ 从该 owner 的素材里选一个 → PATCH 覆盖 `matchedAssetId`。

---

## 7. 确认界面交互（布局 A + 编辑中等）

```
┌─ 分镜脚本   共 N 镜 · 预计 Xs ──────────┐
│ ① 镜1  [缩略图]  8s  匹配:门头照        │
│   “深圳创业老板注意啦…”                 │
│   [✏️ 改文案]  [🔄 换素材]              │
│ ② 镜2  [缩略图]  7s  匹配:产品图        │
│   “君姐在龙岗扎根15年…”                 │
│   [✏️ 改文案]  [🔄 换素材]              │
│ ③ 镜3  [待匹配]   ← 自动匹配失败,手选   │
│   …                                     │
├─────────────────────────────────────────┤
│ 字幕样式 [综艺黄(bold_bottom) ▾]         │
│ 背景音乐 [欢快01 ▾]   (试听 ▶)          │
│        [🔄 重新生成]  [✅ 确认渲染]      │
└─────────────────────────────────────────┘
```

- 逐镜：`✏️ 改文案` → 行内编辑 `scene.text`；`🔄 换素材` → 弹该 owner 素材选择器，覆盖 `scene.matchedAssetId`。
- 底部：字幕下拉（3 预设，带样式预览）；BGM 下拉（来自 `GET /api/bgm-tracks`，带试听）。
- `🔄 重新生成` → 带 `targetDurationSec` 重新 `POST /api/script-drafts`（覆盖当前 draft 或新建）。
- `✅ 确认渲染` → 汇总 `selectedAssetIds`（各镜 matchedAssetId 去重，跳过 null）+ 字幕 + BGM → `POST /api/render-projects`。

### 状态

- 生成中 / 编辑中 / 渲染中 三态。draft 持久化，用户可离开再回（按最新 draft id 恢复确认界面）。

---

## 8. API 改动

### 新增 `PATCH /api/script-drafts/[id]`

- 鉴权：`getOwnerId()`；只能改 `ownerId === 自己` 的 draft。
- Body（全可选）：`{ scenes?: Partial<ScriptScene>[] }`
  - `scenes` 支持改 `text` / `matchedAssetId`（按 order 对齐，顺序须连续）。
  - 不含字幕/BGM——这俩是前端持有态，「确认渲染」时随 `POST /api/render-projects` 提交（见持久化边界）。
- 校验：scenes 数组 order 连续；matchedAssetId（若给）须属于该 owner 且存在。
- 响应：更新后的 draft（`jsonOk`）。
- 复用 `lib/api-response.ts` 的 `jsonOk`/`jsonError`，`request.json()` try/catch。

### 新增 `GET /api/bgm-tracks`

- 返回系统曲目列表（`BgmTrack` 全量，无 ownerId 过滤）。
- 字段：`id / name / category / durationSeconds`（不返回 storageKey——预签名 URL 另走专门路由，防泄漏）。
- 试听 URL：复用既有预签名机制（若有），或本阶段先不提供试听、仅列表+名称。

### 改 `POST /api/script-drafts`

- 新增可选 `targetDurationSec`（默认 30），透传给 `createScriptDraft`。
- 生成后调 `matchAssetsToScenes` 填充 matchedAssetId 等，再返回。

### 改 `POST /api/render-projects`

- 已接收 subtitleStyle/bgmTrackId；确保 `selectedAssetIds` 来自确认后的 draft（前端汇总），不再前端硬编码。

---

## 9. 后端 service 改动

| 文件 | 改动 |
|---|---|
| `lib/services/script-engine.ts` | prompt 按档位参数化场景数/文案量；生成后调匹配器；返回带 matchedAssetId 的 scenes + suggested* |
| `lib/services/script-match.ts`（新） | `matchAssetsToScenes(scenes, assets)` 纯函数 + 关键词抽取 helper |
| `lib/services/render-pipeline.ts` | `createRenderProject` 接受来自确认 draft 的 selectedAssetIds/subtitleStyle/bgmTrackId |
| `lib/services/video-compose.ts` | `buildTimeline` 接受软 `targetDurationSec`（仅作记录/校验，落点靠档位保证） |
| `app/api/script-drafts/[id]/route.ts`（新） | PATCH handler |
| `app/api/bgm-tracks/route.ts`（新） | GET handler |
| `lib/api-client.ts` | `updateScriptDraft`、`fetchBgmTracks` 客户端方法 |
| `components/dashboard.tsx` | 拆 `simulateOneClickRender` → `generateStoryboard` + 确认界面组件 + `confirmAndRender`；修 `bgmTrackId` bug |
| `components/storyboard-confirm.tsx`（新） | 确认界面组件 |

---

## 10. 安全考量（遵循 CLAUDE.md 规则）

- 所有新路由用 `getOwnerId()`，绝不信任客户端 `ownerId`。
- `PATCH /api/script-drafts/[id]`：校验 draft.ownerId === ownerId；matchedAssetId 须属于同 owner。
- `GET /api/bgm-tracks`：只读系统曲目，不返回 storageKey / 预签名（防对象存储路径泄漏）。
- AI prompt 始终 server 端拼装，门店档案/素材特征经 `sanitizePromptField` 清洗后再入 prompt（防注入，既有惯例）。
- 写接口走 `applyRateLimit` 写桶（20/min），读接口走读桶（60/min）。

---

## 11. 测试策略（TDD，先红后绿）

- `lib/services/script-match.ts`
  - 标签重叠命中正确资产；
  - 无任何重叠 → `matchedAssetId = null`；
  - 连续两镜期望同一资产时，若有替代则分散；
  - 空素材库 → 全 null。
- `script-engine` 档位：short/medium/long 产出场景数落在区间。
- `PATCH /api/script-drafts/[id]`：改自己的 ok；改别人的 403/404；matchedAssetId 跨 owner 拒绝；非法 order 拒绝。
- `GET /api/bgm-tracks`：返回列表、不含 storageKey。
- `buildTimeline` target：target=30 时 Σ 在合理区间。
- 确认界面组件（`@testing-library`）：渲染分镜列表、✏️ 改文案触发 PATCH、🔄 换素材打开选择器、确认渲染汇总 selectedAssetIds。

---

## 12. 验收标准

1. 点「生成分镜脚本」→ 出确认界面，每镜已带匹配素材（或"待匹配"），显示预计时长。
2. 可逐镜改文案、换素材；改动持久化（刷新/离开再回仍在）。
3. 可选字幕样式（3 预设）与 BGM（系统曲目）。
4. 「确认渲染」后才进入数字人渲染 + 合成；确认前无渲染项目。
5. 时长落在所选档位区间（short≈15 / medium≈30 / long≈60，±容差）。
6. BGM 实际生效（修掉 bgm_warm bug）。
7. `npm test && npm run typecheck && npm run lint && npm run build` 全绿。

---

## 13. 关联

- 总路线图：[2026-07-23-video-pipeline-overhaul-roadmap.md](./2026-07-23-video-pipeline-overhaul-roadmap.md)
- Phase 1（前置）：门店档案 AI 建议、素材标签可靠性增强——本阶段的"简化匹配"在其之前可用；Phase 1 完成后匹配质量提升。
- Phase 3（后续）：字幕网感深度样式、分区导航、换表达方向 + 拖拽排序。
