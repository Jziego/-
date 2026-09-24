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
