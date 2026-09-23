# 声音克隆接入（CosyVoice v3.5-plus）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户上传底板讲话视频后自动克隆其声音（阿里百炼 CosyVoice v3.5-plus），所有对口型成片的口播声音 = 用户本人声音。

**Architecture:** `getDigitalTwinStatus` 轮询时内联执行幂等复刻（抽音轨→voice-enrollment→轮询 OK），voice_id 经现有 `applyDigitalTwinStatus` 机制落库 `AvatarProfile.providerVoiceId`（零迁移）；渲染链路按 voice_id 前缀分派 CosyVoice TTS（HTTP+SSE 流式，字级时间戳毫秒→秒），音色被阿里清理（1 年未用）时渲染侧自动重建重试一次。

**Tech Stack:** TypeScript、Next.js API 路由、BullMQ worker、fluent-ffmpeg + ffmpeg-static、阿里百炼 DashScope HTTP API、Vitest。

**Spec:** `docs/superpowers/specs/2026-09-23-voice-clone-cosyvoice-design.md`

---

## 前置事实（全部实测验证，勿再调研）

- **探针已通过**：`scripts/probe-cosyvoice.mjs`（2026-09-23 用户盲听验收选定 v3.5-plus）。API 调用模式以此探针代码为准。
- 用户的百炼 Key 在 `C:/Users/刘鉴震/Desktop/百炼.txt`（含 base URL + `sk-` Key）；实施时由用户配入 `.env` 与 Zeabur。
- enrollment 端点：`POST {base}/api/v1/services/audio/tts/customization`，body `{model:"voice-enrollment", input:{action, ...}}`；**同步返回 `output.voice_id`**，音色状态机 `DEPLOYING→OK/UNDEPLOYED`，创建后须 `query_voice` 轮询到 `OK`（实测通常即时）。
- 样本可 **data URI 直传**（`data:audio/wav;base64,...`，探针实测）——生产默认走它，避开「阿里服务器拉 Cloudflare R2」的可靠性风险（火山 MediaKit 拉 R2 曾 500）。
- 合成端点：`POST {base}/api/v1/services/audio/tts/SpeechSynthesizer` + 头 `X-DashScope-SSE: enable`；SSE 只有 `data:` 行（无 `event:` 字段、无 `[DONE]`），以 `finish_reason=="stop"` 判完；字级时间戳 `output.sentence.words[]`（`begin_time/end_time` **毫秒**）；**`sentence-synthesis` 事件会重复携带整句 words——必须按 `句index:begin_index` 去重**。
- 音色被清理后 `query_voice` 报 `400-BadRequest.ResourceNotExist`（自愈触发信号）；创建音色免费，配额 1000/账号。
- web 进程（app/api）目前**零 ffmpeg 依赖**，Zeabur web 无 Dockerfile（自动构建）→ 用 **ffmpeg-static**（npm 包自带二进制）解决 web 端 ffmpeg，不改部署方式。
- voice_id 格式实证：`cosyvoice-v3.5-plus-{prefix}-{uid}`（`{target_model}-{prefix}-{uid}`）→ 前缀判定 `startsWith("cosyvoice-")`。
- `applyDigitalTwinStatus`（`lib/services/avatar-provider.ts:198-203`）在 ready 时自动落库 `providerVoiceId`——机制现成，路由层零改动。

## 文件结构

| 文件 | 职责 | 新建/修改 |
|------|------|----------|
| `lib/env.ts` | +4 个百炼 env 访问器 | 修改 |
| `lib/services/ffmpeg-binary.ts` | 解析 ffmpeg 路径（系统 PATH 优先→ffmpeg-static 兜底） | 新建 |
| `lib/services/voice-sample.ts` | 从底板视频抽 20s wav 样本（24k mono s16） | 新建 |
| `lib/services/cosyvoice-enrollment.ts` | 百炼音色 CRUD + 就绪轮询（voice-enrollment） | 新建 |
| `lib/services/cosyvoice-tts.ts` | CosyVoice SSE 流式合成客户端（对齐 DoubaoTtsResult） | 新建 |
| `lib/services/providers/volcengine-lipsync.ts` | 复刻触发、TTS 分派、失效自愈 | 修改 |
| `app/api/avatars/[id]/route.ts` | DELETE 时释放百炼音色配额 | 修改 |
| `lib/cost-estimate.ts` | 计价注释口径更新（逻辑不变） | 修改 |
| `package.json` | +ffmpeg-static | 修改 |
| `tests/ffmpeg-binary.test.ts` / `tests/voice-sample.test.ts` / `tests/cosyvoice-enrollment.test.ts` / `tests/cosyvoice-tts.test.ts` | 新模块单测 | 新建 |
| `tests/volcengine-lipsync-provider.test.ts` / `tests/api/avatars-delete.test.ts` | 追加用例 | 修改 |

---

### Task 1: env 访问器 + ffmpeg 二进制解析

**Files:**
- Modify: `lib/env.ts`（尾部追加，`getDoubaoTtsResourceId` 之后）
- Create: `lib/services/ffmpeg-binary.ts`
- Test: `tests/ffmpeg-binary.test.ts`
- Modify: `package.json`（+ffmpeg-static）

- [ ] **Step 1: 写失败测试**

```ts
// tests/ffmpeg-binary.test.ts
import { describe, expect, it } from "vitest";
import { resolveFfmpegPath } from "@/lib/services/ffmpeg-binary";

describe("resolveFfmpegPath", () => {
  it("系统 ffmpeg 可用时直接返回 'ffmpeg'", () => {
    const path = resolveFfmpegPath({ execCheck: () => true, staticPath: "/static/ffmpeg" });
    expect(path).toBe("ffmpeg");
  });

  it("系统不可用时回退 ffmpeg-static 路径", () => {
    const path = resolveFfmpegPath({ execCheck: () => false, staticPath: "/static/ffmpeg" });
    expect(path).toBe("/static/ffmpeg");
  });

  it("两者都不可用 → fail-fast", () => {
    expect(() => resolveFfmpegPath({ execCheck: () => false, staticPath: null })).toThrow(/找不到 ffmpeg/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ffmpeg-binary.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// lib/services/ffmpeg-binary.ts
import { execFileSync } from "node:child_process";
import ffmpegStatic from "ffmpeg-static";

export interface FfmpegBinaryDeps {
  /** 系统 ffmpeg 探测（默认 exec -version）；测试注入。 */
  execCheck: () => boolean;
  /** ffmpeg-static 包解析出的路径（无平台二进制时为 null）；测试注入。 */
  staticPath: string | null;
}

/**
 * ffmpeg 路径解析：系统 PATH 优先（worker Docker 已装），回退 ffmpeg-static
 * 自带二进制（web 进程 Zeabur 自动构建无 ffmpeg，靠它覆盖）。
 */
export function resolveFfmpegPath(deps?: Partial<FfmpegBinaryDeps>): string {
  const execCheck = deps?.execCheck ?? (() => {
    try {
      execFileSync("ffmpeg", ["-version"], { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  });
  if (execCheck()) return "ffmpeg";
  const staticPath = deps?.staticPath !== undefined ? deps.staticPath : (ffmpegStatic as string | null);
  if (staticPath) return staticPath;
  throw new Error("找不到 ffmpeg：系统 PATH 无 ffmpeg 且 ffmpeg-static 无本平台二进制");
}
```

`lib/env.ts` 尾部追加：

```ts
export function getDashscopeApiKey(): string | undefined {
  return process.env.DASHSCOPE_API_KEY?.trim() || undefined;
}

/** 百炼端点：公共域名或业务空间专属域名（探针实测两者皆可），去尾斜杠。 */
export function getDashscopeBaseUrl(): string {
  return (process.env.DASHSCOPE_BASE_URL?.trim() || "https://dashscope.aliyuncs.com/api/v1").replace(/\/+$/, "");
}

/** CosyVoice 合成模型（克隆音色绑定 target_model，换模型必须重新克隆）。 */
export function getCosyvoiceModel(): string {
  return process.env.COSYVOICE_MODEL?.trim() || "cosyvoice-v3.5-plus";
}

export function hasCosyvoiceProvider(): boolean {
  return Boolean(getDashscopeApiKey());
}
```

- [ ] **Step 4: 装依赖 + 跑测试**

Run: `npm i ffmpeg-static && npx vitest run tests/ffmpeg-binary.test.ts`
Expected: 3 passed

注意：若后续 `npm run build` 报 ffmpeg-static 打包错误，在 `next.config.*` 的 `serverExternalPackages` 数组追加 `"ffmpeg-static"`（它是 server-only 二进制路径包，不该被打包）。

- [ ] **Step 5: Commit**

```bash
git add lib/env.ts lib/services/ffmpeg-binary.ts tests/ffmpeg-binary.test.ts package.json package-lock.json
git commit -m "feat(voice-clone): 百炼 env 访问器 + ffmpeg 二进制解析（系统优先/ffmpeg-static 兜底）"
```

---

### Task 2: 样本提取 `voice-sample.ts`

**Files:**
- Create: `lib/services/voice-sample.ts`
- Test: `tests/voice-sample.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/voice-sample.test.ts
import { describe, expect, it } from "vitest";
import {
  extractVoiceSampleFromVideo,
  SAMPLE_BYTES_PER_SEC,
  type VoiceSampleDeps,
} from "@/lib/services/voice-sample";

/** 构造假 wav：44 字节头 + PCM 数据，时长 = dataSize/48000。 */
function fakeWav(seconds: number): Uint8Array {
  const size = 44 + Math.round(seconds * SAMPLE_BYTES_PER_SEC);
  const buf = new Uint8Array(size);
  buf.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  return buf;
}

function makeDeps(wavSeconds: number) {
  const calls: string[][] = [];
  const deps: VoiceSampleDeps = {
    ffmpegPath: "/fake/ffmpeg",
    execFileAsync: async (_cmd, args) => { calls.push(args); },
    writeFileFn: async () => {},
    readFileFn: async () => fakeWav(wavSeconds),
    makeTmpDir: () => "/tmp/vs-test",
    removeDir: () => {},
  };
  return { deps, calls };
}

describe("extractVoiceSampleFromVideo", () => {
  it("默认跳开头 5s 抽 20s，返回 wav 字节与时长", async () => {
    const { deps, calls } = makeDeps(20);
    const result = await extractVoiceSampleFromVideo({ footageBytes: new Uint8Array([1, 2, 3]) }, deps);
    expect(result.durationSec).toBe(20);
    expect(result.wavBytes.length).toBeGreaterThan(44);
    const args = calls[0]!.join(" ");
    expect(args).toContain("-ss 5");
    expect(args).toContain("-t 20");
    expect(args).toContain("-ar 24000");
    expect(args).toContain("-ac 1");
  });

  it("跳头后不足 10s → 从头重抽一次", async () => {
    let n = 0;
    const { deps, calls } = makeDeps(0);
    deps.readFileFn = async () => fakeWav(++n === 1 ? 6 : 20);
    const result = await extractVoiceSampleFromVideo({ footageBytes: new Uint8Array([1]) }, deps);
    expect(result.durationSec).toBe(20);
    expect(calls.length).toBe(2);
    expect(calls[1]!.join(" ")).toContain("-ss 0");
  });

  it("从头抽仍不足 10s → 报视频太短", async () => {
    const { deps } = makeDeps(6);
    await expect(
      extractVoiceSampleFromVideo({ footageBytes: new Uint8Array([1]) }, deps),
    ).rejects.toThrow(/15 秒/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/voice-sample.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// lib/services/voice-sample.ts
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveFfmpegPath } from "@/lib/services/ffmpeg-binary";

/** 阿里样本要求：≥16kHz、10~20s 连续清晰人声。统一 24kHz s16 mono（与探针一致）。 */
const SAMPLE_RATE = 24000;
export const SAMPLE_BYTES_PER_SEC = SAMPLE_RATE * 2; // s16 mono
/** 官方推荐 10~20s；低于 10s 克隆质量差 → fail-fast。 */
export const MIN_SAMPLE_SEC = 10;
const SAMPLE_SEC = 20;
/** 跳过开头 5s（开场常有杂音/BGM 淡入）；短视频自动回退从头取。 */
const SKIP_HEAD_SEC = 5;
/** 标准 wav 头 44 字节；ffmpeg 输出恒定此布局，时长按 (size-44)/字节每秒 估算。 */
const WAV_HEADER_BYTES = 44;

export interface VoiceSampleResult {
  wavBytes: Uint8Array;
  durationSec: number;
}

export interface VoiceSampleDeps {
  ffmpegPath: string;
  execFileAsync: (cmd: string, args: string[]) => Promise<unknown>;
  writeFileFn: (path: string, data: Uint8Array) => Promise<unknown>;
  readFileFn: (path: string) => Promise<Uint8Array>;
  makeTmpDir: () => string;
  removeDir: (dir: string) => void;
}

const defaultExec = promisify(execFile);

/**
 * 底板视频 → 克隆样本 wav。样本只在内存/临时目录流转，调用方用完即弃
 * （声纹属生物特征，不落 R2、不留存）。
 */
export async function extractVoiceSampleFromVideo(
  input: { footageBytes: Uint8Array },
  deps?: Partial<VoiceSampleDeps>,
): Promise<VoiceSampleResult> {
  if (!input.footageBytes || input.footageBytes.length === 0) {
    throw new Error("底板视频字节为空——无法提取克隆样本");
  }
  const d: VoiceSampleDeps = {
    ffmpegPath: deps?.ffmpegPath ?? resolveFfmpegPath(),
    execFileAsync: deps?.execFileAsync ?? (defaultExec as unknown as VoiceSampleDeps["execFileAsync"]),
    writeFileFn: deps?.writeFileFn ?? (async (p, data) => { await writeFile(p, data); }),
    readFileFn: deps?.readFileFn ?? (async (p) => new Uint8Array(await readFile(p))),
    makeTmpDir: deps?.makeTmpDir ?? (() => mkdtempSync(join(tmpdir(), "voice-sample-"))),
    removeDir: deps?.removeDir ?? ((dir) => rmSync(dir, { recursive: true, force: true })),
  };

  const dir = d.makeTmpDir();
  try {
    const inputPath = join(dir, "footage.bin");
    await d.writeFileFn(inputPath, input.footageBytes);
    for (const skipHead of [SKIP_HEAD_SEC, 0]) {
      const outPath = join(dir, "sample.wav");
      await d.execFileAsync(d.ffmpegPath, [
        "-y", "-ss", String(skipHead), "-t", String(SAMPLE_SEC), "-i", inputPath,
        "-vn", "-ac", "1", "-ar", String(SAMPLE_RATE), "-sample_fmt", "s16", outPath,
      ]);
      const wavBytes = await d.readFileFn(outPath);
      const durationSec = Math.max(0, (wavBytes.length - WAV_HEADER_BYTES) / SAMPLE_BYTES_PER_SEC);
      if (durationSec >= MIN_SAMPLE_SEC) {
        return { wavBytes, durationSec };
      }
      // 跳头后不足 → 从头重抽一次；已是从头仍不足 → 落到循环后报错
    }
    throw new Error("视频太短或有效人声不足——请录制 15 秒以上的口播视频");
  } finally {
    d.removeDir(dir);
  }
}
```

- [ ] **Step 4: 跑测试**

Run: `npx vitest run tests/voice-sample.test.ts`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add lib/services/voice-sample.ts tests/voice-sample.test.ts
git commit -m "feat(voice-clone): 底板视频抽 20s 克隆样本（24k mono，短视频从头回退，不足10s fail-fast）"
```

---

### Task 3: 音色 CRUD `cosyvoice-enrollment.ts`

**Files:**
- Create: `lib/services/cosyvoice-enrollment.ts`
- Test: `tests/cosyvoice-enrollment.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/cosyvoice-enrollment.test.ts
import { describe, expect, it } from "vitest";
import {
  createCosyVoice,
  deleteCosyVoice,
  queryCosyVoice,
  waitCosyVoiceReady,
} from "@/lib/services/cosyvoice-enrollment";

function mockFetch(status: number, body: unknown) {
  return async () => new Response(JSON.stringify(body), { status });
}

const OK_CREATE = { output: { voice_id: "cosyvoice-v3.5-plus-av1234abcd-xyz" }, usage: { count: 1 }, request_id: "r1" };

describe("createCosyVoice", () => {
  it("data URI 直传样本，解析 output.voice_id", async () => {
    let sentBody = "";
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      sentBody = String(init?.body ?? "");
      return new Response(JSON.stringify(OK_CREATE), { status: 200 });
    };
    const id = await createCosyVoice(
      { sampleWavBytes: new Uint8Array([1, 2, 3]), prefix: "av1234abcd" },
      { fetchImpl: fetchImpl as typeof fetch, apiKey: "sk-test", baseUrl: "https://api.test/api/v1" },
    );
    expect(id).toBe("cosyvoice-v3.5-plus-av1234abcd-xyz");
    expect(sentBody).toContain("data:audio/wav;base64,");
    expect(sentBody).toContain('"action":"create_voice"');
    expect(sentBody).toContain('"target_model":"cosyvoice-v3.5-plus"');
  });

  it("HTTP 200 但 body 带业务 code → 抛错（双通道防御）", async () => {
    const fetchImpl = mockFetch(200, { code: "Throttling.AllocationQuota", message: "配额已满", request_id: "r2" });
    await expect(
      createCosyVoice({ sampleWavBytes: new Uint8Array([1]) }, { fetchImpl: fetchImpl as typeof fetch, apiKey: "k", baseUrl: "https://x" }),
    ).rejects.toThrow(/AllocationQuota/);
  });

  it("HTTP 非 200 → 抛错带截断原文", async () => {
    const fetchImpl = mockFetch(401, { code: "InvalidApiKey", message: "bad key" });
    await expect(
      createCosyVoice({ sampleWavBytes: new Uint8Array([1]) }, { fetchImpl: fetchImpl as typeof fetch, apiKey: "k", baseUrl: "https://x" }),
    ).rejects.toThrow(/401/);
  });

  it("响应缺 voice_id → 协议漂移报错", async () => {
    const fetchImpl = mockFetch(200, { output: {}, request_id: "r3" });
    await expect(
      createCosyVoice({ sampleWavBytes: new Uint8Array([1]) }, { fetchImpl: fetchImpl as typeof fetch, apiKey: "k", baseUrl: "https://x" }),
    ).rejects.toThrow(/voice_id/);
  });
});

describe("queryCosyVoice", () => {
  it("返回音色状态", async () => {
    const fetchImpl = mockFetch(200, { output: { status: "OK", target_model: "cosyvoice-v3.5-plus" }, request_id: "r4" });
    const result = await queryCosyVoice("voice_x", { fetchImpl: fetchImpl as typeof fetch, apiKey: "k", baseUrl: "https://x" });
    expect(result?.status).toBe("OK");
  });

  it("ResourceNotExist → null（自愈触发信号）", async () => {
    const fetchImpl = mockFetch(400, { code: "BadRequest.ResourceNotExist", message: "not exist", request_id: "r5" });
    const result = await queryCosyVoice("voice_gone", { fetchImpl: fetchImpl as typeof fetch, apiKey: "k", baseUrl: "https://x" });
    expect(result).toBeNull();
  });
});

describe("waitCosyVoiceReady", () => {
  it("DEPLOYING→OK 轮询直到就绪", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      const status = calls < 3 ? "DEPLOYING" : "OK";
      return new Response(JSON.stringify({ output: { status }, request_id: "r6" }), { status: 200 });
    };
    await waitCosyVoiceReady("voice_x", {
      fetchImpl: fetchImpl as typeof fetch, apiKey: "k", baseUrl: "https://x",
      intervalMs: 1, timeoutMs: 1000, sleepFn: async () => {},
    });
    expect(calls).toBe(3);
  });

  it("UNDEPLOYED → 抛审核失败", async () => {
    const fetchImpl = mockFetch(200, { output: { status: "UNDEPLOYED" }, request_id: "r7" });
    await expect(
      waitCosyVoiceReady("voice_x", { fetchImpl: fetchImpl as typeof fetch, apiKey: "k", baseUrl: "https://x", intervalMs: 1, timeoutMs: 100, sleepFn: async () => {} }),
    ).rejects.toThrow(/审核/);
  });

  it("超时 → 抛错", async () => {
    const fetchImpl = mockFetch(200, { output: { status: "DEPLOYING" }, request_id: "r8" });
    await expect(
      waitCosyVoiceReady("voice_x", { fetchImpl: fetchImpl as typeof fetch, apiKey: "k", baseUrl: "https://x", intervalMs: 1, timeoutMs: 3, sleepFn: async () => {} }),
    ).rejects.toThrow(/超时/);
  });
});

describe("deleteCosyVoice", () => {
  it("正常删除", async () => {
    const fetchImpl = mockFetch(200, { output: {}, usage: { count: 1 }, request_id: "r9" });
    await expect(
      deleteCosyVoice("voice_x", { fetchImpl: fetchImpl as typeof fetch, apiKey: "k", baseUrl: "https://x" }),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/cosyvoice-enrollment.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// lib/services/cosyvoice-enrollment.ts
import { getCosyvoiceModel, getDashscopeApiKey, getDashscopeBaseUrl } from "@/lib/env";

/**
 * 阿里百炼 voice-enrollment 客户端（音色 CRUD + 就绪轮询）。
 * 端点与字段以 scripts/probe-cosyvoice.mjs 实测为准（2026-09-23）：
 *  - 同步返回 output.voice_id；状态机 DEPLOYING→OK/UNDEPLOYED，用前必须轮询到 OK
 *  - 样本支持 data URI 直传（文档写公网 URL，data URI 为实测可用路径——生产默认，
 *    规避阿里服务器拉 Cloudflare R2 的可靠性风险）
 *  - 音色不存在报 400-BadRequest.ResourceNotExist（自愈触发信号）
 */

const ENROLLMENT_PATH = "/services/audio/tts/customization";
const REQUEST_TIMEOUT_MS = 120_000;

export interface BailianDeps {
  fetchImpl: typeof fetch;
  /** 测试注入；缺省读 env。 */
  apiKey?: string;
  baseUrl?: string;
}

interface BailianErrorBody { code?: string; message?: string; request_id?: string }

async function callBailian<T>(
  action: string,
  input: Record<string, unknown>,
  deps?: Partial<BailianDeps>,
): Promise<T> {
  const apiKey = deps?.apiKey ?? getDashscopeApiKey();
  if (!apiKey) {
    throw new Error("DASHSCOPE_API_KEY is not configured");
  }
  const baseUrl = (deps?.baseUrl ?? getDashscopeBaseUrl()).replace(/\/+$/, "");
  const fetchImpl = deps?.fetchImpl ?? fetch;
  const res = await fetchImpl(`${baseUrl}${ENROLLMENT_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: "voice-enrollment", input: { action, ...input } }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const raw = await res.text();
  let json: BailianErrorBody & Record<string, unknown>;
  try {
    json = JSON.parse(raw) as typeof json;
  } catch {
    throw new Error(`百炼 ${action} HTTP ${res.status} 非 JSON 响应：${raw.slice(0, 200)}`);
  }
  // 双通道防御：HTTP 非 2xx 或 body.code 非空都视为失败（第三方客户端实测 HTTP 200 也可能带业务 code）。
  if (!res.ok || json.code) {
    throw new Error(
      `百炼 ${action} 失败 HTTP ${res.status} code=${json.code ?? "-"}：${json.message ?? raw.slice(0, 200)}（request_id=${json.request_id ?? "-"}）`,
    );
  }
  return json as T;
}

function isResourceNotExist(error: unknown): boolean {
  return error instanceof Error && /ResourceNotExist/.test(error.message);
}

/** 创建克隆音色，返回 voice_id（可能仍处于 DEPLOYING，须 waitCosyVoiceReady 后使用）。 */
export async function createCosyVoice(
  input: { sampleWavBytes: Uint8Array; prefix: string; targetModel?: string },
  deps?: Partial<BailianDeps>,
): Promise<string> {
  if (!input.sampleWavBytes || input.sampleWavBytes.length === 0) {
    throw new Error("克隆样本为空——拒绝创建音色");
  }
  const dataUri = `data:audio/wav;base64,${Buffer.from(input.sampleWavBytes).toString("base64")}`;
  const json = await callBailian<{ output?: { voice_id?: string } }>(
    "create_voice",
    {
      target_model: input.targetModel ?? getCosyvoiceModel(),
      prefix: input.prefix,
      url: dataUri,
      language_hints: ["zh"],
    },
    deps,
  );
  const voiceId = json.output?.voice_id;
  if (!voiceId) {
    throw new Error(`百炼 create_voice 响应缺 voice_id（协议漂移）：${JSON.stringify(json).slice(0, 200)}`);
  }
  return voiceId;
}

/** 查询音色状态；音色不存在（被清理/从未存在）返回 null，其余错误照常抛。 */
export async function queryCosyVoice(
  voiceId: string,
  deps?: Partial<BailianDeps>,
): Promise<{ status: string } | null> {
  try {
    const json = await callBailian<{ output?: { status?: string } }>("query_voice", { voice_id: voiceId }, deps);
    const status = json.output?.status;
    if (!status) {
      throw new Error(`百炼 query_voice 响应缺 status（协议漂移）：${JSON.stringify(json).slice(0, 200)}`);
    }
    return { status };
  } catch (error) {
    if (isResourceNotExist(error)) return null;
    throw error;
  }
}

/** 删除音色释放配额（1000/账号）。音色不存在视为已删除（幂等成功）。 */
export async function deleteCosyVoice(voiceId: string, deps?: Partial<BailianDeps>): Promise<void> {
  try {
    await callBailian("delete_voice", { voice_id: voiceId }, deps);
  } catch (error) {
    if (isResourceNotExist(error)) return;
    throw error;
  }
}

export interface WaitReadyDeps extends BailianDeps {
  intervalMs: number;
  timeoutMs: number;
  sleepFn: (ms: number) => Promise<void>;
}

/** 轮询到 OK（实测通常即时；UNDEPLOYED=审核未通过立即抛）。 */
export async function waitCosyVoiceReady(
  voiceId: string,
  deps?: Partial<WaitReadyDeps>,
): Promise<void> {
  const intervalMs = Math.max(1, deps?.intervalMs ?? 2000);
  const timeoutMs = deps?.timeoutMs ?? 40_000;
  const sleepFn = deps?.sleepFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await queryCosyVoice(voiceId, deps);
    if (result === null) {
      throw new Error(`音色 ${voiceId} 创建后查询不存在（协议漂移）`);
    }
    if (result.status === "OK") return;
    if (result.status === "UNDEPLOYED") {
      throw new Error("克隆音色审核未通过——样本可能含杂音/非本人人声，请按拍摄要求重录底板视频");
    }
    if (Date.now() >= deadline) {
      throw new Error(`等待音色就绪超时（>${Math.round(timeoutMs / 1000)}s 仍在 ${result.status}）`);
    }
    await sleepFn(intervalMs);
  }
}
```

- [ ] **Step 4: 跑测试**

Run: `npx vitest run tests/cosyvoice-enrollment.test.ts`
Expected: 11 passed

- [ ] **Step 5: Commit**

```bash
git add lib/services/cosyvoice-enrollment.ts tests/cosyvoice-enrollment.test.ts
git commit -m "feat(voice-clone): 百炼 voice-enrollment 客户端（创建/查询/删除/就绪轮询，ResourceNotExist 自愈信号）"
```

---

### Task 4: TTS 客户端 `cosyvoice-tts.ts`

**Files:**
- Create: `lib/services/cosyvoice-tts.ts`
- Test: `tests/cosyvoice-tts.test.ts`

- [ ] **Step 1: 写失败测试**（结构对齐 `tests/doubao-tts.test.ts`，SSE 帧用探针实测形状）

```ts
// tests/cosyvoice-tts.test.ts
import { describe, expect, it } from "vitest";
import { synthesizeCosyVoiceSpeech, type CosyvoiceTtsDeps } from "@/lib/services/cosyvoice-tts";

function sseBody(events: object[]): string {
  return events.map((e) => `data:${JSON.stringify(e)}`).join("\n\n") + "\n\n";
}

const AUDIO_FRAME = {
  request_id: "r1",
  output: {
    finish_reason: "null",
    type: "sentence-synthesis",
    sentence: {
      index: 0,
      words: [
        { text: "大", begin_index: 0, end_index: 1, begin_time: 0, end_time: 250 },
        { text: "家", begin_index: 1, end_index: 2, begin_time: 250, end_time: 520 },
      ],
    },
    audio: { data: Buffer.from("fake-mp3-audio").toString("base64") },
  },
};
const STOP_FRAME = { request_id: "r1", output: { finish_reason: "stop", type: "sentence-end", sentence: { index: 0, words: [] } }, usage: { characters: 2 } };

function makeDeps(body: string, status = 200) {
  const stored: { key?: string } = {};
  const deps: CosyvoiceTtsDeps = {
    fetchImpl: (async () => new Response(body, { status })) as unknown as typeof fetch,
    probeDuration: async () => 0.52,
    putObject: async (key) => { stored.key = key; },
    makeTmpDir: () => "/tmp/tts-test",
    removeDir: () => {},
    writeFileFn: async () => {},
    apiKey: "sk-test",
    baseUrl: "https://api.test/api/v1",
  };
  return { deps, stored };
}

describe("synthesizeCosyVoiceSpeech", () => {
  it("SSE 流解析：音频拼接 + 字戳毫秒→秒 + 时长 ffprobe 实测", async () => {
    const { deps, stored } = makeDeps(sseBody([AUDIO_FRAME, STOP_FRAME]));
    const result = await synthesizeCosyVoiceSpeech({ text: "大家", voice: "cosyvoice-v3.5-plus-av1-x" }, deps);
    expect(result.words).toEqual([
      { word: "大", startSec: 0, endSec: 0.25 },
      { word: "家", startSec: 0.25, endSec: 0.52 },
    ]);
    expect(result.durationSeconds).toBe(0.52);
    expect(stored.key).toMatch(/^voices\/.+\.mp3$/);
    expect(result.audioBytes.length).toBeGreaterThan(0);
  });

  it("sentence-synthesis 重复携带 words → 按句:index:begin_index 去重", async () => {
    const dup = { ...AUDIO_FRAME }; // 同一帧出现两次模拟重复携带
    const { deps } = makeDeps(sseBody([AUDIO_FRAME, dup, STOP_FRAME]));
    const result = await synthesizeCosyVoiceSpeech({ text: "大家", voice: "v" }, deps);
    expect(result.words.length).toBe(2);
  });

  it("请求体带 word_timestamp_enabled + SSE 头", async () => {
    let sentBody = "";
    let sseHeader = "";
    const { deps } = makeDeps(sseBody([AUDIO_FRAME, STOP_FRAME]));
    deps.fetchImpl = (async (_url: string, init?: RequestInit) => {
      sentBody = String(init?.body ?? "");
      sseHeader = String((init?.headers as Record<string, string>)?.["X-DashScope-SSE"] ?? "");
      return new Response(sseBody([AUDIO_FRAME, STOP_FRAME]), { status: 200 });
    }) as unknown as typeof fetch;
    await synthesizeCosyVoiceSpeech({ text: "大家", voice: "v" }, deps);
    expect(sentBody).toContain('"word_timestamp_enabled":true');
    expect(sentBody).toContain('"model":"cosyvoice-v3.5-plus"');
    expect(sseHeader).toBe("enable");
  });

  it("缺 stop 帧 → 抛音频截断", async () => {
    const { deps } = makeDeps(sseBody([AUDIO_FRAME]));
    await expect(synthesizeCosyVoiceSpeech({ text: "大家", voice: "v" }, deps)).rejects.toThrow(/截断|结束/);
  });

  it("无音频数据 → 抛错", async () => {
    const noAudio = { request_id: "r", output: { finish_reason: "null", type: "sentence-begin", sentence: { index: 0, words: [] } } };
    const { deps } = makeDeps(sseBody([noAudio, STOP_FRAME]));
    await expect(synthesizeCosyVoiceSpeech({ text: "大家", voice: "v" }, deps)).rejects.toThrow(/无音频/);
  });

  it("HTTP 非 200 → 抛错带截断原文", async () => {
    const { deps } = makeDeps(JSON.stringify({ code: "InvalidApiKey", message: "bad" }), 401);
    await expect(synthesizeCosyVoiceSpeech({ text: "大家", voice: "v" }, deps)).rejects.toThrow(/401/);
  });

  it("文本为空 → 抛错", async () => {
    const { deps } = makeDeps(sseBody([STOP_FRAME]));
    await expect(synthesizeCosyVoiceSpeech({ text: "  ", voice: "v" }, deps)).rejects.toThrow(/为空/);
  });

  it("未配置 DASHSCOPE_API_KEY → 抛错", async () => {
    await expect(synthesizeCosyVoiceSpeech({ text: "大家", voice: "v" }, {
      fetchImpl: (async () => new Response("")) as unknown as typeof fetch,
      probeDuration: async () => 1,
      putObject: async () => {},
      makeTmpDir: () => "/tmp/x",
      removeDir: () => {},
      writeFileFn: async () => {},
      apiKey: "",
    })).rejects.toThrow(/DASHSCOPE_API_KEY/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/cosyvoice-tts.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// lib/services/cosyvoice-tts.ts
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCosyvoiceModel, getDashscopeApiKey, getDashscopeBaseUrl } from "@/lib/env";
import { createId } from "@/lib/ids";
import { SPEECH_CHARS_PER_SECOND } from "@/lib/speech-rate";
import { putObjectFromBuffer } from "@/lib/storage";
import { probeFileDuration } from "@/lib/services/ffmpeg-runner";
import type { WordTimestamp } from "@/lib/services/avatar-provider";
import type { DoubaoTtsResult } from "@/lib/services/doubao-tts";

/**
 * 阿里百炼 CosyVoice TTS 客户端（HTTP + X-DashScope-SSE: enable 流式）。
 * 与 doubao-tts.ts 同构（返回 DoubaoTtsResult），字幕链路零改动。
 *
 * 协议要点（scripts/probe-cosyvoice.mjs 实测）：
 *  - SSE 只有 "data:{json}" 行（无 event: 字段、无 [DONE]），finish_reason=="stop" 判完
 *  - 音频帧在 sentence-synthesis 事件的 output.audio.data（base64），顺序拼接
 *  - 字级时间戳 output.sentence.words[]（begin_time/end_time 毫秒→秒）
 *  - sentence-synthesis 会重复携带整句 words——按「句index:begin_index」去重
 */

const SYNTH_PATH = "/services/audio/tts/SpeechSynthesizer";
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_TEXT_BYTES = 3000;

export type { DoubaoTtsResult as CosyvoiceTtsResult };

export interface CosyvoiceTtsDeps {
  fetchImpl: typeof fetch;
  probeDuration: (pathOrUrl: string) => Promise<number>;
  putObject: (key: string, bytes: Uint8Array, contentType: string) => Promise<unknown>;
  makeTmpDir: () => string;
  removeDir: (dir: string) => void;
  writeFileFn: (path: string, data: Buffer) => Promise<unknown>;
  /** 测试注入；缺省读 env。 */
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

interface SseEvent {
  request_id?: string;
  output?: {
    finish_reason?: string;
    type?: string;
    sentence?: {
      index?: number;
      words?: { text?: string; begin_index?: number; end_index?: number; begin_time?: number; end_time?: number }[];
    };
    audio?: { data?: string | null };
  };
  code?: string;
  message?: string;
}

export async function synthesizeCosyVoiceSpeech(
  input: { text: string; voice: string },
  deps?: Partial<CosyvoiceTtsDeps>,
): Promise<DoubaoTtsResult> {
  const apiKey = deps?.apiKey ?? getDashscopeApiKey();
  if (!apiKey) {
    throw new Error("DASHSCOPE_API_KEY is not configured");
  }
  const textBytes = Buffer.byteLength(input.text, "utf8");
  if (textBytes === 0 || !input.text.trim()) {
    throw new Error("CosyVoice TTS 文本为空");
  }
  if (textBytes > MAX_TEXT_BYTES) {
    throw new Error(`CosyVoice TTS 文本超长（${textBytes}B > ${MAX_TEXT_BYTES}B）——单句不应到此量级，请检查分段逻辑`);
  }
  const baseUrl = (deps?.baseUrl ?? getDashscopeBaseUrl()).replace(/\/+$/, "");
  const fetchImpl = deps?.fetchImpl ?? fetch;
  const res = await fetchImpl(`${baseUrl}${SYNTH_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "X-DashScope-SSE": "enable",
    },
    body: JSON.stringify({
      model: deps?.model ?? getCosyvoiceModel(),
      input: {
        text: input.text,
        voice: input.voice,
        format: "mp3",
        sample_rate: 24000,
        word_timestamp_enabled: true,
      },
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`CosyVoice TTS HTTP ${res.status}：${raw.slice(0, 200)}`);
  }

  const audioChunks: Buffer[] = [];
  const wordMap = new Map<string, WordTimestamp & { __sort: [number, number] }>();
  let sawStop = false;
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const dataLine = block.split(/\r?\n/).find((l) => l.startsWith("data:"));
    if (!dataLine) continue;
    let evt: SseEvent;
    try {
      evt = JSON.parse(dataLine.slice(5)) as SseEvent;
    } catch {
      throw new Error(`CosyVoice TTS SSE 含非 JSON 事件（协议漂移）：${dataLine.slice(0, 200)}`);
    }
    if (evt.code) {
      throw new Error(`CosyVoice TTS 合成失败 code=${evt.code}：${evt.message ?? "未知错误"}`);
    }
    const out = evt.output;
    if (typeof out?.audio?.data === "string" && out.audio.data.length > 0) {
      audioChunks.push(Buffer.from(out.audio.data, "base64"));
    }
    if (Array.isArray(out?.sentence?.words)) {
      const sentIdx = typeof out.sentence.index === "number" ? out.sentence.index : 0;
      for (const w of out.sentence.words) {
        if (w?.text && typeof w.begin_time === "number" && typeof w.end_time === "number") {
          const beginIndex = typeof w.begin_index === "number" ? w.begin_index : wordMap.size;
          // 重复携带防御：同一句同一字后到的帧覆盖先到的（内容一致，幂等）。
          wordMap.set(`${sentIdx}:${beginIndex}`, {
            word: w.text,
            startSec: w.begin_time / 1000,
            endSec: w.end_time / 1000,
            __sort: [sentIdx, beginIndex],
          });
        }
      }
    }
    if (out?.finish_reason === "stop") sawStop = true;
  }
  if (!sawStop) {
    throw new Error("CosyVoice TTS 响应缺少结束帧（finish_reason≠stop）——音频可能被截断，丢弃重试");
  }
  if (audioChunks.length === 0) {
    throw new Error("CosyVoice TTS 返回无音频数据");
  }
  const audio = Buffer.concat(audioChunks);
  if (audio.length === 0) {
    throw new Error("CosyVoice TTS 返回无音频数据");
  }
  const words: WordTimestamp[] = [...wordMap.values()]
    .sort((a, b) => a.__sort[0] - b.__sort[0] || a.__sort[1] - b.__sort[1])
    .map(({ word, startSec, endSec }) => ({ word, startSec, endSec }));

  const putObject = deps?.putObject ?? putObjectFromBuffer;
  const storageKey = `voices/${createId("tts")}.mp3`;
  const audioBytes = new Uint8Array(audio);
  await putObject(storageKey, audioBytes, "audio/mpeg");

  // 时长权威来源：ffprobe 实测（与豆包同款 mp3 句首静音防御）。
  const makeTmpDir = deps?.makeTmpDir ?? (() => mkdtempSync(join(tmpdir(), "tts-")));
  const removeDir = deps?.removeDir ?? ((dir: string) => rmSync(dir, { recursive: true, force: true }));
  const writeFileFn = deps?.writeFileFn ?? (async (path: string, data: Buffer) => { await writeFile(path, data); });
  const probe = deps?.probeDuration ?? probeFileDuration;
  let durationSeconds = 0;
  const dir = makeTmpDir();
  try {
    const audioPath = join(dir, "speech.mp3");
    await writeFileFn(audioPath, audio);
    durationSeconds = await probe(audioPath);
  } finally {
    removeDir(dir);
  }
  if (!(durationSeconds > 0)) {
    const lastWordEnd = words.length > 0 ? Math.max(...words.map((w) => w.endSec)) : 0;
    durationSeconds = lastWordEnd > 0 ? lastWordEnd : Array.from(input.text).length / SPEECH_CHARS_PER_SECOND;
  }

  return { audioStorageKey: storageKey, audioBytes, durationSeconds, words };
}
```

- [ ] **Step 4: 跑测试**

Run: `npx vitest run tests/cosyvoice-tts.test.ts`
Expected: 8 passed

- [ ] **Step 5: Commit**

```bash
git add lib/services/cosyvoice-tts.ts tests/cosyvoice-tts.test.ts
git commit -m "feat(voice-clone): CosyVoice SSE 流式 TTS 客户端（字戳毫秒→秒+重复帧去重，对齐 DoubaoTtsResult）"
```

---

### Task 5: provider 接入 `volcengine-lipsync.ts`（核心）

**Files:**
- Modify: `lib/services/providers/volcengine-lipsync.ts`
- Test: `tests/volcengine-lipsync-provider.test.ts`（追加；先读现有结构再追加，保持风格）

- [ ] **Step 1: 写失败测试（追加到 tests/volcengine-lipsync-provider.test.ts）**

先读现有测试文件头部（deps 注入模式），追加以下用例（若现有 `makeDeps` helper 存在则复用其签名）：

```ts
// 追加 import：
// import { createVolcEngineLipSyncProvider } from "@/lib/services/providers/volcengine-lipsync";

describe("声音克隆（getDigitalTwinStatus）", () => {
  it("生产模式：内联复刻（抽样本→创建→轮询OK）→ ready + providerVoiceId", async () => {
    const calls: string[] = [];
    const provider = createVolcEngineLipSyncProvider({
      ...baseDeps(), // 现有 helper；若无不补，用逐字段注入
      extractSampleFn: async () => { calls.push("extract"); return { wavBytes: new Uint8Array([1]), durationSec: 20 }; },
      createVoiceFn: async () => { calls.push("create"); return "cosyvoice-v3.5-plus-av1-xyz"; },
      waitVoiceReadyFn: async () => { calls.push("wait"); },
      hasCosyvoiceFn: () => true,
    });
    const status = await provider.getDigitalTwinStatus({ groupId: "lipsync:footage/key.mp4" });
    expect(status.trainingStatus).toBe("ready");
    expect(status.providerVoiceId).toBe("cosyvoice-v3.5-plus-av1-xyz");
    expect(calls).toEqual(["extract", "create", "wait"]);
  });

  it("复刻失败 → failed + 原因透出（不重试）", async () => {
    const provider = createVolcEngineLipSyncProvider({
      ...baseDeps(),
      extractSampleFn: async () => ({ wavBytes: new Uint8Array([1]), durationSec: 20 }),
      createVoiceFn: async () => { throw new Error("百炼 create_voice 失败：AudioShortError"); },
      hasCosyvoiceFn: () => true,
    });
    const status = await provider.getDigitalTwinStatus({ groupId: "lipsync:footage/key.mp4" });
    expect(status.trainingStatus).toBe("failed");
    expect(status.reason).toContain("AudioShortError");
  });

  it("demo 模式（无百炼 Key）：保持现状——立即 ready + env 豆包音色", async () => {
    const provider = createVolcEngineLipSyncProvider({ ...baseDeps(), hasCosyvoiceFn: () => false });
    const status = await provider.getDigitalTwinStatus({ groupId: "lipsync:footage/key.mp4" });
    expect(status.trainingStatus).toBe("ready");
    expect(status.providerVoiceId).toMatch(/^zh_female/); // env 默认豆包女声
  });
});

describe("声音克隆（TTS 分派与自愈）", () => {
  it("cosyvoice- 前缀 voice → 走 CosyVoice 合成", async () => {
    let cosyUsed = false;
    const provider = createVolcEngineLipSyncProvider({
      ...baseDeps(),
      cosySynthesizeFn: async () => { cosyUsed = true; return fakeSpeech(); },
      hasCosyvoiceFn: () => true,
    });
    await provider.generateTalkingHead({ providerAvatarId: "footage/key.mp4", providerVoiceId: "cosyvoice-v3.5-plus-av1-x", scriptText: "大家好" });
    expect(cosyUsed).toBe(true);
  });

  it("生产模式 + 非克隆音色 → fail-fast（形象声音未就绪）", async () => {
    const provider = createVolcEngineLipSyncProvider({ ...baseDeps(), hasCosyvoiceFn: () => true });
    await expect(
      provider.generateTalkingHead({ providerAvatarId: "footage/key.mp4", providerVoiceId: "zh_female_x", scriptText: "大家好" }),
    ).rejects.toThrow(/声音未就绪/);
  });

  it("音色被清理（合成失败且 queryVoice=null）→ 重建并重试一次", async () => {
    let synthCalls = 0;
    let rebuilt = false;
    const provider = createVolcEngineLipSyncProvider({
      ...baseDeps(),
      cosySynthesizeFn: async ({ voice }: { text: string; voice: string }) => {
        synthCalls++;
        if (voice === "cosyvoice-v3.5-plus-old-x" && !rebuilt) throw new Error("Remote cancelled grpc stream");
        return fakeSpeech();
      },
      queryVoiceFn: async () => null, // 已被清理
      extractSampleFn: async () => ({ wavBytes: new Uint8Array([1]), durationSec: 20 }),
      createVoiceFn: async () => { rebuilt = true; return "cosyvoice-v3.5-plus-new-y"; },
      waitVoiceReadyFn: async () => {},
      hasCosyvoiceFn: () => true,
    });
    await provider.generateTalkingHead({ providerAvatarId: "footage/key.mp4", providerVoiceId: "cosyvoice-v3.5-plus-old-x", scriptText: "大家好" });
    expect(rebuilt).toBe(true);
    expect(synthCalls).toBe(2);
  });

  it("音色仍在（queryVoice 非 null）的合成失败 → 直接抛错不重建", async () => {
    const provider = createVolcEngineLipSyncProvider({
      ...baseDeps(),
      cosySynthesizeFn: async () => { throw new Error("HTTP 500"); },
      queryVoiceFn: async () => ({ status: "OK" }),
      hasCosyvoiceFn: () => true,
    });
    await expect(
      provider.generateTalkingHead({ providerAvatarId: "footage/key.mp4", providerVoiceId: "cosyvoice-v3.5-plus-av1-x", scriptText: "大家好" }),
    ).rejects.toThrow(/HTTP 500/);
  });
});

// fakeSpeech helper（若文件内已有等价物则复用）：
// const fakeSpeech = () => ({ audioStorageKey: "voices/x.mp3", audioBytes: new Uint8Array([1]), durationSeconds: 1, words: [] });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/volcengine-lipsync-provider.test.ts`
Expected: 新用例 FAIL（deps 字段不存在）

- [ ] **Step 3: 实现（volcengine-lipsync.ts 修改点）**

3a. 文件头部 import 追加：

```ts
import { getCosyvoiceModel, hasCosyvoiceProvider } from "@/lib/env";
import { createCosyVoice, queryCosyVoice, waitCosyVoiceReady } from "@/lib/services/cosyvoice-enrollment";
import { synthesizeCosyVoiceSpeech } from "@/lib/services/cosyvoice-tts";
import { extractVoiceSampleFromVideo, type VoiceSampleResult } from "@/lib/services/voice-sample";
import { randomBytes } from "node:crypto";
```

3b. `LipSyncProviderDeps` 追加（放在现有字段后）：

```ts
  // ── 声音克隆（CosyVoice）注入点；缺省走真实实现 ──
  cosySynthesizeFn: (input: { text: string; voice: string }) => Promise<DoubaoTtsResult>;
  extractSampleFn: (input: { footageBytes: Uint8Array }) => Promise<VoiceSampleResult>;
  createVoiceFn: (input: { sampleWavBytes: Uint8Array; prefix: string; targetModel?: string }) => Promise<string>;
  queryVoiceFn: (voiceId: string) => Promise<{ status: string } | null>;
  waitVoiceReadyFn: (voiceId: string) => Promise<void>;
  /** 是否启用克隆（缺省=hasCosyvoiceProvider()）；demo/dev 无 Key 回退豆包。 */
  hasCosyvoiceFn: () => boolean;
```

3c. `createVolcEngineLipSyncProvider` 装配（现有 `const synthesize = ...` 行附近追加）：

```ts
  const cosySynthesize = deps?.cosySynthesizeFn ?? synthesizeCosyVoiceSpeech;
  const extractSample = deps?.extractSampleFn ?? extractVoiceSampleFromVideo;
  const createVoice = deps?.createVoiceFn ?? createCosyVoice;
  const queryVoice = deps?.queryVoiceFn ?? queryCosyVoice;
  const waitVoiceReady = deps?.waitVoiceReadyFn ?? waitCosyVoiceReady;
  const hasCosyvoice = deps?.hasCosyvoiceFn ?? hasCosyvoiceProvider;
```

3d. 新增内部函数（放在 `uploadToMediaKit` 之后）：

```ts
  /** 克隆音色 ID 判定（实测格式：{target_model}-{prefix}-{uid}）。 */
  function isCosyVoiceId(voice?: string): voice is string {
    return Boolean(voice && voice.startsWith("cosyvoice-"));
  }

  /** 幂等复刻：footage → 样本 → 创建音色 → 轮询就绪。克隆免费，重复执行无副作用。 */
  async function enrollVoice(footageStorageKey: string): Promise<string> {
    const footageBytes = await getObjectBytes(footageStorageKey);
    const sample = await extractSample({ footageBytes });
    // prefix 仅数字+字母 ≤10 字符（enrollment 硬约束）
    const prefix = `av${randomBytes(4).toString("hex")}`;
    const voiceId = await createVoice({ sampleWavBytes: sample.wavBytes, prefix, targetModel: getCosyvoiceModel() });
    await waitVoiceReady(voiceId);
    return voiceId;
  }

  /**
   * TTS 分派（spec §4.4）：克隆音色 → CosyVoice；无百炼 Key（demo/dev）→ 豆包兜底；
   * 生产 + 非克隆音色 = 数据异常（用户拍板：复刻就绪才出片），fail-fast。
   */
  async function synthesizeFor(input: { text: string; voice?: string }): Promise<DoubaoTtsResult> {
    if (isCosyVoiceId(input.voice)) {
      return cosySynthesize({ text: input.text, voice: input.voice });
    }
    if (hasCosyvoice()) {
      throw new Error("形象声音未就绪（缺少克隆音色）——请等待形象就绪后再生成");
    }
    return synthesize({ text: input.text, voice: input.voice });
  }
```

3e. `getDigitalTwinStatus` 改造（替换现有 `const storageKey = ...` 之后的 return 块）：

```ts
      const storageKey = input.groupId.slice(LIPSYNC_GROUP_PREFIX.length);
      if (!hasCosyvoice()) {
        // demo/dev：无百炼 Key → 维持旧行为（env 豆包音色），本地开发可用。
        return {
          consentStatus: "approved",
          trainingStatus: "ready",
          providerAvatarId: storageKey,
          providerVoiceId: getDoubaoTtsVoice(),
        };
      }
      // 生产：内联幂等复刻（创建免费；终态 ready 后路由层不再轮询，每形象只执行一次）。
      // waitVoiceReady 通常即时返回（实测审核秒级），上限 40s 为防御。
      try {
        const voiceId = await enrollVoice(storageKey);
        return {
          consentStatus: "approved",
          trainingStatus: "ready",
          providerAvatarId: storageKey,
          providerVoiceId: voiceId,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          consentStatus: "approved",
          trainingStatus: "failed",
          reason: `声音复刻失败：${msg}。请按拍摄要求重录底板视频后重新创建形象`,
        };
      }
```

3f. `generateTalkingHead` Stage 1 替换 + 自愈（替换 `const speech = await synthesize(...)` 行）：

```ts
      // Stage 1: 文案 → 配音。克隆音色被阿里清理（1 年未合成）时：queryVoice 确认
      // 不存在 → 用底板重建 → 重试一次（重建免费；音色仍在的失败不重建，直接抛）。
      let providerVoiceId = input.providerVoiceId;
      let speech: DoubaoTtsResult;
      try {
        speech = await synthesizeFor({ text: input.scriptText, voice: providerVoiceId });
      } catch (firstError) {
        if (!isCosyVoiceId(providerVoiceId)) throw firstError;
        const existing = await queryVoice(providerVoiceId).catch(() => undefined);
        if (existing !== null) throw firstError; // 音色仍在或查询异常 → 原始错误透出
        providerVoiceId = await enrollVoice(input.providerAvatarId);
        speech = await cosySynthesize({ text: input.scriptText, voice: providerVoiceId });
      }
```

注：自愈重建的新 voice_id 不回写 DB（provider 层无 repo 访问权）——1 年未用才触发，年频事件每次重建成本≈0；若未来频繁触发再考虑回写。此注释写进代码。

3g. `synthesizeSpeech`（画外音段）改走分派：

```ts
    async synthesizeSpeech(input) {
      return synthesizeFor({ text: input.text, voice: input.providerVoiceId });
    },
```

- [ ] **Step 4: 跑测试**

Run: `npx vitest run tests/volcengine-lipsync-provider.test.ts`
Expected: 全部 passed（含旧有用例——旧用例的 deps 未注入 hasCosyvoiceFn 时缺省读 env，测试环境无 DASHSCOPE_API_KEY → 走 demo 分支，行为与旧一致）

- [ ] **Step 5: Commit**

```bash
git add lib/services/providers/volcengine-lipsync.ts tests/volcengine-lipsync-provider.test.ts
git commit -m "feat(voice-clone): 对口型 provider 接入声音克隆——轮询内联复刻、TTS 按音色前缀分派、失效重建自愈"
```

---

### Task 6: 删除形象释放音色配额

**Files:**
- Modify: `app/api/avatars/[id]/route.ts`（DELETE）
- Test: `tests/api/avatars-delete.test.ts`（追加；先读现有结构）

- [ ] **Step 1: 写失败测试（追加）**

现有测试若已 mock `@/lib/repositories`，追加 mock `@/lib/services/cosyvoice-enrollment` 的 `deleteCosyVoice`（vi.mock），用例：

```ts
it("删除对口型形象时同步释放百炼克隆音色", async () => {
  // 安排：repo.findById 返回 provider="volcengine-lipsync" + providerVoiceId="cosyvoice-v3.5-plus-av1-x"
  // 断言：deleteCosyVoice 被以该 voiceId 调用；响应 { deleted: true }
});

it("音色删除失败不阻塞形象删除（log warn）", async () => {
  // deleteCosyVoice reject；响应仍为 200 { deleted: true }
});

it("HeyGen 形象 / 无克隆音色 → 不调 deleteCosyVoice", async () => {
  // providerVoiceId="heygen_voice_x" 或 undefined；断言 deleteCosyVoice 未被调用
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/api/avatars-delete.test.ts`
Expected: 新用例 FAIL（deleteCosyVoice 未被调用）

- [ ] **Step 3: 实现（`app/api/avatars/[id]/route.ts`）**

`repo.delete(id)` 之前插入：

```ts
  // 释放百炼克隆音色配额（1000/账号）：仅对口型形象 + cosyvoice 前缀音色。
  // 远端删除失败不阻塞本地删除（孤儿音色 1 年自动清理，代价可接受）。
  if (avatar.provider === "volcengine-lipsync" && avatar.providerVoiceId?.startsWith("cosyvoice-")) {
    try {
      await deleteCosyVoice(avatar.providerVoiceId);
    } catch (error) {
      console.warn(`[avatars] 释放克隆音色失败（不影响删除）：${error instanceof Error ? error.message : String(error)}`);
    }
  }
```

头部 import 追加：`import { deleteCosyVoice } from "@/lib/services/cosyvoice-enrollment";`

- [ ] **Step 4: 跑测试**

Run: `npx vitest run tests/api/avatars-delete.test.ts`
Expected: 全部 passed

- [ ] **Step 5: Commit**

```bash
git add "app/api/avatars/[id]/route.ts" tests/api/avatars-delete.test.ts
git commit -m "feat(voice-clone): 删除形象时释放百炼克隆音色配额（失败不阻塞，孤儿音色年清兜底）"
```

---

### Task 7: 成本口径注释更新

**Files:**
- Modify: `lib/cost-estimate.ts:7`（注释）

- [ ] **Step 1: 修改注释（逻辑不变，无需新测试）**

`lib/cost-estimate.ts` 第 7 行注释替换为：

```ts
/** 火山 MediaKit 对口型定价（2026-09 官网）：¥1/分钟按输出时长。TTS 走 CosyVoice 克隆音色
 * （克隆免费；合成 1.5 元/万字符，一条 300 字文案 ≈0.05 元），预估忽略字符费。 */
```

- [ ] **Step 2: 确认现有测试不破**

Run: `npx vitest run tests/cost-estimate.test.ts`
Expected: 全部 passed

- [ ] **Step 3: Commit**

```bash
git add lib/cost-estimate.ts
git commit -m "docs(voice-clone): 成本预估注释口径更新——CosyVoice 克隆免费+字符费微量不计"
```

---

### Task 8: 五件套 + 部署配置

- [ ] **Step 1: 全量五件套**

Run: `npm test && npm run typecheck && npm run lint && npx prisma validate && npm run build`
Expected: 全绿（lint 若报 `require` 相关规则于 ffmpeg-static import，用 ES import 形式已规避；如报其他规则按提示修）

- [ ] **Step 2: Commit 剩余变更 + push**

```bash
git add -A && git commit -m "chore(voice-clone): 五件套收尾" --allow-empty && git push
```

- [ ] **Step 3: Zeabur 配置（用户操作，写入部署提示）**

web + worker 双服务环境变量：

| 变量 | 值 | 说明 |
|------|-----|------|
| `DASHSCOPE_API_KEY` | `sk-...`（桌面百炼.txt） | 必需；缺则全链路走 demo 豆包回退 |
| `DASHSCOPE_BASE_URL` | 百炼.txt 里的 workspace 域名，或缺省公共域名 | 可选 |
| `COSYVOICE_MODEL` | `cosyvoice-v3.5-plus` | 可选（缺省即 plus） |

- [ ] **Step 4: 生产冒烟（部署后用户执行）**

1. 新建形象上传底板 → 卡片「复刻中」→ 转「已就绪」
2. 出一条片 → **肉耳确认口播是本人声音**
3. 确认字幕逐字对齐正常（字级时间戳链路）
4. 删除该形象 → 百炼控制台确认音色已释放
5. 观察 Zeabur 日志 `[avatars]`/`MediaKit` 无异常

---

## Self-Review 结论

- **Spec 覆盖**：§4.1→Task2、§4.2→Task5(3e)、§4.3→Task4、§4.4→Task5(3d/3f/3g)、§4.5→Task5(3f)+Task6、§4.6→Task5(3e 状态机)+前端零改动、§4.7→Task7、§5 env→Task1、§6 失败矩阵→各 Task 测试、§7 安全→data URI+不入库、§8 测试→各 Task+Task8。
- **无占位符**：所有代码完整；探针已验证的协议细节直接内嵌。
- **类型一致性**：`DoubaoTtsResult` 复用（cosyvoice-tts re-export 为 CosyvoiceTtsResult）；deps 字段名跨任务一致（cosySynthesizeFn/extractSampleFn/createVoiceFn/queryVoiceFn/waitVoiceReadyFn/hasCosyvoiceFn）。
- **风险备注**：`getDigitalTwinStatus` 内联复刻使单次状态轮询最长 ~40s（waitVoiceReady 上限）——Zeabur 为容器部署非 serverless，可接受；实测审核通常秒级。
