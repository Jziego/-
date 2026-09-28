# 字幕逐词动效设计 —— 分段链路 ASS 逐词事件

- 日期：2026-09-28
- 状态：设计已敲定（四档全上 / 默认 pop / 只做分段模式），待实施
- 调研依据：字幕动效三项目调研（2026-09-23，ai-video-captions / KillerSubtitles / @remotion/captions）

---

## 1. 背景与目标

**现状**：分段链路字幕是「一段口播一条整句 cue」（`lib/services/segmented-compose.ts:111`），静态显示整段时长；三个预设（default/bold_bottom/minimal）全是静态样式，唯一「动效」是关键词静态变色（`wrapHighlightsInAss`）。

**目标**：字幕升级为逐词动效（当前词随配音节奏逐个变色/放大/弹跳/扫色），观感对齐短视频平台主流口播字幕（Hormozi 风格）。

**核心判断**（调研结论）：字级时间戳数据早已具备（`VoiceTrackSegment.words`，豆包/CosyVoice TTS 均已落库，段内相对秒），字幕链路从未消费——本次改造是把已有数据接到字幕上，ffmpeg/libass 渲染侧零改动。

**已拍板决策**（2026-09-28）：

| 决策点 | 结论 |
|--------|------|
| 默认动效 | **pop**（当前词放大跳变，Hormozi 风格） |
| 覆盖范围 | **只做分段链路**（talking_head/分段轮播）；整片旧路径保持整句静态不动 |
| 第一期档位 | **四档全上**：highlight / pop / bounce / karaoke |
| 停顿感知分页 | 不做，留待后续增强 |

## 2. 核心机制：逐词事件

「一句一条 Dialogue」升级为「**每词一条 Dialogue**」：

- 行分组：每行 ≤12 字（84px 字号下安全宽度）、最多 2 行，CJK 宽度比 1.05
- 一行 N 个词 → N 条 Dialogue；第 i 条文本 = 整行（`\N` 连接两行），但只有第 i 个词带动效 override tag，其余词为主色
- 第 i 条事件时间 = `[词i.start, 词i+1.start)`，末词延伸到行尾——**事件边界本身就是动画时钟**，不需要 `\t` 循环
- 全局时间 = 段内相对秒（words）+ 段起始偏移（段时长累计，现有 `buildSegmentedCaptionCues` 同款游标）

**回退**：无 words 的段（HeyGen 出镜段、旧 manifest、words 为空数组）走现有整句 cue 路径，行为逐字节不变。

## 3. 动效档位实现（ASS 层）

`AssStyleSpec` 新增字段 `animation: "none" | "highlight" | "pop" | "bounce" | "karaoke"`。

| 档位 | 当前词 tag | 说明 |
|------|-----------|------|
| highlight | `{\c<hl>&}词{\r}` | 纯变色，零重排零抖动 |
| pop | `{\fscx115\fscy115\c<hl>&}词{\r}` | 放大 115% 跳变；幅度 ≤120% 控制同行挤压不可感知 |
| bounce | `{\t(0,50,\fscx120\fscy120)\t(50,100,\fscx100\fscy100)\c<hl>&}词{\r}` | 100ms 两段过冲弹跳，一次播完不循环 |
| karaoke | `{\kf<词时长厘秒>}` | ASS 原生扫色：事件内按厘秒从 SecondaryColour 平滑扫成 PrimaryColour；**依赖 Style 行补 SecondaryColour 字段**（见 4.1 bug 修复） |

统一约定：动效 tag 后一律 `{\r}` 复位样式，防行间串色。

## 4. 改动点清单

### 4.1 顺手修复两个既有 bug（调研实锤，独立小 commit 先行）

1. **Style Format 行字段错位**（`video-compose.ts:325-326`）：Format 声明第 5 列为 `BackColour`，实际填的是 outlineColour；`OutlineColour`/`SecondaryColour` 未声明走 libass 默认——导致 minimal 预设的半透明描边失效、karaoke 无法正确扫色。修复：Format 行补全 `SecondaryColour, OutlineColour, BackColour` 三列并对齐 Style 行值。
2. **`assTimestamp` 厘秒进位**（`video-compose.ts:226`）：`Math.round((sec%1)*100)` 在 sec=x.999 时产出 `.100` 三位非法厘秒。修复：改 floor，厘秒=100 时进位到秒。

### 4.2 行分组与逐词事件生成（`segmented-compose.ts` 升级 + 新纯函数）

- 新类型 `WordCaptionEvent { startSec, endSec, lineText, wordIndex }`（wordIndex 为当前词在 lineText 分词序列中的下标）
- 新纯函数 `buildWordCaptionEvents(manifest)`：逐段消费 `seg.words` → 行分组 → 逐词事件；段无 words 时该段产出整句 cue（现有行为）
- 分词：words 元素即词（TTS 字级时间戳，单字/词由供应商决定，直接当原子单元）
- 行分组细节：按字数贪心累计，超 12 字换行；标点不置行首（行首为标点时并入上行）；超 2 行则继续分页（页 = 一个新事件组）

### 4.3 `buildAss` 升级（`video-compose.ts`）

- 入参扩展：接受整句 cue（现有）或逐词事件（新）——判别联合类型
- 逐词事件渲染：整行文本 + 当前词按档位包 tag；文本先经 `escapeAssText` 转义（`{` `}` `\` → 防 ASS tag 注入；AI 文案可能含花括号）
- emoji 清洗：libass 无法渲染彩色 emoji，字幕文本剔除 emoji 码位（口播稿本身已禁 emoji，此处为防御性兜底）
- karaoke 档：Style 行 SecondaryColour=未读色（半透明白灰），PrimaryColour=已读高亮色

### 4.4 预设与 schema

- 现有 default / bold_bottom / minimal 三预设**保持静态不动**（存量项目零影响）
- 新增 4 预设（样式族：84px bold、白字黑边、底部居中，差别在 animation 与高亮色）：
  - `pop`（**新项目默认**）：白字，当前词黄色放大
  - `highlight`：白字，当前词黄色
  - `bounce`：白字，当前词黄色弹跳
  - `karaoke`：未读半透明白，扫过变黄
- `SubtitleStylePreset` 联合类型、`resolveSubtitlePreset` 映射、`lib/schemas.ts` 的 zod enum（subtitleStyle）同步加值
- DB 字段 `RenderProject.subtitleStyle` 是 string，**无迁移**；存量项目样式不变
- 新项目默认：UI 创建渲染时默认选中 `pop`；`resolveSubtitlePreset(undefined)` 回退保持 `default`（旧数据语义不动）

### 4.5 接入点

- `worker/processors/video-render.ts` 分段路径：`buildSegmentedCaptionCues` 调用点替换为新 `buildWordCaptionEvents` 产物喂 `buildAss`
- 整片路径（`buildCaptionCues`）：**不动**

## 5. 测试策略（TDD）

1. bug 修复回归：`assTimestamp(0.999)` 不产生 `.100`；Style 行字段位与 Format 声明逐列对齐
2. 行分组器：中英文混排、超 12 字换行、标点行首并入、2 行分页、空 words 回退
3. 逐词事件时间轴：连续性（词 i 结束=词 i+1 开始）、段偏移正确、末词延伸到段尾
4. `buildAss` 四档位快照：tag 正确、`\r` 复位存在、escape 生效（输入含 `{}` `\` 不破坏 ASS 结构）、emoji 剔除
5. karaoke：Style 行含 SecondaryColour 且 `\kf` 值为词时长厘秒
6. 回退路径：无 words 段输出与改造前完全一致
7. 完工五件套：`npm test && npm run typecheck && npm run lint && npx prisma validate && npm run build`
8. 验收：worker 出一条分段片 → 抽帧 3~5 张确认逐词高亮/放大渲染正确（项目既有抽帧法）

## 6. 明确不做（YAGNI）

- 不做整片模式逐词（旧路径，不持久化 words，逐词只上分段链路）
- 不做停顿感知分页（页时长延伸到下页开始）——留待后续增强
- 不动 ffmpeg 命令/filter graph/Dockerfile（libass 能力全覆盖）
- 不做用户逐词自定义（词级颜色/字号编辑器）
- 不引入 Remotion 或 Python 栈
