import { describe, expect, it, vi, afterEach } from "vitest";
import { createVolcEngineLipSyncProvider } from "@/lib/services/providers/volcengine-lipsync";

const FOOTAGE_KEY = "stores/store_1/assets/asset_1-me.mp4";

/** MediaKit 响应帧工厂。 */
function mediakitSubmitOk(taskId = "amk-tool-lip-sync-1") {
  return new Response(JSON.stringify({ task_id: taskId }), { status: 200 });
}
function mediakitTaskRunning() {
  return new Response(JSON.stringify({ status: "running" }), { status: 200 });
}
function mediakitTaskCompleted(videoUrl = "https://mediakit.example/result.mp4", duration = 12.34) {
  return new Response(
    JSON.stringify({ status: "completed", result: { video_url: videoUrl, duration }, expires_at: 1900000000 }),
    { status: 200 },
  );
}
function mediakitTaskFailed(message = "视频中未检测到单人真人脸") {
  return new Response(
    JSON.stringify({ status: "failed", error: { code: "ContentCheckFailed", message, param: "video_url", type: "invalid" } }),
    { status: 200 },
  );
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  const fetchImpl = vi.fn(async (url: string) => {
    if (url.includes("/api/v1/tools/lip-sync")) return mediakitSubmitOk();
    if (url.includes("/api/v1/tasks/")) return mediakitTaskCompleted();
    if (url === "https://mediakit.example/result.mp4") {
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  return {
    fetchImpl,
    synthesizeSpeechFn: vi.fn(async () => ({
      audioStorageKey: "voices/tts_fake.mp3",
      durationSeconds: 12.3,
      words: [{ word: "大", startSec: 0, endSec: 0.2 }],
    })),
    presignGet: vi.fn(async (key: string) => `https://r2.example/presigned/${key}`),
    putObject: vi.fn(async () => undefined),
    pollIntervalMs: 1,
    pollTimeoutMs: 10_000,
    apiKey: "test-mediakit-key",
    ...overrides,
  };
}

describe("volcengine-lipsync provider", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("createDigitalTwin is local-only: groupId encodes the footage storageKey, consentUrl is empty", async () => {
    const provider = createVolcEngineLipSyncProvider(makeDeps());
    const result = await provider.createDigitalTwin({ name: "老刘", footageUrl: "https://r2.example/x", footageStorageKey: FOOTAGE_KEY });
    expect(result).toEqual({ groupId: `lipsync:${FOOTAGE_KEY}`, consentUrl: "" });
  });

  it("createDigitalTwin throws when footageStorageKey is missing (contract misuse)", async () => {
    const provider = createVolcEngineLipSyncProvider(makeDeps());
    await expect(provider.createDigitalTwin({ name: "老刘", footageUrl: "https://r2.example/x" })).rejects.toThrow(/footageStorageKey/);
  });

  it("getDigitalTwinStatus is immediately ready, mapping groupId back to footage storageKey + default voice", async () => {
    vi.stubEnv("DOUBAO_TTS_VOICE", "voice_default");
    const provider = createVolcEngineLipSyncProvider(makeDeps());
    const status = await provider.getDigitalTwinStatus({ groupId: `lipsync:${FOOTAGE_KEY}` });
    expect(status).toMatchObject({
      consentStatus: "approved",
      trainingStatus: "ready",
      providerAvatarId: FOOTAGE_KEY,
      providerVoiceId: "voice_default",
    });
  });

  it("getDigitalTwinStatus reports failed for a malformed groupId (defensive)", async () => {
    const provider = createVolcEngineLipSyncProvider(makeDeps());
    const status = await provider.getDigitalTwinStatus({ groupId: "garbage" });
    expect(status.trainingStatus).toBe("failed");
    expect(status.reason).toBeTruthy();
  });

  it("generateTalkingHead: TTS → presigned urls → lip-sync submit → poll → download → R2, with words + duration", async () => {
    const deps = makeDeps();
    const provider = createVolcEngineLipSyncProvider(deps);
    const onProgress = vi.fn();

    const result = await provider.generateTalkingHead(
      { providerAvatarId: FOOTAGE_KEY, providerVoiceId: "voice_a", scriptText: "大家好，本周全场八八折" },
      onProgress,
    );

    // TTS 用形象的声音
    expect(deps.synthesizeSpeechFn).toHaveBeenCalledWith({ text: "大家好，本周全场八八折", voice: "voice_a" });
    // MediaKit 提交体：双 presigned URL + 恒 enable_video_loop
    const submitCall = (deps.fetchImpl as ReturnType<typeof vi.fn>).mock.calls.find(([url]) =>
      String(url).includes("/api/v1/tools/lip-sync"),
    ) as unknown as [string, RequestInit];
    const submitBody = JSON.parse(String(submitCall[1].body));
    expect(submitBody).toEqual({
      video_url: `https://r2.example/presigned/${FOOTAGE_KEY}`,
      audio_url: "https://r2.example/presigned/voices/tts_fake.mp3",
      enable_video_loop: true,
    });
    expect((submitCall[1].headers as Record<string, string>).Authorization).toBe("Bearer test-mediakit-key");
    // 产物转存 R2 + 时长用 MediaKit 权威值 + 字级时间戳透传
    expect(deps.putObject).toHaveBeenCalledWith(
      expect.stringMatching(/^avatars\/lipsync\/amk-tool-lip-sync-1\.mp4$/),
      new Uint8Array([1, 2, 3]),
      "video/mp4",
    );
    expect(result.videoAssetId).toMatch(/^avatars\/lipsync\//);
    expect(result.durationSeconds).toBe(12.34);
    expect(result.words).toEqual([{ word: "大", startSec: 0, endSec: 0.2 }]);
    expect(onProgress).toHaveBeenCalled();
  });

  it("generateTalkingHead falls back to the TTS duration when the task result has no duration", async () => {
    const deps = makeDeps({
      fetchImpl: vi.fn(async (url: string) => {
        if (url.includes("/api/v1/tools/lip-sync")) return mediakitSubmitOk();
        if (url.includes("/api/v1/tasks/")) {
          return new Response(JSON.stringify({ status: "completed", result: { video_url: "https://mediakit.example/result.mp4" } }), { status: 200 });
        }
        return new Response(new Uint8Array([1]), { status: 200 });
      }),
    });
    const provider = createVolcEngineLipSyncProvider(deps);
    const result = await provider.generateTalkingHead({ providerAvatarId: FOOTAGE_KEY, scriptText: "测试" });
    expect(result.durationSeconds).toBe(12.3);
  });

  it("generateTalkingHead falls back to the TTS duration when the task result duration is 0", async () => {
    const deps = makeDeps({
      fetchImpl: vi.fn(async (url: string) => {
        if (url.includes("/api/v1/tools/lip-sync")) return mediakitSubmitOk();
        if (url.includes("/api/v1/tasks/")) {
          return new Response(
            JSON.stringify({ status: "completed", result: { video_url: "https://mediakit.example/result.mp4", duration: 0 } }),
            { status: 200 },
          );
        }
        return new Response(new Uint8Array([1]), { status: 200 });
      }),
    });
    const provider = createVolcEngineLipSyncProvider(deps);
    const result = await provider.generateTalkingHead({ providerAvatarId: FOOTAGE_KEY, scriptText: "测试" });
    expect(result.durationSeconds).toBe(12.3);
  });

  it("generateTalkingHead rejects a zero-byte artifact download", async () => {
    const deps = makeDeps({
      fetchImpl: vi.fn(async (url: string) => {
        if (url.includes("/api/v1/tools/lip-sync")) return mediakitSubmitOk();
        if (url.includes("/api/v1/tasks/")) return mediakitTaskCompleted();
        return new Response(new Uint8Array([]), { status: 200 });
      }),
    });
    const provider = createVolcEngineLipSyncProvider(deps);
    await expect(
      provider.generateTalkingHead({ providerAvatarId: FOOTAGE_KEY, scriptText: "测试" }),
    ).rejects.toThrow(/下载为空/);
    expect(deps.putObject).not.toHaveBeenCalled();
  });

  it("generateTalkingHead surfaces the provider error message when the task fails", async () => {
    const deps = makeDeps({
      fetchImpl: vi.fn(async (url: string) => {
        if (url.includes("/api/v1/tools/lip-sync")) return mediakitSubmitOk();
        if (url.includes("/api/v1/tasks/")) return mediakitTaskFailed();
        throw new Error("unexpected");
      }),
    });
    const provider = createVolcEngineLipSyncProvider(deps);
    await expect(
      provider.generateTalkingHead({ providerAvatarId: FOOTAGE_KEY, scriptText: "测试" }),
    ).rejects.toThrow(/对口型生成失败.*未检测到单人真人脸/);
  });

  it("generateTalkingHead keeps polling through running states and reports progress", async () => {
    let taskCalls = 0;
    const deps = makeDeps({
      fetchImpl: vi.fn(async (url: string) => {
        if (url.includes("/api/v1/tools/lip-sync")) return mediakitSubmitOk();
        if (url.includes("/api/v1/tasks/")) {
          taskCalls++;
          return taskCalls < 3 ? mediakitTaskRunning() : mediakitTaskCompleted();
        }
        return new Response(new Uint8Array([1]), { status: 200 });
      }),
    });
    const provider = createVolcEngineLipSyncProvider(deps);
    const onProgress = vi.fn();
    const result = await provider.generateTalkingHead({ providerAvatarId: FOOTAGE_KEY, scriptText: "测试" }, onProgress);
    expect(result.durationSeconds).toBe(12.34);
    expect(taskCalls).toBe(3);
    expect(onProgress).toHaveBeenCalledTimes(3);
  });

  it("generateTalkingHead fails fast when the poll response lacks a status field (protocol drift)", async () => {
    const deps = makeDeps({
      fetchImpl: vi.fn(async (url: string) => {
        if (url.includes("/api/v1/tools/lip-sync")) return mediakitSubmitOk();
        if (url.includes("/api/v1/tasks/")) return new Response(JSON.stringify({}), { status: 200 });
        throw new Error("unexpected");
      }),
    });
    const provider = createVolcEngineLipSyncProvider(deps);
    await expect(
      provider.generateTalkingHead({ providerAvatarId: FOOTAGE_KEY, scriptText: "测试" }),
    ).rejects.toThrow(/缺少 status/);
  });

  it("generateTalkingHead times out with a descriptive error", async () => {
    const deps = makeDeps({
      pollTimeoutMs: 5,
      fetchImpl: vi.fn(async (url: string) => {
        if (url.includes("/api/v1/tools/lip-sync")) return mediakitSubmitOk();
        if (url.includes("/api/v1/tasks/")) return mediakitTaskRunning();
        throw new Error("unexpected");
      }),
    });
    const provider = createVolcEngineLipSyncProvider(deps);
    await expect(
      provider.generateTalkingHead({ providerAvatarId: FOOTAGE_KEY, scriptText: "测试" }),
    ).rejects.toThrow(/超时/);
  });

  it("generateTalkingHead throws when the completed task has no video_url", async () => {
    const deps = makeDeps({
      fetchImpl: vi.fn(async (url: string) => {
        if (url.includes("/api/v1/tools/lip-sync")) return mediakitSubmitOk();
        if (url.includes("/api/v1/tasks/")) {
          return new Response(JSON.stringify({ status: "completed", result: {} }), { status: 200 });
        }
        throw new Error("unexpected");
      }),
    });
    const provider = createVolcEngineLipSyncProvider(deps);
    await expect(
      provider.generateTalkingHead({ providerAvatarId: FOOTAGE_KEY, scriptText: "测试" }),
    ).rejects.toThrow(/video_url/);
  });

  it("generateTalkingHead throws on a submit-level API error envelope", async () => {
    const deps = makeDeps({
      fetchImpl: vi.fn(async () =>
        new Response(JSON.stringify({ success: false, error: { code: "InvalidParam", message: "video_url 无法下载", param: "video_url", type: "invalid" } }), { status: 200 })),
    });
    const provider = createVolcEngineLipSyncProvider(deps);
    await expect(
      provider.generateTalkingHead({ providerAvatarId: FOOTAGE_KEY, scriptText: "测试" }),
    ).rejects.toThrow(/video_url 无法下载/);
  });

  it("generateTalkingHead throws on a non-2xx submit response", async () => {
    const deps = makeDeps({
      fetchImpl: vi.fn(async () => new Response("Unauthorized", { status: 401 })),
    });
    const provider = createVolcEngineLipSyncProvider(deps);
    await expect(
      provider.generateTalkingHead({ providerAvatarId: FOOTAGE_KEY, scriptText: "测试" }),
    ).rejects.toThrow(/401/);
  });

  it("generateTalkingHead throws on a non-JSON submit response", async () => {
    const deps = makeDeps({
      fetchImpl: vi.fn(async () => new Response("<html>502</html>", { status: 200 })),
    });
    const provider = createVolcEngineLipSyncProvider(deps);
    await expect(
      provider.generateTalkingHead({ providerAvatarId: FOOTAGE_KEY, scriptText: "测试" }),
    ).rejects.toThrow(/非 JSON/);
  });

  it("synthesizeSpeech delegates to doubao tts with the profile voice", async () => {
    const deps = makeDeps();
    const provider = createVolcEngineLipSyncProvider(deps);
    const result = await provider.synthesizeSpeech({ providerVoiceId: "voice_b", text: "画外音测试" });
    expect(deps.synthesizeSpeechFn).toHaveBeenCalledWith({ text: "画外音测试", voice: "voice_b" });
    expect(result.audioStorageKey).toBe("voices/tts_fake.mp3");
  });

  it("refreshConsent and legacy createAvatar throw actionable errors", async () => {
    const provider = createVolcEngineLipSyncProvider(makeDeps());
    await expect(provider.refreshConsent({ groupId: "x" })).rejects.toThrow(/无需授权/);
    await expect(provider.createAvatar({ trainingVideoAssetId: "", ownerId: "o" })).rejects.toThrow(/平台公共形象/);
  });

  it("word timestamps stay within the audio duration (seconds-unit tripwire)", async () => {
    const provider = createVolcEngineLipSyncProvider(makeDeps());
    const result = await provider.generateTalkingHead({ providerAvatarId: FOOTAGE_KEY, scriptText: "测试" });
    const lastEnd = Math.max(...(result.words ?? []).map((w) => w.endSec));
    expect(lastEnd).toBeLessThanOrEqual(result.durationSeconds + 0.2);
  });
});
