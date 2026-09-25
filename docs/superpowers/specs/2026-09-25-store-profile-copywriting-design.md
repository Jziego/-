# 门店档案 AI 辅助 + 文案规则引擎设计（批次二：需求④⑤）

- 日期：2026-09-25
- 状态：设计已敲定，待实施
- 关联：参考图 `门店档案.png` / `文案.png`；调研存档（MoneyPrinterTurbo / short-video-factory 模板调研 2026-09-23）

---

## 1. 背景与目标

**④门店档案**：现有档案表单 + `suggestStoreProfile`（`lib/services/store-suggest.ts`）是「一键整组填充」模式，与目标产品形态（参考图：候选池逐条「填入」+「重新生成一批」）不符；且缺参考图的 3 个人设字段（称呼/年龄/店龄）。

**⑤文案规则**：现有 `SYSTEM_PROMPT`（`lib/services/script-engine.ts:79`）只有通用要求，没有参考产品的「三大原则 + 四大结构」方法论；生成是绝对单版（`generateScript` 一次一稿），无差异化角度；无文案解析输出；无反幻觉条款。

**目标**：档案区升级为参考图同款候选池交互；文案引擎每次生成前先读预写规则，结合门店档案产出有方法论的文案，附折叠的创作解析，支持「换个表达方向」按角度序列重生成。

## 2. 已拍板决策（2026-09-23/25 讨论记录）

| 决策点 | 结论 |
|--------|------|
| 多版文案 UX | **单版 + 「换个表达方向」按钮**（参考图同款），差异化角度藏在按钮后；不做一次 3 版并排 |
| 文案解析报告 | **要，折叠展示**（默认收起，点「查看创作解析」展开） |
| 主营业务上限 | **≤10 条**（用户原话）；特色/优势 ≤12 条（照参考图） |
| 候选池来源字段 | 主营业务（mainProducts）+ 门店特色/优势（sellingPoints）两个区；客群/活动/调性/违禁词保持手填 |
| 新字段 | 称呼 nickname、年龄 ownerAge、店龄 yearsInBusiness，均可选 |
| 规则文件形态 | `lib/copywriting-rules.ts` ts 常量（版本控制友好；不改逻辑代码即可迭代文案规则） |
| 解析生成方式 | 一次 LLM 调用同出（schema 加 analysis 字段），截断时**优先牺牲解析保文案**（解析放输出尾部） |

## 3. ④ 门店档案设计

### 3.1 数据模型（Prisma 迁移）

`StoreProfile` 新增 3 个可空字段：

```prisma
nickname        String?   // 朋友们对你的称呼（如「君姐」）
ownerAge        Int?      // 年龄
yearsInBusiness Int?      // 店龄（年）
```

仓库层（`lib/repositories/types.ts` / `prisma.ts` / `memory.ts`）与 `lib/schemas.ts` 的 upsert schema 同步加字段。memory 实现无迁移成本；prisma 一次 `migrate dev`。

### 3.2 候选池 API（改造 `app/api/store-profiles/suggest/route.ts` + `lib/services/store-suggest.ts`）

| 项 | 设计 |
|---|------|
| 入参新增 | `field?: "mainProducts" \| "sellingPoints"`；`exclude?: string[]`（已填入+已见过条目，避免重复出）；基础信息增加可选 nickname/ownerAge/yearsInBusiness |
| 兼容 | 不传 `field` 时保持现有整组建议行为（旧 UI 不破）；传 `field` 走候选池模式 |
| 输出（候选池模式） | `{ candidates: string[] }`，每批 **8 条**（现有 2-5 条不够挑） |
| prompt | 按 field 换专用 system prompt：主营=「该行业该店的主营业务条目，口语短语 ≤12 字」；特色=「门店特色/优势条目」；喂入全部基础信息；exclude 逐条列入「不要重复」 |
| 失败 | 沿用现状：AI 失败 → 502，前端提示重试或手填；`hasAI()`  false → 503 |
| 校验 | `lib/schemas.ts` 加 `storeSuggestionV2InputSchema`（field enum、exclude ≤40 条每条 ≤30 字，防注入沿用 `sanitizePromptField`） |

### 3.3 UI（档案表单区改造，`components/` 内档案表单组件）

参考图布局，两个候选池区块结构相同：

```
门店的主营业务（已填 N/10）
  1. xxx [删除]  …已填条目列表…
  [手输框][添加]
  ── 选择你的主营业务 ── [↻ 重新生成一批]
  候选1 [填入]  候选2 [填入]  …（8 条）
```

- 「填入」= 追加到已填列表（达上限则禁用并提示）；候选池条目点填入后从池中消失
- 「重新生成一批」= 带 exclude（已填+当前池中）再调 suggest，整池替换
- 已填条目随时可删可手改；手输框与候选池并存
- 基础信息区新增 3 个字段输入（称呼/年龄/店龄），门头照上传沿用现状（`storefrontAssetId`）
- 上限：mainProducts 10、sellingPoints 12（前端禁用+服务端 schema 双校验）

### 3.4 其余字段

目标客群/活动/品牌调性/违禁词：保持现有手填表单；整组建议能力（不传 field 的旧行为）保留供旧 UI 使用，档案区重做后可下掉旧调用（实施时确认无引用后清理）。

## 4. ⑤ 文案规则引擎设计

### 4.1 规则文件（新建 `lib/copywriting-rules.ts`）

ts 常量模块，导出结构化规则文本，供 script-engine 拼进 system prompt。章节：

```
概述：本地实体店短视频口播稿的定位与目标（同城获客）
三大原则：
  1. 锁同城原则 —— 开篇直呼地域人群，用地域背书降低防御心理
  2. 锁行业目标客户原则 —— 用行业痛点关键词精准筛选目标客群
  3. 兴趣点种草原则 —— 卖点转译为可量化收益，场景化表达
四大结构：
  1. 黄金开头结构 —— 身份呼唤+痛点暴击，前 3 秒锁注意力
  2. 高密度信息结构 —— 中段密集输出价值点，从软背书到硬功能
  3. 场景化种草结构 —— 描述具体应用场景，消解畏难情绪
  4. 行动号召结构 —— 结尾心理暗示式 CTA，不生硬喊话
反幻觉铁律（svf 借鉴）：
  不擅自编造产品参数、价格、优惠、数据、使用经历或效果承诺；
  文案事实必须能溯源到门店档案与素材分析
负面约束清单（MPT/svf 借鉴）：
  不客套开场、无 markdown/标题、只返回正文、无 Emoji、
  无镜头说明/舞台指令、不谈规则本身
```

规则文字本身在实施 Task 中成稿（以参考图「文案解析」板块的措辞风格为准），本 spec 只锁结构。

### 4.2 生成流程改造（`lib/services/script-engine.ts`）

| 项 | 设计 |
|---|------|
| system prompt | 现有要求（句数/highlights/onCamera/speakerAssignments）+ 规则文件全文注入，server-authored 不变 |
| user prompt | 门店信息块加入新字段：称呼/年龄/店龄（合成「人设句」原料，如「龙岗君姐15年」）；其余沿用现状 |
| 切入角度 | `COPY_ANGLES = ["痛点暴击","场景代入","利益直击","口碑背书","反差悬念"]`；生成时 system 或 user 段注明「本版切入角度：X」 |
| 换方向 | `POST /api/script-drafts` 加可选 `angle` 参数（取值限于 COPY_ANGLES）；不传默认序列首项；前端按当前 `draft.angle` 取序列下一项（到尾循环回首项）发新请求，确认卡片替换为新 draft |
| 文案解析 | JSON schema 尾部加 `analysis` 字段：`{ overview, principles, structure }` 三段文本（概述/三大原则对照/四大结构对照，措辞风格参照参考图解析报告）；LLM 输出顺序=文案字段在前、analysis 在最后 |
| 截断降级 | `maxTokens` 提高（+600 容纳解析）；整体截断时 analysis 落 null，**文案照常出**（沿用 8a1083f 阶梯策略：high 优先 → low 兜底，解析缺失不触发重试） |
| 后处理 | `sanitizeCopy` 补强：剥 markdown 符号（`*#\``）、emoji、code fence（MPT `format_response` 借鉴），违禁词过滤沿用 |

### 4.3 数据模型（并入 3.1 同一次迁移）

`ScriptDraft` 新增：

```prisma
angle       String?   // 切入角度（COPY_ANGLES 之一；旧数据为 null）
analysis  Json?      // { overview, principles, structure }；解析失败/旧数据为 null
```

`lib/types.ts` 的 `ScriptDraft` 接口、仓库 mappers、memory 实现同步。

### 4.4 解析展示 UI（`components/script-confirm.tsx`）

- 文案卡片下方加折叠区「查看创作解析」：默认收起，展开渲染 analysis 三段（概述/三大原则解析/四大结构解析）
- analysis 为 null（旧 draft/降级）时不渲染折叠区
- 加「换个表达方向」按钮（当前角度名作为按钮副文案，如「换个表达方向（当前：痛点暴击）」），点击触发重生成并替换卡片
- 参考图的「复制/编辑/取消重点」为既有能力，不动

## 5. 数据模型变更汇总（一次迁移）

| 模型 | 变更 |
|------|------|
| StoreProfile | +nickname String? / +ownerAge Int? / +yearsInBusiness Int? |
| ScriptDraft | +angle String? / +analysis Json? |

## 6. 调研借鉴映射

| 来源 | 借鉴点 | 落点 |
|------|--------|------|
| 参考图文案解析板块 | 三大原则四大结构本体 + 解析报告三段结构 | 规则文件章节 + analysis 字段 |
| svf 规则 1 | 反幻觉铁律 | 规则文件 |
| svf 规则 2-4 / MPT Constrains | 口语化条款 + 负面约束清单 | 规则文件 |
| MPT 三段式拼装 | 规则（system)/上下文（user)/素材 分层 | 沿用现状结构 |
| MPT loomloom candidateIndex | 差异化切入角度 | COPY_ANGLES + angle 参数 |
| MPT format_response / svf cleanGeneratedText | 后处理清洗 | sanitizeCopy 补强 |

（short-video-factory 为 AGPL-3.0：只借鉴 prompt 文案结构，不抄代码。）

## 7. 失败处理

| 场景 | 行为 |
|------|------|
| suggest AI 失败 | 502 + 前端提示重试或手填（沿用现状） |
| 候选池 exclude 超上限 | schema 400（≤40 条） |
| 文案生成 AI 失败 | 沿用现状：模板兜底 `createTemplateScriptDraft`（兜底稿无 analysis，angle= null） |
| 解析截断 | analysis=null 降级，文案照常（不触发重试） |
| angle 非法值 | schema 400 |
| 超上限填入 | 前端禁用+服务端 schema 校验双闸 |

## 8. 安全

- 门店档案新字段走 `sanitizePromptField` 进 prompt（注入防护沿用）
- suggest 候选池模式同样经 sanitize；exclude 条目截断 ≤30 字/条
- analysis 内容渲染时按纯文本处理（React 默认转义），不 dangerouslySetInnerHTML
- 端点均走 `getOwnerId()` + `applyRateLimit`（沿用）；suggest 为写桶

## 9. 测试策略（TDD）

1. store-suggest 候选池模式：field 分流、exclude 进 prompt、8 条上限截断、旧行为兼容（无 field）
2. schemas：新字段校验、上限校验、exclude 上限
3. 仓库层：新字段双实现（prisma+memory）读写
4. copywriting-rules：导出结构完整性（快照测试防误删章节）
5. script-engine：angle 进 prompt、analysis 解析（正常/截断 null/缺失）、sanitizeCopy 新清洗规则、人设句合成
6. script-drafts 路由：angle 参数校验与落库
7. UI：候选池填入/删除/重新生成/上限禁用；解析折叠渲染与 null 隐藏
8. 完工五件套：`npm test && npm run typecheck && npm run lint && npx prisma validate && npm run build`

## 10. 明确不做（YAGNI）

- 不做一次 3 版并排候选 UI（已拍板单版+换方向）
- 不做客群/活动/调性的候选池（手填即可）
- 不做规则文件的用户可编辑（MPT「预览/恢复默认」交互留给运营后期）
- 不做解析报告的二次生成/重试（截断即降级）
- 不做英文/多语言规则

## 11. 部署与验收

1. 一次 Prisma 迁移（4 个新列，全部可空——存量数据无感）
2. Zeabur 自动部署+自动迁移（沿用既有机制）
3. 验收路径：档案页填基础信息 → 两个候选池生成/填入/重新生成 → 保存 → 生成文案（默认角度）→ 换方向重生成（角度变化）→ 展开「查看创作解析」→ 确认生成出片
