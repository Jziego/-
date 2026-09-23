# 声音克隆接入设计 —— 阿里百炼 CosyVoice v3.5-plus

- 日期：2026-09-23
- 状态：设计已敲定（供应商经用户实测验收），待实施
- 关联：`docs/superpowers/plans/2026-09-16-volcengine-lipsync-provider.md`（对口型接入，本次为其上游声音来源改造）

---

## 1. 背景与目标

**现状缺陷**：对口型成片的口播声音是环境变量写死的豆包女声（`DOUBAO_TTS_VOICE=zh_female_vv_uranus_bigtts`，`lib/env.ts:152`）。用户上传的讲话视频只贡献了脸和嘴型，声音与本人无关——核心承诺「这个数字人就是你」不成立。

**目标**：用户上传底板讲话视频后，服务端自动从视频音轨克隆其声音；之后所有成片口播均为本人声音。

**已拍板决策**（2026-09-23 讨论记录）：

| 决策点 | 结论 |
|--------|------|
| 复刻等待期 UX | 复刻就绪前**不允许出片**（形象卡片显示「复刻中」）；实际等待为秒级~分钟级（ICL 无真实训练环节） |
| 供应商 | 阿里百炼 CosyVoice **v3.5-plus**（用户实测验收克隆质量通过） |
| 免费用户 | 克隆音色对全量用户自动启用（克隆免费，无垫资问题） |
| 授权勾选 | 暂缓，不加「本人声音已授权」UI |
| 样本来源 | 从底板视频抽音轨，用户无感，不要求单独录样本 |

## 2. 供应商选型结论（调研存档：两轮子代理调研 2026-09-23）

| 维度 | 火山豆包复刻 2.0 | **阿里 CosyVoice v3.5-plus（选定）** | MiniMax |
|------|----------------|--------------------------------------|---------|
| 克隆费 | 138 元/音色（首合成扣） | **免费** | 9.9 元/音色（首合成扣） |
| 合成费 | 3 元/万字符 | **1.5 元/万字符** | 2~3.5 元/万字符 |
| 字级时间戳 | ✅（秒） | ✅（毫秒，`sentence.words[].begin_time/end_time`） | 参数有但返回体实测无 |
| 开通门槛 | 已开通 | 个人实名即可 | 注册充值即用 |

硬约束：字幕链路（含规划的逐词动效）依赖 TTS 返回字级时间戳，不满足者一律出局（Qwen-TTS、讯飞、腾讯、MiniMax 均因此或未确认出局）。

**关键技术事实**（官方文档核实）：

- 复刻入口：voice-enrollment 接口（HTTP/SDK），样本要求 WAV(16bit)/MP3/M4A、10~20 秒（≤60s）、≤10MB、≥16kHz、≥5 秒连续清晰人声
- 合成：HTTP 请求加 `X-DashScope-SSE: enable` 头即流式返回（不必维护 WebSocket 长连），`word_timestamp_enabled` 开启字级时间戳，**复刻音色同样支持**
- 音色绑定 `target_model`，换模型必须重新克隆
- 配额：1000 音色/账号，**1 年未合成自动清理**
- v3.5 系列无系统音色（只能用复刻/设计音色）——与我们「只用克隆音色」场景匹配
- 免费额度：克隆免费（受 1000 配额约束）；合成每模型 1 万字符免费（90 天内，北京地域）

## 3. 总体流程

```
用户上传底板视频（现有流程不变）
  → [新] 服务端 ffmpeg 抽音轨（wav 24k mono，20s 样本）
  → [新] 调 voice-enrollment 注册克隆音色 → voice_id
  → [新] voice_id 落库 AvatarProfile.providerVoiceId（字段已存在，无迁移）
  → 形象状态 ready（复用现有状态机与卡片轮询展示）
  → [改] 出片时 TTS 走 CosyVoice（克隆音色），口型链路其余不动
```

对 HeyGen 路径零影响（其 providerVoiceId 本来就是 HeyGen voice id）。

## 4. 详细设计

### 4.1 样本提取（新文件 `lib/services/voice-sample.ts`）

```bash
ffmpeg -i footage.mp4 -vn -ac 1 -ar 24000 -ss 5 -t 20 sample.wav
```

- 跳过开头 5 秒（开场常有杂音/BGM 淡入），取 20 秒，落在官方推荐 10~20s 区间
- 底板短于 25s 时从头取（`-ss 0`），再短于 10s 直接报错「视频太短，请录制 15 秒以上的口播视频」
- 样本体积 ≈ 20s × 24kHz × 16bit × mono ≈ 960KB，远低于 10MB 上限
- **样本用完即弃**：临时文件渲染完即删，不落 R2、不留存（声纹属生物特征，最小化留存）

### 4.2 复刻触发（改造 `lib/services/providers/volcengine-lipsync.ts` 的 `createDigitalTwin`）

现状：`createDigitalTwin` 不调远端，返回本地句柄 `lipsync:{footageStorageKey}`，`getDigitalTwinStatus` 立即 ready。

改造：

1. `createDigitalTwin` 内联执行：抽音轨（4.1）→ 调 voice-enrollment → 拿 voice_id
   - 预期同步秒级返回（ICL 无训练环节，用户实测路径已验证）；若实测 >10s 或返回异步任务态，挪 BullMQ worker 异步执行——实施 Task 0 探针确定后定稿
2. voice_id 经由状态轮询链路落库：`getDigitalTwinStatus` 返回 `providerVoiceId: <voice_id>`，`applyDigitalTwinStatus`（`lib/services/avatar-provider.ts:181`）现有机制自动落库 `AvatarProfile.providerVoiceId`
3. 复刻失败（人声未检出/质量不达标等）→ `trainingStatus=failed` + 原因透出（引导重录），与现有 HeyGen 失败态展示一致

### 4.3 CosyVoice TTS 客户端（新文件 `lib/services/cosyvoice-tts.ts`）

与 `DoubaoTtsResult` 完全对齐的返回结构（`lib/services/doubao-tts.ts:30`）：

```ts
{ audioStorageKey, audioBytes, durationSeconds, words: WordTimestamp[] }
```

要点：

- HTTP POST DashScope 端点 + `X-DashScope-SSE: enable` 头，读全流组装（与豆包 chunked 客户端同构，`doubao-tts.ts` 为直接参照）
- 请求参数：`model=env COSYVOICE_MODEL`（默认 `cosyvoice-v3.5-plus`）、`voice=<克隆 voice_id>`、`word_timestamp_enabled=true`、mp3 输出
- **毫秒→秒换算**：`begin_time/1000` → `WordTimestamp.startSec`（豆包返回秒，阿里返回毫秒，字幕链路统一消费秒）
- 时长权威来源：ffprobe 实测音频（mp3 句首静音坑与豆包同款，沿用其防御逻辑）
- fail-fast：空音频、缺结束事件、错误事件（携带截断原始响应）一律抛错
- 依赖注入（fetchImpl/putObject/probe 等）与豆包客户端同款，便于单测

### 4.4 渲染链路切换（`volcengine-lipsync.ts` 默认 `synthesizeSpeechFn`）

```ts
function resolveSynthesizer(providerVoiceId?: string) {
  if (providerVoiceId) return cosyvoice;   // 克隆音色：主路径
  if (isDemoMode()) return doubaoFallback; // demo/dev 无 DASHSCOPE_API_KEY：豆包默认女声兜底
  throw new Error("形象声音未就绪");        // 生产 + 无克隆音色 = 数据异常，fail-fast
}
```

- 用户已拍板「复刻完才能出片」，正常流程渲染时必有 providerVoiceId
- **旧形象自愈迁移**：线上存量 lipsync 形象的 providerVoiceId 为空（历史未落库）。渲染时发现为空 → 用其 footage 即时补克隆 → 成功则落库继续渲染；失败则报错引导重新上传底板。旧形象无感迁移，不做数据迁移脚本

### 4.5 失效自愈

- 阿里规则：**1 年未合成音色自动清理**；克隆免费且次数不限（1000 配额内），重注册成本≈0
- 策略：渲染前**不**预查（省一次调用）；TTS 报「音色不存在」类错误时捕获 → 用 footage 重注册 → 新 voice_id 落库 → 重试一次。仍失败则按普通失败抛出
- 形象删除时调阿里删除接口释放配额（对齐既有 HeyGen 分身删除端点模式）

### 4.6 状态机与 UI

- `trainingStatus`：`pending → processing（声音复刻中）→ ready / failed`，复用现有状态机与卡片轮询（~10s 收敛）
- 卡片文案：processing 显示「声音复刻中…」（lipsync 路径此前秒变 ready，用户无感；现在是真异步但量级仍在秒~分钟）
- failed 原因透出 + 重录引导（复用 HeyGen 路径既有展示）

### 4.7 成本预估（`lib/cost-estimate.ts`）

- 克隆免费，无槽位费概念
- 对口型预估口径微调：MediaKit ¥1/分钟 + TTS 1.5 元/万字符（300 字文案 ≈ 0.05 元，展示上可并入「口播合成」项或忽略）

## 5. 数据模型与环境变量

**无数据库迁移**：复用 `AvatarProfile.providerVoiceId`（`prisma/schema.prisma:123`）。

新增环境变量（走 `lib/env.ts` 访问器，trim，不落日志）：

| 变量 | 用途 | 配置位置 |
|------|------|---------|
| `DASHSCOPE_API_KEY` | 百炼 API Key | Zeabur web + worker 双服务 |
| `COSYVOICE_MODEL` | 合成模型，默认 `cosyvoice-v3.5-plus` | 同上（可只配 worker，web 复刻调用也需要 Key） |

## 6. 失败处理矩阵

| 场景 | 行为 |
|------|------|
| 底板 <10s | 创建形象即报错「请录制 15 秒以上口播视频」 |
| 样本人声未检出/质量拒 | trainingStatus=failed + 原因 + 引导重录 |
| enrollment 超时/5xx | 状态 processing 保留，轮询重试；超窗口标 failed |
| 渲染时音色被清理（1 年规则） | 自动重注册 + 重试一次（4.5） |
| 无 DASHSCOPE_API_KEY（demo/dev） | 回退豆包默认女声，行为与现状一致 |
| 生产无 providerVoiceId 且无 footage | fail-fast「形象数据异常，请重新创建」 |

## 7. 安全与合规

- `DASHSCOPE_API_KEY` 走 env 访问器；不进日志、不序列化进任何 API 响应、不进 BullMQ job payload
- 声纹=个人生物特征：样本音频临时文件用完即删；落库仅 voice_id（opaque，不可还原音频）
- 无新增 prompt injection 面（voice_id 服务端生成，用户输入不进复刻/合成请求除文案文本本身——文案注入防护沿用 script-engine 既有约束）
- 授权勾选暂缓（用户拍板）；阿里服务协议的个人信息授权条款由产品侧后续统一收口

## 8. 测试策略（TDD）

1. `cosyvoice-tts.ts` 单测：SSE 帧解析、毫秒→秒换算、空音频/错误事件/缺结束事件抛错、时长 ffprobe 兜底（mock fetch + 注入 deps，参照 `tests/doubao-tts.test.ts` 结构）
2. 样本提取单测：ffmpeg 参数构造、短视频报错分支
3. provider 切换单测：有/无 providerVoiceId、demo 回退、生产 fail-fast
4. 状态机单测：processing→ready / failed 落库路径
5. 自愈单测：音色失效→重注册→重试→落库新 ID
6. 探针脚本固化 `scripts/probe-cosyvoice.mjs`：克隆→合成→校验字级时间戳存在且末词时间≈音频时长（参照 `scripts/probe-doubao-tts.mjs` 的校验套路）
7. 完工五件套：`npm test && npm run typecheck && npm run lint && npx prisma validate && npm run build`

## 9. 明确不做（YAGNI）

- 不做多供应商运行时切换矩阵（豆包仅保留 demo 回退；火山复刻 138 元/音色无保留价值）
- 不做授权勾选 UI（暂缓）
- 不做 flash/plus 用户可选档（env 固定 plus；降档即改 env + 重新克隆）
- 不做 MiniMax 备份渠道接入
- 不动 HeyGen 路径、不动现有豆包客户端（仅作 demo 回退保留）
- 不做「试听我的声音」预览功能（可后续加，复刻免费使成本可行）

## 10. 部署与验收

1. Zeabur web + worker 配置 `DASHSCOPE_API_KEY`（必）与 `COSYVOICE_MODEL`（可省，默认 plus）
2. 无数据库迁移；Zeabur 自动部署
3. 生产冒烟：新建形象上传底板 → 卡片「复刻中」→ 转 ready → 出一条片 → **肉耳确认口播是本人声音** → 确认字幕逐字对齐正常（字级时间戳链路）
4. 存量旧形象：渲染时自愈补克隆（4.4），无需人工干预
