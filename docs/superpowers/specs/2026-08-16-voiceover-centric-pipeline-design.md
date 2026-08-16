# 口播稿为中心的视频管线重构设计

日期：2026-08-16
状态：已确认（三期设计均已获用户批准）
关联：[2026-07-23-video-pipeline-overhaul-roadmap.md](./2026-07-23-video-pipeline-overhaul-roadmap.md)、[2026-07-23-storyboard-confirm-flow-design.md](./2026-07-23-storyboard-confirm-flow-design.md)

## 1. 背景

线上报告 3 个 bug，另有 6 项改进诉求。经代码探索，3 个 bug 根因均已坐实；6 项改进经逐条澄清后归纳为三期交付。本文档是唯一权威设计，替代旧分镜确认流设计中与之冲突的部分。

### 1.1 Bug 清单与根因

| Bug | 现象 | 根因 |
|---|---|---|
| B1 | 选 30s 却产出 6s/13s 视频 | `targetDurationSec` 只进 AI prompt，渲染管线不读取。成片时长 = 素材 ffprobe 实际时长 + presenter 镜时长，与 talking-head 音频取 min，只缩不放（`lib/services/video-compose.ts:60-164`）。模板兜底硬编码 3 镜 4s/7s/4s，不读档位（`lib/services/script-engine.ts:307-337`） |
| B2 | 勾选 5 个素材用不全 | 确认页把 `selectedAssetIds` 重算为「各镜 matchedAssetId 去重」（`components/storyboard-confirm.tsx:56`）。每镜只匹配 1 个素材、无标签重叠即配空，未命中素材被静默丢弃。worker 侧不丢素材 |
| B3 | 声音与字幕内容不符 | 字幕取自 `scene.text`（画面描述，模板原文「开场展示…门店或招牌」），口播音频取自 `draft.voiceover`——两者本就是不同内容。`draft.captions` 从未被渲染消费；PATCH 改 `scene.text` 从不动 `voiceover`，音字必然不一致 |

### 1.2 改进诉求与决策记录

| # | 诉求 | 决策 |
|---|---|---|
| 1 | 口型与音频对齐 | HeyGen 数字分身（digital_twin）路线，口型由 HeyGen 原生保证 |
| 2 | 用户上传人像视频对口型，素材库与人像分区 | Asset 加 `category` 区分；独立人像上传区；分段生成（出镜段分身视频 + 画外音段克隆声音 TTS） |
| 3 | 每个用户用自己的形象（现为全站共用 env 模板形象） | 走真 HeyGen 创建分身，`AvatarProfile.providerAvatarId` 为权威，删除 env 覆盖逻辑 |
| 4 | 时长档位 30/45/60，默认 45 | Phase 1 实施 |
| 5 | 去除分镜脚本环节，整段口播稿 + 自动标黄 + 确认后选形象 | Phase 2 实施；整段口播稿确认（非分段） |
| 6 | AI 剪辑（HyperFrames 类） | 不进本文档，单独立项调研 |

**多形象语义**：单条视频内多个形象轮播（非多选一生成多条）。

## 2. HeyGen API 调研结论

来源：[developers.heygen.com](https://developers.heygen.com/docs/create-avatar)（2026-08-16 查询）

- **创建数字分身**：`POST /v3/avatars`，`type: "digital_twin"`，`file` 接受视频 URL/asset ID/base64。声音随分身一起克隆
- **授权（consent）强制**：数字分身必须完成授权才可生成视频。默认 webcam 流程：调 `POST /v3/avatars/{group_id}/consent` 得授权链接（24h 有效），用户点开对摄像头念授权词。预录授权视频仅企业白名单可用。photo avatar 无需授权但质量低，不采用
- **生成视频**：`POST /v3/videos`，`avatar_id + voice_id + script`
- **纯音频 TTS**：`POST /v3/voices/speech`，支持克隆声音，返回 `audio_url`、`duration`、**`word_timestamps`（词级时间轴）**——字幕精准对齐与标黄高亮依赖此能力
- **定价**：数字分身视频（Avatar IV/V）$0.0667/秒；TTS（Starfish）0.000333 credits/秒（约为视频的 1/200）；创建分身 1 credit/次（一次性）

### 成本模型（分段生成）

口播拆为**出镜段**（数字分身视频，$0.0667/s）与**画外音段**（克隆声音 TTS + 素材 b-roll，≈$0.0003/s）。按出镜约 40% 估算：

| 时长档 | 全程数字人（现状） | 分段生成（目标） |
|---|---|---|
| 30s | ~$2.0 | ~$0.8 |
| 45s | ~$3.0 | ~$1.2 |
| 60s | ~$4.0 | ~$1.6 |

## 3. 总体架构决策

**口播稿为中心的数据模型。** `ScriptDraft` 以「整段口播稿 + 标黄词 + 按句分段」为中心；`scenes` 降级为渲染内部概念，由口播分段与素材池在服务端派生，UI 不再暴露逐镜编辑。三个 bug 的根治都建立在此地基上：字幕 = 口播分段（根治 B3），素材 = 用户勾选全量进时间线（根治 B2），时长 = 时间线按目标档位归一化铺满（根治 B1）。

## 4. Phase 1：bug 修复 + 时长档位（1–2 天，可独立上线）

### 4.1 时长归一化（B1）

- `ScriptDraft` 落库 `targetDurationSec`；创建渲染项目时继承到 `RenderProject`，随 job payload 传 worker
- `buildTimeline` 新增 `targetDurationSec` 入参：
  - b-roll 段铺满「目标时长 − presenter 总时长」；素材不足时**循环复用**（单段 cap 12s 不变，图片展示时长弹性拉长）
  - asset_only 降级模式同样铺满目标时长
  - ffmpeg `-t` 兜底对齐
  - 口播音频超目标时长时成片以口播为准（口播不可截断），靠脚本字数控制在生成端事前规避
- 模板兜底按档位生成镜数与文案字数（中文口播约 4.5 字/秒：30s≈135 字、45s≈200 字、60s≈270 字），废除硬编码 4s/7s/4s
- AI 路径校验：返回总时长偏离档位 >50% 时打警告日志（不重试）

### 4.2 素材全量（B2）

- `StoryboardConfirm` 确认时 `selectedAssetIds` 直接取素材库完整勾选集合（prop 传入），不再按 matchedAssetId 重算；matchedAssetId 降级为展示提示

### 4.3 字幕=口播（B3）

- presenter 模式字幕池改从 `voiceover` 派生：按句切分（。！？），按字数加权分摊到口播总时长生成 ASS cues，全程跟随配音
- `scene.text`（画面描述）彻底退出字幕数据源；asset_only 模式（无口播音频）不生成字幕——把画面描述烧录在画面上本就是 B3 的一部分，一并去除

### 4.4 时长档位 UI

- 选项 15/30/60 → **30/45/60，默认 45**

### 4.5 测试

- buildTimeline 归一化（素材 10s 铺满 30s；循环复用；asset_only 铺满）
- voiceover 切句字幕（句数、时长分摊总和 = 口播时长）
- 确认页全量素材传递
- 档位默认值 45

## 5. Phase 2：脚本确认流重构（去分镜）

### 5.1 数据模型（`ScriptDraft` 扩展）

- `voiceover`：整段口播稿纯文本（复用现有字段，用户编辑的唯一对象）
- `highlights: string[]`（新增）：标黄关键词，AI 产出（产品名/价格/活动/CTA）。用户改稿后文中不存在的词渲染时自动失效
- `segments: [{ index, text, speakerIndex, onCamera }]`（新增）：按句分段。本期全部 `speakerIndex=0`；`onCamera` 本期由 AI 产出但渲染忽略，为 Phase 3 预留
- `targetDurationSec` 落库（Phase 1 已加）

### 5.2 API

- `POST /api/script-drafts`：返回 draft 含 voiceover + highlights + segments
- `PATCH /api/script-drafts/:id`：编辑对象从逐镜 `scene.text` 改为 **voiceover 全文**；保存后服务端重切 segments、过滤失效标黄词
- `POST /api/render-projects`：入参加 `avatarProfileIds[]`（本期单选，长度 1）

### 5.3 UI

智能成片 section 内嵌两步，分镜脚本 section 与 `StoryboardConfirm` 组件删除：

1. 目的 + 时长档（30/45/60 默认 45）→「生成脚本」
2. 确认卡片：口播稿**标黄高亮预览** + 可编辑 + 形象选择（本期单选）+ 字幕样式 + BGM（自 StoryboardConfirm 挪入）→「确认生成」

服务端从 segments + 勾选素材**派生内部 scenes**（presenter 段按 segments，b-roll 段按素材交错）喂给现有渲染管线，管线不动。

### 5.4 字幕与标黄

- `buildCaptionCues(voiceover, highlights)` → ASS，标黄词包 `{\c&H00FFFF&}`
- 本期按字数加权估算对齐；Phase 3 接 TTS word_timestamps 后升级精准对齐

### 5.5 测试

- AI/模板双路径产出 highlights + segments
- PATCH：voiceover 编辑后 segments 重切、失效标黄词过滤
- scenes 派生逻辑
- UI 两步流组件测试

## 6. Phase 3：用户形象 + 多形象轮播 + 分段生成

### 6.1 素材模型与上传区

- `Asset` 加 `category: "material" | "avatar_footage"`（Prisma 自由 String，无需 enum migration；memory repo 同步）
- 素材库只显示 `material`；「AI 分身」section 改造为人像上传区：上传自己讲话的视频（复用 upload-intent，`category=avatar_footage`），UI 提示拍摄要求（30s–5min、正脸、光线充足、人声清晰）

### 6.2 形象创建流程（`POST /api/avatars` 重写，走真 provider）

1. 上传人像视频完成 → `POST /api/avatars { footageAssetId, name }`
2. 服务端生成 presigned GET URL → HeyGen `POST /v3/avatars`（digital_twin）→ 得 `group_id`
3. 调 consent 接口取 webcam 授权链接 → 返回前端，用户新窗口完成授权
4. `AvatarProfile` 扩展：`providerGroupId`、`consentStatus`、`trainingVideoAssetId`；轮询 → 授权通过且训练完成 → `ready`，写入 `providerAvatarId`（look_id）与 `providerVoiceId`（克隆声音）
5. 授权链接 24h 过期 / 审核被拒 → failed，UI 可重新发起

### 6.3 多租户形象权威化

- 删除 env 模板覆盖逻辑（`lib/services/providers/heygen.ts:208-219`），`AvatarProfile.providerAvatarId` 为权威
- env 模板降级为「平台公共形象」：形象列表中的兜底项（demo 模式 + 未创建个人形象的用户）

### 6.4 多形象轮播与分段生成

- 形象选择升级为多选；AI prompt 告知各形象名字/人设，segments 产出带 `speakerIndex` 与 `onCamera`
- 渲染任务：每个形象的出镜段 → HeyGen 视频（音视频一体）；画外音段 → 该形象克隆声音 TTS（取 word_timestamps）
- `video-compose` 时间线：onCamera 段放对应形象 talking-head 画面，画外音段放 b-roll + TTS 音频；字幕按 word_timestamps 精准对齐 + 标黄
- 配额：暂维持 1 次生成 = 1 配额；确认卡片显示预估成本。创建分身 1 credit/次（一次性）

### 6.5 错误处理

- consent 过期可重发；训练失败展示原因；TTS 失败重试后降级为该段数字人视频生成

### 6.6 测试

- provider mock 扩展（createDigitalTwin/consent/status/tts）；双 repo 同步
- 多形象 scenes 派生；时间线混排；consent 状态机

## 7. 横切

### 安全

- 沿用 `getOwnerId()` 与既有 middleware，新路由不发明 ad-hoc auth
- presigned URL 短过期；consent URL 只返回给属主本人
- 人像视频属敏感个人信息：storageKey UUID 化，不生成公开 URL
- HeyGen 交互不记录 API key；job payload 不放凭据

### 范围外

- 改进 6（AI 剪辑 / HyperFrames / Remotion）：单独立项调研后决策
- quota 计费体系重做（按秒/按成本计）：用户量上来后单独立项
- 安全 backlog 两项（file-magic fail-open、avatars err.message 泄漏）：维持原 backlog

### 风险与开放问题

1. HeyGen 订阅档位是否开放 digital_twin 创建 API——Phase 3 实施前用真 key 冒烟验证
2. Starfish TTS 对中文克隆声音的质量——Phase 3 实施时小样验证
3. 中文 4.5 字/秒语速假设——Phase 1 上线后按实测校准
4. word_timestamps 对中文的粒度（按字/按词）——Phase 3 实施时验证，必要时按字处理
