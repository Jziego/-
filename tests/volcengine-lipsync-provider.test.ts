import { describe, expect, it, vi, afterEach } from "vitest";
import { createVolcEngineLipSyncProvider } from "@/lib/services/providers/volcengine-lipsync";

const FOOTAGE_KEY = "stores/store_1/assets/asset_1-me.mp4";
const FOOTAGE_BYTES = new Uint8Array([9, 9, 9]);
const TTS_BYTES = new Uint8Array([7, 7]);

/** MediaKit 响应帧工厂。 */
function mediakitSubmitOk(taskId = "amk-tool-lip-sync-1") {
  return new Response(JSON.stringify({ task_id: taskId }), { status: 200 });
}
function mediakitUploadApplyOk(fileId: string) {
  return new Response(
    JSON.stringify({
      success: true,
      result: {
        file_id: fileId,
        upload_url: `https://mediakit.example/upload/${fileId}`,
        upload_headers: [{ key: "x-upload-flag", value: "1" }],
      },
    }),
    { status: 200 },
  );
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

/**
 * 上传+任务全链路正常的路由 mock（各测试按需覆盖 submit/task/download 单点）。
 * 上传 apply 顺序恒定：先视频后音频（实现为顺序上传）。
 */
function makeMediakitRouter(overrides: {
  apply?: (fileId: string) => Response;
  put?: (url: string) => Response;
  submit?: () => Response;
  task?: () => Response;
  download?: () => Response;
} = {}) {
  let applies = 0;
  return vi.fn(async (url: string) => {
    if (url.includes("/api/v1/tools-sync/request-media-upload-url")) {
      applies++;
      const fileId = applies === 1 ? "fid-video" : "fid-audio";
      return overrides.apply ? overrides.apply(fileId) : mediakitUploadApplyOk(fileId);
    }
    if (url.startsWith("https://mediakit.example/upload/")) {
      return overrides.put ? overrides.put(url) : new Response("ok", { status: 200 });
    }
    if (url.includes("/api/v1/tools/lip-sync")) return overrides.submit?.() ?? mediakitSubmitOk();
    if (url.includes("/api/v1/tasks/")) return overrides.task?.() ?? mediakitTaskCompleted();
    if (url === "https://mediakit.example/result.mp4") {
      return overrides.download?.() ?? new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    fetchImpl: makeMediakitRouter(),
    synthesizeSpeechFn: vi.fn(async () => ({
      audioStorageKey: "voices/tts_fake.mp3",
      audioBytes: TTS_BYTES,
      durationSeconds: 12.3,
      words: [{ word: "大", startSec: 0, endSec: 0.2 }],
    })),
    getObjectBytes: vi.fn(async (_key: string) => FOOTAGE_BYTES),
    putObject: vi.fn(async () => undefined),
    pollIntervalMs: 1,
    pollTimeoutMs: 10_000,
    apiKey: "test-mediakit-key",
    ...overrides,
  };
}

/** 从 fetchImpl mock 里捞出媒体 PUT 调用（[url, init]）。 */
function uploadPutCalls(fetchImpl: unknown): [string, RequestInit][] {
  return (fetchImpl as ReturnType<typeof vi.fn>).mock.calls.filter(([url]) =>
    String(url).startsWith("https://mediakit.example/upload/"),
  ) as unknown as [string, RequestInit][];
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

  it("generateTalkingHead: TTS → 字节直传换 file_id → lip-sync submit → poll → download → R2, with words + duration", async () => {
    const deps = makeDeps();
    const provider = createVolcEngineLipSyncProvider(deps);
    const onProgress = vi.fn();

    const result = await provider.generateTalkingHead(
      { providerAvatarId: FOOTAGE_KEY, providerVoiceId: "voice_a", scriptText: "大家好，本周全场八八折" },
      onProgress,
    );

    // TTS 用形象的声音
    expect(deps.synthesizeSpeechFn).toHaveBeenCalledWith({ text: "大家好，本周全场八八折", voice: "voice_a" });
    // 底板字节从 R2 服务端直拉（不经公网 presigned URL）
    expect(deps.getObjectBytes).toHaveBeenCalledWith(FOOTAGE_KEY);
    // 两次媒体 PUT：先视频后音频，各带火山要求的额外上传头与原始字节
    const puts = uploadPutCalls(deps.fetchImpl);
    expect(puts).toHaveLength(2);
    expect(puts[0][0]).toBe("https://mediakit.example/upload/fid-video");
    expect((puts[0][1].headers as Record<string, string>)["Content-Type"]).toBe("video/mp4");
    expect((puts[0][1].headers as Record<string, string>)["x-upload-flag"]).toBe("1");
    expect(puts[0][1].body as unknown as Uint8Array).toEqual(FOOTAGE_BYTES);
    expect(puts[1][0]).toBe("https://mediakit.example/upload/fid-audio");
    expect((puts[1][1].headers as Record<string, string>)["Content-Type"]).toBe("audio/mpeg");
    expect(puts[1][1].body as unknown as Uint8Array).toEqual(TTS_BYTES);
    // MediaKit 提交体：file_id 而非 URL + 恒 enable_video_loop
    const submitCall = (deps.fetchImpl as ReturnType<typeof vi.fn>).mock.calls.find(([url]) =>
      String(url).includes("/api/v1/tools/lip-sync"),
    ) as unknown as [string, RequestInit];
    const submitBody = JSON.parse(String(submitCall[1].body));
    expect(submitBody).toEqual({
      video_url: "fid-video",
      audio_url: "fid-audio",
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

  it("generateTalkingHead throws protocol-drift when the upload-apply response lacks file_id/upload_url", async () => {
    const deps = makeDeps({
      fetchImpl: makeMediakitRouter({
        apply: () => new Response(JSON.stringify({ success: true, result: {} }), { status: 200 }),
      }),
    });
    const provider = createVolcEngineLipSyncProvider(deps);
    await expect(
      provider.generateTalkingHead({ providerAvatarId: FOOTAGE_KEY, scriptText: "测试" }),
    ).rejects.toThrow(/协议漂移/);
  });

  it("generateTalkingHead throws when the media PUT to the upload URL fails", async () => {
    const deps = makeDeps({
      fetchImpl: makeMediakitRouter({ put: () => new Response("boom", { status: 500 }) }),
    });
    const provider = createVolcEngineLipSyncProvider(deps);
    await expect(
      provider.generateTalkingHead({ providerAvatarId: FOOTAGE_KEY, scriptText: "测试" }),
    ).rejects.toThrow(/媒体上传失败 HTTP 500/);
  });

  it("generateTalkingHead rejects zero-byte footage before requesting any upload URL", async () => {
    const deps = makeDeps({ getObjectBytes: vi.fn(async () => new Uint8Array([])) });
    const provider = createVolcEngineLipSyncProvider(deps);
    await expect(
      provider.generateTalkingHead({ providerAvatarId: FOOTAGE_KEY, scriptText: "测试" }),
    ).rejects.toThrow(/为空/);
    const applies = (deps.fetchImpl as ReturnType<typeof vi.fn>).mock.calls.filter(([url]) =>
      String(url).includes("request-media-upload-url"),
    );
    expect(applies).toHaveLength(0);
  });

  it("generateTalkingHead falls back to the TTS duration when the task result has no duration", async () => {
    const deps = makeDeps({
      fetchImpl: makeMediakitRouter({
        task: () => new Response(
          JSON.stringify({ status: "completed", result: { video_url: "https://mediakit.example/result.mp4" } }),
          { status: 200 },
        ),
      }),
    });
    const provider = createVolcEngineLipSyncProvider(deps);
    const result = await provider.generateTalkingHead({ providerAvatarId: FOOTAGE_KEY, scriptText: "测试" });
    expect(result.durationSeconds).toBe(12.3);
  });

  it("generateTalkingHead falls back to the TTS duration when the task result duration is 0", async () => {
    const deps = makeDeps({
      fetchImpl: makeMediakitRouter({
        task: () => new Response(
          JSON.stringify({ status: "completed", result: { video_url: "https://mediakit.example/result.mp4", duration: 0 } }),
          { status: 200 },
        ),
      }),
    });
    const provider = createVolcEngineLipSyncProvider(deps);
    const result = await provider.generateTalkingHead({ providerAvatarId: FOOTAGE_KEY, scriptText: "测试" });
    expect(result.durationSeconds).toBe(12.3);
  });

  it("generateTalkingHead rejects a zero-byte artifact download", async () => {
    const deps = makeDeps({
      fetchImpl: makeMediakitRouter({ download: () => new Response(new Uint8Array([]), { status: 200 }) }),
    });
    const provider = createVolcEngineLipSyncProvider(deps);
    await expect(
      provider.generateTalkingHead({ providerAvatarId: FOOTAGE_KEY, scriptText: "测试" }),
    ).rejects.toThrow(/下载为空/);
    expect(deps.putObject).not.toHaveBeenCalled();
  });

  it("generateTalkingHead surfaces the provider error message when the task fails (face issues get the re-shoot hint)", async () => {
    const deps = makeDeps({
      fetchImpl: makeMediakitRouter({ task: () => mediakitTaskFailed() }),
    });
    const provider = createVolcEngineLipSyncProvider(deps);
    await expect(
      provider.generateTalkingHead({ providerAvatarId: FOOTAGE_KEY, scriptText: "测试" }),
    ).rejects.toThrow(/对口型生成失败.*未检测到单人真人脸.*重录底板/);
  });

  it("generateTalkingHead does NOT append the re-shoot hint for non-face failures (e.g. storage gateway)", async () => {
    const deps = makeDeps({
      fetchImpl: makeMediakitRouter({
        task: () => mediakitTaskFailed("run lip sync failed: prodia error: storageGW error: 500 Internal Server Error"),
      }),
    });
    const provider = createVolcEngineLipSyncProvider(deps);
    const err: unknown = await provider
      .generateTalkingHead({ providerAvatarId: FOOTAGE_KEY, scriptText: "测试" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/对口型生成失败.*storageGW/);
    expect((err as Error).message).not.toMatch(/重录底板/);
  });

  it("generateTalkingHead keeps polling through running states and reports progress", async () => {
    let taskCalls = 0;
    const deps = makeDeps({
      fetchImpl: makeMediakitRouter({
        task: () => {
          taskCalls++;
          return taskCalls < 3 ? mediakitTaskRunning() : mediakitTaskCompleted();
        },
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
      fetchImpl: makeMediakitRouter({ task: () => new Response(JSON.stringify({}), { status: 200 }) }),
    });
    const provider = createVolcEngineLipSyncProvider(deps);
    await expect(
      provider.generateTalkingHead({ providerAvatarId: FOOTAGE_KEY, scriptText: "测试" }),
    ).rejects.toThrow(/缺少 status/);
  });

  it("generateTalkingHead times out with a descriptive error", async () => {
    const deps = makeDeps({
      pollTimeoutMs: 5,
      fetchImpl: makeMediakitRouter({ task: () => mediakitTaskRunning() }),
    });
    const provider = createVolcEngineLipSyncProvider(deps);
    await expect(
      provider.generateTalkingHead({ providerAvatarId: FOOTAGE_KEY, scriptText: "测试" }),
    ).rejects.toThrow(/超时/);
  });

  it("generateTalkingHead throws when the completed task has no video_url", async () => {
    const deps = makeDeps({
      fetchImpl: makeMediakitRouter({
        task: () => new Response(JSON.stringify({ status: "completed", result: {} }), { status: 200 }),
      }),
    });
    const provider = createVolcEngineLipSyncProvider(deps);
    await expect(
      provider.generateTalkingHead({ providerAvatarId: FOOTAGE_KEY, scriptText: "测试" }),
    ).rejects.toThrow(/video_url/);
  });

  it("generateTalkingHead throws on a submit-level API error envelope", async () => {
    const deps = makeDeps({
      fetchImpl: makeMediakitRouter({
        submit: () =>
          new Response(JSON.stringify({ success: false, error: { code: "InvalidParam", message: "video_url 无法下载", param: "video_url", type: "invalid" } }), { status: 200 }),
      }),
    });
    const provider = createVolcEngineLipSyncProvider(deps);
    await expect(
      provider.generateTalkingHead({ providerAvatarId: FOOTAGE_KEY, scriptText: "测试" }),
    ).rejects.toThrow(/video_url 无法下载/);
  });

  it("generateTalkingHead throws on a non-2xx submit response", async () => {
    const deps = makeDeps({
      fetchImpl: makeMediakitRouter({ submit: () => new Response("Unauthorized", { status: 401 }) }),
    });
    const provider = createVolcEngineLipSyncProvider(deps);
    await expect(
      provider.generateTalkingHead({ providerAvatarId: FOOTAGE_KEY, scriptText: "测试" }),
    ).rejects.toThrow(/401/);
  });

  it("generateTalkingHead throws on a non-JSON submit response", async () => {
    const deps = makeDeps({
      fetchImpl: makeMediakitRouter({ submit: () => new Response("<html>502</html>", { status: 200 }) }),
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

  it("clamps a zero poll interval instead of spinning forever", async () => {
    const deps = makeDeps({
      pollIntervalMs: 0,
      pollTimeoutMs: 5,
      fetchImpl: makeMediakitRouter({ task: () => mediakitTaskRunning() }),
    });
    const provider = createVolcEngineLipSyncProvider(deps);
    await expect(
      provider.generateTalkingHead({ providerAvatarId: FOOTAGE_KEY, scriptText: "测试" }),
    ).rejects.toThrow(/超时/);
  });

  it("throws MEDIKIT_API_KEY not configured at call time when the key is missing", async () => {
    vi.stubEnv("MEDIKIT_API_KEY", "");
    const provider = createVolcEngineLipSyncProvider(makeDeps({ apiKey: undefined }));
    await expect(
      provider.generateTalkingHead({ providerAvatarId: FOOTAGE_KEY, scriptText: "测试" }),
    ).rejects.toThrow(/MEDIKIT_API_KEY/);
  });
});

/** CosyVoice 合成成功帧工厂（克隆音色分派/自愈用例用）。 */
function fakeSpeech() {
  return {
    audioStorageKey: "voices/x.mp3",
    audioBytes: new Uint8Array([1]),
    durationSeconds: 1,
    words: [] as { word: string; startSec: number; endSec: number }[],
  };
}

describe("声音克隆（getDigitalTwinStatus）", () => {
  it("生产模式：内联复刻（抽样本→创建→轮询OK）→ ready + providerVoiceId", async () => {
    const calls: string[] = [];
    const provider = createVolcEngineLipSyncProvider(makeDeps({
      extractSampleFn: async () => { calls.push("extract"); return { wavBytes: new Uint8Array([1]), durationSec: 20 }; },
      createVoiceFn: async () => { calls.push("create"); return "cosyvoice-v3.5-plus-av1-xyz"; },
      waitVoiceReadyFn: async () => { calls.push("wait"); },
      hasCosyvoiceFn: () => true,
    }));
    const status = await provider.getDigitalTwinStatus({ groupId: "lipsync:footage/key.mp4" });
    expect(status.trainingStatus).toBe("ready");
    expect(status.providerVoiceId).toBe("cosyvoice-v3.5-plus-av1-xyz");
    expect(calls).toEqual(["extract", "create", "wait"]);
  });

  it("复刻失败 → failed + 原因透出（不重试）", async () => {
    const provider = createVolcEngineLipSyncProvider(makeDeps({
      extractSampleFn: async () => ({ wavBytes: new Uint8Array([1]), durationSec: 20 }),
      createVoiceFn: async () => { throw new Error("百炼 create_voice 失败：AudioShortError"); },
      hasCosyvoiceFn: () => true,
    }));
    const status = await provider.getDigitalTwinStatus({ groupId: "lipsync:footage/key.mp4" });
    expect(status.trainingStatus).toBe("failed");
    expect(status.reason).toContain("AudioShortError");
  });

  it("demo 模式（无百炼 Key）：保持现状——立即 ready + env 豆包音色", async () => {
    const provider = createVolcEngineLipSyncProvider(makeDeps({ hasCosyvoiceFn: () => false }));
    const status = await provider.getDigitalTwinStatus({ groupId: "lipsync:footage/key.mp4" });
    expect(status.trainingStatus).toBe("ready");
    expect(status.providerVoiceId).toMatch(/^zh_female/); // env 默认豆包女声
  });
});

describe("声音克隆（TTS 分派与自愈）", () => {
  it("cosyvoice- 前缀 voice → 走 CosyVoice 合成", async () => {
    let cosyUsed = false;
    const provider = createVolcEngineLipSyncProvider(makeDeps({
      cosySynthesizeFn: async () => { cosyUsed = true; return fakeSpeech(); },
      hasCosyvoiceFn: () => true,
    }));
    await provider.generateTalkingHead({ providerAvatarId: "footage/key.mp4", providerVoiceId: "cosyvoice-v3.5-plus-av1-x", scriptText: "大家好" });
    expect(cosyUsed).toBe(true);
  });

  it("生产模式 + 非克隆音色 → fail-fast（形象声音未就绪）", async () => {
    const provider = createVolcEngineLipSyncProvider(makeDeps({ hasCosyvoiceFn: () => true }));
    await expect(
      provider.generateTalkingHead({ providerAvatarId: "footage/key.mp4", providerVoiceId: "zh_female_x", scriptText: "大家好" }),
    ).rejects.toThrow(/声音未就绪/);
  });

  it("音色被清理（合成失败且 queryVoice=null）→ 重建并重试一次", async () => {
    let synthCalls = 0;
    let rebuilt = false;
    const provider = createVolcEngineLipSyncProvider(makeDeps({
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
    }));
    await provider.generateTalkingHead({ providerAvatarId: "footage/key.mp4", providerVoiceId: "cosyvoice-v3.5-plus-old-x", scriptText: "大家好" });
    expect(rebuilt).toBe(true);
    expect(synthCalls).toBe(2);
  });

  it("音色仍在（queryVoice 非 null）的合成失败 → 直接抛错不重建", async () => {
    const provider = createVolcEngineLipSyncProvider(makeDeps({
      cosySynthesizeFn: async () => { throw new Error("HTTP 500"); },
      queryVoiceFn: async () => ({ status: "OK" }),
      hasCosyvoiceFn: () => true,
    }));
    await expect(
      provider.generateTalkingHead({ providerAvatarId: "footage/key.mp4", providerVoiceId: "cosyvoice-v3.5-plus-av1-x", scriptText: "大家好" }),
    ).rejects.toThrow(/HTTP 500/);
  });
});
