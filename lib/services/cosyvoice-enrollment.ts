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

/** 百炼业务错误（含 HTTP 非 2xx / body 带业务 code 两种情况）。
 * 结构化携带 httpStatus + bailianCode：自愈信号（ResourceNotExist）只看 bailianCode，
 * 不依赖拼接后的消息文本——消息格式改动不得影响判定。 */
export class BailianError extends Error {
  readonly httpStatus: number;
  readonly bailianCode?: string;
  constructor(message: string, httpStatus: number, bailianCode?: string) {
    super(message);
    this.name = "BailianError";
    this.httpStatus = httpStatus;
    this.bailianCode = bailianCode;
  }
}

const ENROLLMENT_PATH = "/services/audio/tts/customization";
const REQUEST_TIMEOUT_MS = 120_000;

export interface BailianDeps {
  fetchImpl: typeof fetch;
  /** 测试注入；缺省读 env。 */
  apiKey?: string;
  baseUrl?: string;
}

interface BailianResponseBody { code?: string; message?: string; request_id?: string }

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
  let json: BailianResponseBody & Record<string, unknown>;
  try {
    json = JSON.parse(raw) as typeof json;
  } catch {
    throw new BailianError(`百炼 ${action} HTTP ${res.status} 非 JSON 响应：${raw.slice(0, 200)}`, res.status);
  }
  // 双通道防御：HTTP 非 2xx 或 body.code 非空都视为失败（第三方客户端实测 HTTP 200 也可能带业务 code）。
  if (!res.ok || json.code) {
    throw new BailianError(
      `百炼 ${action} 失败 HTTP ${res.status} code=${json.code ?? "-"}：${json.message ?? raw.slice(0, 200)}（request_id=${json.request_id ?? "-"}）`,
      res.status,
      json.code,
    );
  }
  return json as T;
}

function isResourceNotExist(error: unknown): boolean {
  return error instanceof BailianError && Boolean(error.bailianCode?.includes("ResourceNotExist"));
}

/** 创建克隆音色，返回 voice_id（可能仍处于 DEPLOYING，须 waitCosyVoiceReady 后使用）。 */
export async function createCosyVoice(
  input: { sampleWavBytes: Uint8Array; prefix?: string; targetModel?: string },
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
      ...(input.prefix ? { prefix: input.prefix } : {}),
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
