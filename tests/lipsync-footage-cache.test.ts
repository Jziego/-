import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import {
  createVolcEngineLipSyncProvider,
  resetFootageFileIdCacheForTests,
} from "@/lib/services/providers/volcengine-lipsync";

const FOOTAGE_KEY = "stores/store_1/assets/asset_1-me.mp4";
const FOOTAGE_BYTES = new Uint8Array([9, 9, 9, 9]);
const TTS_BYTES = new Uint8Array([7, 7]);

/** PUT body 读取（fetch 调用时刻，与生产 undici 消费时机一致）。 */
async function readBodyBytes(body: unknown): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  if (body && typeof (body as Blob).arrayBuffer === "function") {
    return new Uint8Array(await (body as Blob).arrayBuffer());
  }
  return new Uint8Array(0);
}

/** MediaKit 路由 mock：apply 计数按序发 file_id；submit 立即完成；产物固定 3 字节。 */
function makeMediakitRouter() {
  let applies = 0;
  const putLog: { url: string; bytes: Uint8Array }[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/api/v1/tools-sync/request-media-upload-url")) {
      applies++;
      const fileId = applies === 1 ? "fid-video" : `fid-audio-${applies}`;
      return new Response(
        JSON.stringify({
          success: true,
          result: {
            file_id: fileId,
            upload_url: `https://mediakit.example/upload/${fileId}`,
            upload_headers: [],
          },
        }),
        { status: 200 },
      );
    }
    if (url.startsWith("https://mediakit.example/upload/")) {
      putLog.push({ url, bytes: await readBodyBytes(init?.body) });
      return new Response("ok", { status: 200 });
    }
    if (url.includes("/api/v1/tools/lip-sync")) {
      return new Response(JSON.stringify({ task_id: "amk-task-1" }), { status: 200 });
    }
    if (url.includes("/api/v1/tasks/")) {
      return new Response(
        JSON.stringify({
          status: "completed",
          result: { video_url: "https://mediakit.example/result.mp4", duration: 8 },
        }),
        { status: 200 },
      );
    }
    if (url === "https://mediakit.example/result.mp4") {
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  return Object.assign(fn, { putLog });
}

type RouterFn = ReturnType<typeof makeMediakitRouter>;

/** 统计路由里视频/音频 PUT 次数（按 Content-Type 区分）。 */
function putCountsByType(fetchImpl: unknown): { video: number; audio: number } {
  const puts = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls.filter(([url]) =>
    String(url).startsWith("https://mediakit.example/upload/"),
  ) as unknown as [string, RequestInit][];
  const count = (t: string) =>
    puts.filter(([, init]) => (init.headers as Record<string, string>)["Content-Type"] === t).length;
  return { video: count("video/mp4"), audio: count("audio/mpeg") };
}

/** 从路由 putLog 捞视频 PUT 字节（fetch 时刻已读出，不受临时文件清理影响）。 */
async function videoPutBytes(fetchImpl: unknown): Promise<Uint8Array> {
  const entry = (fetchImpl as RouterFn).putLog.find((p) => p.url.includes("/fid-video"));
  if (!entry) throw new Error("video PUT not captured");
  return entry.bytes;
}

/** 捞出 lip-sync 提交体（验证两次调用复用同一 file_id）。 */
function submitBodies(fetchImpl: unknown): { video_url: string; audio_url: string }[] {
  return (fetchImpl as ReturnType<typeof vi.fn>).mock.calls
    .filter(([url]) => String(url).includes("/api/v1/tools/lip-sync"))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { video_url: string; audio_url: string });
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  const getObjectToFileFn = vi.fn(async (_key: string, destPath: string) => {
    await writeFile(destPath, FOOTAGE_BYTES);
  });
  return {
    fetchImpl: makeMediakitRouter(),
    synthesizeSpeechFn: vi.fn(async () => ({
      audioStorageKey: "voices/tts_fake.mp3",
      audioBytes: TTS_BYTES,
      durationSeconds: 8,
      words: [],
    })),
    // enrollVoice 路径仍用字节下载；本文件的用例不触发复刻，仅为缺省补齐
    getObjectBytes: vi.fn(async () => FOOTAGE_BYTES),
    getObjectToFileFn,
    putObject: vi.fn(async () => undefined),
    pollIntervalMs: 1,
    pollTimeoutMs: 10_000,
    apiKey: "test-mediakit-key",
    ...overrides,
  };
}

describe("底板 file_id 进程内缓存（资源治理 Task B）", () => {
  beforeEach(() => {
    resetFootageFileIdCacheForTests();
  });

  it("同一底板跨 provider 实例只下载+上传一次（工厂每段新建，缓存须在模块级）", async () => {
    const deps = makeDeps();
    // talking-head 分段路径每段都 createProviderByName 新建 provider——
    // 用两个独立实例模拟相邻 onCamera 段，验证缓存确实跨实例去重。
    const providerA = createVolcEngineLipSyncProvider(deps);
    const providerB = createVolcEngineLipSyncProvider(deps);

    await providerA.generateTalkingHead({ providerAvatarId: FOOTAGE_KEY, scriptText: "第一段" });
    await providerB.generateTalkingHead({ providerAvatarId: FOOTAGE_KEY, scriptText: "第二段" });

    expect(deps.getObjectToFileFn).toHaveBeenCalledTimes(1);
    expect(deps.getObjectToFileFn).toHaveBeenCalledWith(FOOTAGE_KEY, expect.any(String));
    const puts = putCountsByType(deps.fetchImpl);
    expect(puts.video).toBe(1); // 底板只传一次
    expect(puts.audio).toBe(2); // 音频每次照常上传
    // 两次 submit 复用同一底板 file_id，音频 file_id 各自独立
    const bodies = submitBodies(deps.fetchImpl);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.video_url).toBe("fid-video");
    expect(bodies[1]?.video_url).toBe("fid-video");
    expect(bodies[0]?.audio_url).not.toBe(bodies[1]?.audio_url);
  });

  it("下载失败即时清缓存：重试会重新下载并成功（spy 计数 2）", async () => {
    const getObjectToFileFn = vi
      .fn<(...args: unknown[]) => Promise<void>>()
      .mockRejectedValueOnce(new Error("NoSuchKey: footage missing"))
      .mockImplementation(async (_key: unknown, destPath: unknown) => {
        await writeFile(destPath as string, FOOTAGE_BYTES);
      });
    const deps = makeDeps({ getObjectToFileFn });
    const provider = createVolcEngineLipSyncProvider(deps);

    await expect(
      provider.generateTalkingHead({ providerAvatarId: FOOTAGE_KEY, scriptText: "第一次" }),
    ).rejects.toThrow(/NoSuchKey/);
    expect(getObjectToFileFn).toHaveBeenCalledTimes(1);

    // 缓存已清：同一底板再来一次 → 重新下载+上传，且端到端成功
    const result = await provider.generateTalkingHead({ providerAvatarId: FOOTAGE_KEY, scriptText: "第二次" });
    expect(getObjectToFileFn).toHaveBeenCalledTimes(2);
    expect(putCountsByType(deps.fetchImpl).video).toBe(1);
    expect(result.videoAssetId).toMatch(/^avatars\/lipsync\//);
  });

  it("resetFootageFileIdCacheForTests 清空缓存：再次调用重新下载", async () => {
    const deps = makeDeps();
    const provider = createVolcEngineLipSyncProvider(deps);

    await provider.generateTalkingHead({ providerAvatarId: FOOTAGE_KEY, scriptText: "第一次" });
    expect(deps.getObjectToFileFn).toHaveBeenCalledTimes(1);

    resetFootageFileIdCacheForTests();

    await provider.generateTalkingHead({ providerAvatarId: FOOTAGE_KEY, scriptText: "第二次" });
    expect(deps.getObjectToFileFn).toHaveBeenCalledTimes(2);
    expect(putCountsByType(deps.fetchImpl).video).toBe(2);
  });

  it("上传字节=下载字节（fetch 时刻从 Blob 流出）且临时文件在任务返回前已清理", async () => {
    const writtenPaths: string[] = [];
    const getObjectToFileFn = vi.fn(async (_key: string, destPath: string) => {
      writtenPaths.push(destPath);
      await writeFile(destPath, FOOTAGE_BYTES);
    });
    const deps = makeDeps({ getObjectToFileFn });
    const provider = createVolcEngineLipSyncProvider(deps);

    await provider.generateTalkingHead({ providerAvatarId: FOOTAGE_KEY, scriptText: "校验上传内容" });

    // 底板 PUT 字节与下载内容逐字节一致（路由在 fetch 时刻读出，与生产 undici 一致）
    expect(await videoPutBytes(deps.fetchImpl)).toEqual(FOOTAGE_BYTES);
    // finally 清理：任务返回后临时文件不得残留（否则长进程 tmpdir 堆积）
    expect(writtenPaths).toHaveLength(1);
    expect(existsSync(writtenPaths[0]!)).toBe(false);
  });
});
