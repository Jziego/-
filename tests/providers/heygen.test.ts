import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

// Mock putObjectFromBuffer so tests never touch real S3.
const { putObjectFromBufferMock } = vi.hoisted(() => ({
  putObjectFromBufferMock: vi.fn(),
}));
vi.mock("@/lib/storage", () => ({
  putObjectFromBuffer: putObjectFromBufferMock,
}));

// Mock global fetch (HeyGen API + video download).
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("heygen provider", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("AVATAR_PROVIDER_API_KEY", "hk_test_key");
    vi.stubEnv("HEYGEN_POLL_INTERVAL_MS", "1"); // keep tests fast (must be > 0)
    vi.stubEnv("HEYGEN_POLL_MAX_ATTEMPTS", "60");
    putObjectFromBufferMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("createAvatar uses HEYGEN_AVATAR_TEMPLATE_ID + HEYGEN_VOICE_ID when set", async () => {
    vi.stubEnv("HEYGEN_AVATAR_TEMPLATE_ID", "tpl_123");
    vi.stubEnv("HEYGEN_VOICE_ID", "v_42");

    const { createHeyGenProvider } = await import("@/lib/services/providers/heygen");
    const provider = createHeyGenProvider();

    const result = await provider.createAvatar({
      trainingVideoAssetId: "asset_1",
      ownerId: "owner_1",
    });

    expect(result).toEqual({ providerAvatarId: "tpl_123", providerVoiceId: "v_42" });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("generateTalkingHead creates via v3, polls, downloads, uploads to R2", async () => {
    // No HEYGEN_AVATAR_TEMPLATE_ID here → the input providerAvatarId/voiceId are
    // sent to HeyGen (the template-override path has its own test below).

    // 1) POST /v3/videos -> video_id
    // 2) GET /v3/videos/{id} -> processing
    // 3) GET /v3/videos/{id} -> completed (video_url + duration)
    // 4) GET video_url -> binary bytes
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ data: { video_id: "vid_abc" } }))
      .mockResolvedValueOnce(jsonResponse({ data: { status: "processing" } }))
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            status: "completed",
            video_url: "https://cdn.heygen.com/v.mp4",
            duration: 12,
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }),
      );

    const { createHeyGenProvider } = await import("@/lib/services/providers/heygen");
    const provider = createHeyGenProvider();

    const result = await provider.generateTalkingHead({
      providerAvatarId: "avatar_1",
      providerVoiceId: "voice_1",
      scriptText: "欢迎光临本店",
    });

    // Create call: v3 endpoint, flat body, X-Api-Key header.
    const createCall = mockFetch.mock.calls[0];
    expect(createCall[0]).toBe("https://api.heygen.com/v3/videos");
    expect(createCall[1]).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({ "X-Api-Key": "hk_test_key" }),
    });
    const createBody = JSON.parse(createCall[1].body as string);
    expect(createBody).toMatchObject({
      type: "avatar",
      avatar_id: "avatar_1",
      voice_id: "voice_1",
      script: "欢迎光临本店",
    });

    // Status poll used GET on the v3 video resource.
    const pollCall = mockFetch.mock.calls[1];
    expect(pollCall[0]).toBe("https://api.heygen.com/v3/videos/vid_abc");
    expect(pollCall[1]).toMatchObject({ method: "GET" });

    // Downloaded bytes were uploaded to our R2, and we return our storage key.
    expect(putObjectFromBufferMock).toHaveBeenCalledTimes(1);
    const [storageKey, bytes, contentType] = putObjectFromBufferMock.mock.calls[0];
    expect(storageKey).toMatch(/^avatars\//);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(contentType).toBe("video/mp4");
    expect(result.videoAssetId).toBe(storageKey);
    expect(result.durationSeconds).toBe(12);
  });

  it("generateTalkingHead sends the profile's own ids (no env template override)", async () => {
    // Phase 3：providerAvatarId 为权威（spec §6.3）。即使 env 配了模板也不得覆盖——
    // 模板只通过「平台公共形象」profile 进入合成。
    vi.stubEnv("HEYGEN_AVATAR_TEMPLATE_ID", "tpl_REAL");
    vi.stubEnv("HEYGEN_VOICE_ID", "v_REAL");

    mockFetch
      .mockResolvedValueOnce(jsonResponse({ data: { video_id: "vid_own" } }))
      .mockResolvedValueOnce(
        jsonResponse({ data: { status: "completed", video_url: "https://cdn/o.mp4", duration: 8 } }),
      )
      .mockResolvedValueOnce(new Response(new Uint8Array([7, 8, 9]), { status: 200 }));

    const { createHeyGenProvider } = await import("@/lib/services/providers/heygen");
    await createHeyGenProvider().generateTalkingHead({
      providerAvatarId: "look_user_1",
      providerVoiceId: "voice_user_1",
      scriptText: "x",
    });

    const createBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(createBody.avatar_id).toBe("look_user_1");
    expect(createBody.voice_id).toBe("voice_user_1");
  });

  it("throws when HeyGen reports status failed (no upload)", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ data: { video_id: "vid_fail" } }))
      .mockResolvedValueOnce(
        jsonResponse({
          data: { status: "failed", failure_message: "invalid avatar" },
        }),
      );

    const { createHeyGenProvider } = await import("@/lib/services/providers/heygen");
    const provider = createHeyGenProvider();

    await expect(
      provider.generateTalkingHead({ providerAvatarId: "bad", scriptText: "x" }),
    ).rejects.toThrow("invalid avatar");

    expect(putObjectFromBufferMock).not.toHaveBeenCalled();
  });

  it("throws on polling timeout (max attempts exceeded while processing)", async () => {
    vi.stubEnv("HEYGEN_POLL_MAX_ATTEMPTS", "3");

    // Same body for create (reads video_id) and every poll (reads status).
    // mockImplementation so each call gets a fresh Response (bodies are single-use).
    mockFetch.mockImplementation(async () =>
      jsonResponse({ data: { video_id: "vid_t", status: "processing" } }),
    );

    const { createHeyGenProvider } = await import("@/lib/services/providers/heygen");
    const provider = createHeyGenProvider();

    await expect(
      provider.generateTalkingHead({ providerAvatarId: "a", scriptText: "x" }),
    ).rejects.toThrow(/timed out|timeout/i);

    expect(putObjectFromBufferMock).not.toHaveBeenCalled();
  });

  it("throws on API error response from create", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ error: { message: "Invalid avatar_id" } }, 400),
    );

    const { createHeyGenProvider } = await import("@/lib/services/providers/heygen");
    const provider = createHeyGenProvider();

    await expect(
      provider.generateTalkingHead({ providerAvatarId: "bad_id", scriptText: "test" }),
    ).rejects.toThrow("Invalid avatar_id");
  });

  it("invokes onProgress during polling with (attempt, maxAttempts)", async () => {
    vi.stubEnv("HEYGEN_POLL_MAX_ATTEMPTS", "5");
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ data: { video_id: "vid_p" } }))
      .mockResolvedValueOnce(jsonResponse({ data: { status: "processing" } }))
      .mockResolvedValueOnce(
        jsonResponse({ data: { status: "completed", video_url: "https://cdn/x.mp4", duration: 5 } }),
      )
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2]), { status: 200 }));

    const onProgress = vi.fn();
    const { createHeyGenProvider } = await import("@/lib/services/providers/heygen");
    await createHeyGenProvider().generateTalkingHead(
      { providerAvatarId: "a", scriptText: "x" },
      onProgress,
    );

    expect(onProgress).toHaveBeenCalled();
    // every call passes the configured maxAttempts as the 2nd arg
    for (const call of onProgress.mock.calls) {
      expect(call[1]).toBe(5);
    }
    expect(onProgress.mock.calls[0][0]).toBeGreaterThanOrEqual(1);
  });

  it("createDigitalTwin downloads footage, uploads as HeyGen asset, then creates with asset_id", async () => {
    mockFetch
      // 1. 从 R2 预签名 URL 下载训练视频（非 HeyGen 域，无 X-Api-Key）
      .mockResolvedValueOnce(new Response(new Uint8Array([9, 8, 7]), { status: 200 }))
      // 2. 直传 POST /v3/assets → asset_id（绕开 URL 输入的大小上限——93.7MB 实测被拒）
      .mockResolvedValueOnce(jsonResponse({ data: { asset_id: "ast_1" } }))
      // 3. 用 asset_id 创建 digital_twin —— 官方文档实测形状：嵌套
      //    avatar_item/avatar_group（2026-09-05 事故：按扁平 group_id 解析导致
      //    创建其实成功却报 "no group id"，HeyGen 侧留下孤儿分组占住槽位）
      .mockResolvedValueOnce(jsonResponse({
        data: {
          avatar_item: { id: "look_1", group_id: "grp_1", name: "店主" },
          avatar_group: { id: "grp_1", name: "店主", consent_status: null },
        },
      }))
      // 4. 取授权链接
      .mockResolvedValueOnce(jsonResponse({ data: { url: "https://consent.heygen.com/abc" } }));

    const { createHeyGenProvider } = await import("@/lib/services/providers/heygen");
    const result = await createHeyGenProvider().createDigitalTwin({
      name: "店主",
      footageUrl: "https://cdn.example.com/f.mp4",
    });

    expect(result).toEqual({ groupId: "grp_1", consentUrl: "https://consent.heygen.com/abc" });
    const [downloadCall, uploadCall, createCall, consentCall] = mockFetch.mock.calls;
    expect(downloadCall[0]).toBe("https://cdn.example.com/f.mp4");
    expect(downloadCall[1]?.headers).toBeUndefined();
    expect(uploadCall[0]).toBe("https://api.heygen.com/v3/assets");
    expect(uploadCall[1].method).toBe("POST");
    expect(uploadCall[1].headers).toMatchObject({ "X-Api-Key": "hk_test_key" });
    // multipart：body 是 FormData，且不得手设 JSON Content-Type（fetch 自动带 boundary）
    expect(uploadCall[1].body).toBeInstanceOf(FormData);
    expect(uploadCall[1].headers["Content-Type"]).toBeUndefined();
    const createBody = JSON.parse(createCall[1].body as string);
    expect(createBody).toMatchObject({
      type: "digital_twin",
      name: "店主",
      file: { type: "asset_id", asset_id: "ast_1" },
    });
    expect(consentCall[0]).toBe("https://api.heygen.com/v3/avatars/grp_1/consent");
  });

  it("createDigitalTwin throws when the footage download fails", async () => {
    mockFetch.mockResolvedValueOnce(new Response("forbidden", { status: 403 }));
    const { createHeyGenProvider } = await import("@/lib/services/providers/heygen");
    await expect(
      createHeyGenProvider().createDigitalTwin({ name: "x", footageUrl: "https://cdn.example.com/f.mp4" }),
    ).rejects.toThrow(/download failed: 403/i);
  });

  it("createDigitalTwin throws the envelope error when HeyGen returns 200 + error body", async () => {
    // HeyGen 部分端点 HTTP 200 但 body 里带 error——不检查的话 data=undefined
    // 会被吞成莫名其妙的 "no group id"，真实原因（如 footage 不合格）永远看不到。
    mockFetch
      .mockResolvedValueOnce(new Response(new Uint8Array([9]), { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({ data: { asset_id: "ast_1" } }))
      .mockResolvedValueOnce(jsonResponse({ error: { code: "invalid_parameter", message: "footage rejected" } }));
    const { createHeyGenProvider } = await import("@/lib/services/providers/heygen");
    await expect(
      createHeyGenProvider().createDigitalTwin({ name: "x", footageUrl: "https://cdn.example.com/f.mp4" }),
    ).rejects.toThrow("footage rejected");
  });

  it("createDigitalTwin still accepts a flat group_id (defensive fallback)", async () => {
    mockFetch
      .mockResolvedValueOnce(new Response(new Uint8Array([9]), { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({ data: { asset_id: "ast_1" } }))
      .mockResolvedValueOnce(jsonResponse({ data: { group_id: "grp_flat" } }))
      .mockResolvedValueOnce(jsonResponse({ data: { url: "https://consent.heygen.com/x" } }));
    const { createHeyGenProvider } = await import("@/lib/services/providers/heygen");
    const result = await createHeyGenProvider().createDigitalTwin({ name: "x", footageUrl: "https://cdn.example.com/f.mp4" });
    expect(result.groupId).toBe("grp_flat");
  });

  it("createDigitalTwin includes the truncated raw response when the shape drifts again", async () => {
    // 反失明兜底：形状再变也要在日志里留下真身，而不是一句 "no group id"。
    mockFetch
      .mockResolvedValueOnce(new Response(new Uint8Array([9]), { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({ data: { asset_id: "ast_1" } }))
      .mockResolvedValueOnce(jsonResponse({ data: { totally_new_field: "shape_xyz" } }));
    const { createHeyGenProvider } = await import("@/lib/services/providers/heygen");
    await expect(
      createHeyGenProvider().createDigitalTwin({ name: "x", footageUrl: "https://cdn.example.com/f.mp4" }),
    ).rejects.toThrow(/totally_new_field/);
  });

  it("createDigitalTwin throws when the asset upload returns no asset_id", async () => {
    mockFetch
      .mockResolvedValueOnce(new Response(new Uint8Array([9]), { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({ data: {} }));
    const { createHeyGenProvider } = await import("@/lib/services/providers/heygen");
    await expect(
      createHeyGenProvider().createDigitalTwin({ name: "x", footageUrl: "https://cdn.example.com/f.mp4" }),
    ).rejects.toThrow(/asset_id/i);
  });

  it("getDigitalTwinStatus maps group fields to the normalized state machine", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: {
          consent_status: "approved",
          status: "completed",
          looks: [{ id: "look_1" }],
          voice_id: "voice_1",
        },
      }),
    );
    const { createHeyGenProvider } = await import("@/lib/services/providers/heygen");
    const status = await createHeyGenProvider().getDigitalTwinStatus({ groupId: "grp_1" });
    // Task 0 实测：状态轮询走 /v3/avatars/{group_id}（/v3/avatar_groups 路由不存在）
    expect(mockFetch.mock.calls[0][0]).toBe("https://api.heygen.com/v3/avatars/grp_1");
    expect(status).toMatchObject({
      consentStatus: "approved",
      trainingStatus: "ready",
      providerAvatarId: "look_1",
      providerVoiceId: "voice_1",
    });
  });

  it("getDigitalTwinStatus falls back to default_voice_id (文档里的实际字段名)", async () => {
    // 官方文档的 group 资源示例里声音字段是 default_voice_id，不是 voice_id——
    // 读不到会导致画外音段克隆声音 TTS 失声。
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: {
          consent_status: "approved",
          status: "completed",
          looks: [{ id: "look_1" }],
          default_voice_id: "voice_d1",
        },
      }),
    );
    const { createHeyGenProvider } = await import("@/lib/services/providers/heygen");
    const status = await createHeyGenProvider().getDigitalTwinStatus({ groupId: "grp_1" });
    expect(status.providerVoiceId).toBe("voice_d1");
  });

  it("getDigitalTwinStatus maps rejected consent to failed with a reason", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: { consent_status: "rejected", status: "failed", reject_reason: "face mismatch" } }),
    );
    const { createHeyGenProvider } = await import("@/lib/services/providers/heygen");
    const status = await createHeyGenProvider().getDigitalTwinStatus({ groupId: "g" });
    expect(status.consentStatus).toBe("rejected");
    expect(status.trainingStatus).toBe("failed");
    expect(status.reason).toContain("face mismatch");
  });

  it("synthesizeSpeech posts to voices/speech, downloads audio to R2, normalizes ms timestamps", async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            audio_url: "https://cdn.heygen.com/a.mp3",
            duration: 1.5,
            word_timestamps: [
              { word: "你好", start: 0, end: 500 },
              { word: "欢迎", start: 500, end: 1500 },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));

    const { createHeyGenProvider } = await import("@/lib/services/providers/heygen");
    const speech = await createHeyGenProvider().synthesizeSpeech({
      providerVoiceId: "voice_1",
      text: "你好欢迎",
    });

    const call = mockFetch.mock.calls[0];
    expect(call[0]).toBe("https://api.heygen.com/v3/voices/speech");
    expect(JSON.parse(call[1].body as string)).toMatchObject({ voice_id: "voice_1", text: "你好欢迎" });
    expect(putObjectFromBufferMock).toHaveBeenCalledTimes(1);
    // Task 0 实测：TTS 音频是 .wav
    expect(putObjectFromBufferMock.mock.calls[0][2]).toBe("audio/wav");
    expect(speech.audioStorageKey).toMatch(/^voices\//);
    expect(speech.audioStorageKey).toMatch(/\.wav$/);
    expect(speech.durationSeconds).toBe(1.5);
    // 防御性 ms → s 归一化（真 API 已确认为秒；此用例覆盖异常 ms 形状）
    expect(speech.words[1]).toEqual({ word: "欢迎", startSec: 0.5, endSec: 1.5 });
  });

  it("getDigitalTwinStatus throws on envelope-level error (no silent awaiting_user)", async () => {
    // 200 + {error:{...}} 时 res.data 为 undefined——必须抛错而非吞成永久 pending
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: null, error: { message: "forbidden" } }));
    const { createHeyGenProvider } = await import("@/lib/services/providers/heygen");
    await expect(
      createHeyGenProvider().getDigitalTwinStatus({ groupId: "g" }),
    ).rejects.toThrow("forbidden");
  });

  it("getDigitalTwinStatus never reports ready without approved consent", async () => {
    // consent 未知 + status=completed：ready 是终态（停止轮询），无 approved consent
    // 时上报 ready 会让 profile 永久卡死在无 providerAvatarId 的状态
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: { status: "completed", looks: [{ id: "look_1" }] } }),
    );
    const { createHeyGenProvider } = await import("@/lib/services/providers/heygen");
    const status = await createHeyGenProvider().getDigitalTwinStatus({ groupId: "g" });
    expect(status.consentStatus).toBe("awaiting_user");
    expect(status.trainingStatus).toBe("pending");
  });

  it("synthesizeSpeech passes second-unit timestamps through when duration is missing", async () => {
    // duration 缺失 → durationSec=0 → 阈值为 1，秒级数据会被误判 ms 并 /1000
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            audio_url: "https://cdn.heygen.com/a.wav",
            word_timestamps: [
              { word: "你", start: 0, end: 0.75 },
              { word: "好", start: 0.75, end: 1.5 },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200 }));

    const { createHeyGenProvider } = await import("@/lib/services/providers/heygen");
    const speech = await createHeyGenProvider().synthesizeSpeech({ providerVoiceId: "v", text: "你好" });
    expect(speech.durationSeconds).toBe(0);
    expect(speech.words[1]).toEqual({ word: "好", startSec: 0.75, endSec: 1.5 });
  });

  it("synthesizeSpeech strips <start>/<end> sentinel words from the timeline", async () => {
    // Task 0 实测：中文按字粒度、秒单位，首尾各有一个零时长哨兵词
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            audio_url: "https://cdn.heygen.com/a.wav",
            duration: 1,
            word_timestamps: [
              { word: "<start>", start: 0, end: 0 },
              { word: "你", start: 0, end: 0.5 },
              { word: "好", start: 0.5, end: 1 },
              { word: "<end>", start: 1, end: 1 },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200 }));

    const { createHeyGenProvider } = await import("@/lib/services/providers/heygen");
    const speech = await createHeyGenProvider().synthesizeSpeech({ providerVoiceId: "v", text: "你好" });
    expect(speech.words).toEqual([
      { word: "你", startSec: 0, endSec: 0.5 },
      { word: "好", startSec: 0.5, endSec: 1 },
    ]);
  });
});
