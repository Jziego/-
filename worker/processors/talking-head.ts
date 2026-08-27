import type { Job } from "bullmq";
import { createId, nowIso } from "@/lib/ids";
import type { AvatarProvider } from "@/lib/services/avatar-provider";
import { createProviderFromEnv, requestAvatarTalkingHead } from "@/lib/services/avatar-provider";
import {
  isPlatformAvatarId,
  resolvePlatformProviderIds,
} from "@/lib/services/platform-avatar";
import {
  planSegmentSynthesis,
  voiceTrackManifestKey,
  type ResolvedSpeaker,
  type VoiceTrackManifest,
  type VoiceTrackSegment,
} from "@/lib/services/voice-track";
import { putObjectFromBuffer } from "@/lib/storage";
import {
  getAvatarRepository,
  getRenderRepository,
  getScriptRepository
} from "@/lib/repositories";
import type {
  AvatarRepository,
  RenderRepository,
  ScriptRepository
} from "@/lib/repositories/types";
import type { AvatarProfile, VideoOutput } from "@/lib/types";
import type { ProcessorFn } from "./index";

export interface TalkingHeadDeps {
  avatarRepository: AvatarRepository;
  scriptRepository: ScriptRepository;
  renderRepository: RenderRepository;
  provider: AvatarProvider;
  /** manifest JSON 上传（默认 R2）；测试注入捕获。 */
  uploadManifest: (key: string, manifest: VoiceTrackManifest) => Promise<void>;
}

const defaultUploadManifest = async (key: string, manifest: VoiceTrackManifest): Promise<void> => {
  await putObjectFromBuffer(key, new TextEncoder().encode(JSON.stringify(manifest)), "application/json");
};

/**
 * talking_head processor（Phase 3 分段版）：draft.segments 非空时按段合成——
 * 出镜段生成该形象的数字人视频（音视频一体），画外音段用该形象克隆声音 TTS
 * （拿词级时间轴），产物清单持久化为 R2 上的 voice-track manifest，并以
 * VideoOutput(kind="segmented_voice", storageKey=manifest key) 供 video_render
 * 消费；TTS 重试 1 次仍失败的段降级为数字人视频（fellBackToVideo）。
 * draft.segments 为空（老数据）或 payload.forceLegacy=true（预览端点契约：
 * 恒定整段单视频 kind="talking_head"）时保持 legacy 整段单视频路径。
 *
 * Expected job payload: { avatarProfileIds: string[], scriptDraftId, forceLegacy? }
 * （legacy 单形象 payload: { avatarProfileId, scriptDraftId, forceLegacy? }）
 */
export const talkingHeadProcessor: ProcessorFn = (job) =>
  processTalkingHead(job, {
    avatarRepository: getAvatarRepository(),
    scriptRepository: getScriptRepository(),
    renderRepository: getRenderRepository(),
    provider: createProviderFromEnv(),
    uploadManifest: defaultUploadManifest
  });

/** payload → 有序 speaker 解析（含平台公共形象；缺失/未就绪直接抛错走 job 重试）。 */
async function resolveSpeakers(
  ids: string[],
  deps: Pick<TalkingHeadDeps, "avatarRepository" | "provider">,
  ownerId: string,
): Promise<ResolvedSpeaker[]> {
  const speakers: ResolvedSpeaker[] = [];
  for (const id of ids) {
    if (isPlatformAvatarId(id)) {
      const envIds = resolvePlatformProviderIds();
      if (envIds) {
        speakers.push({ profileId: id, ...envIds });
        continue;
      }
      // env 未配模板 → provider 公共形象解析（heygen 公共 stock / mock 随机 id），
      // 否则 render 项目的 talking_head 永远抛错，卡死父级 video_render。
      const created = await deps.provider.createAvatar({ trainingVideoAssetId: "", ownerId });
      speakers.push({
        profileId: id,
        providerAvatarId: created.providerAvatarId,
        providerVoiceId: created.providerVoiceId,
      });
      continue;
    }
    const avatar: AvatarProfile | null = await deps.avatarRepository.findById(id);
    if (!avatar?.providerAvatarId) {
      throw new Error(`Avatar profile ${id} not ready (missing providerAvatarId)`);
    }
    speakers.push({
      profileId: id,
      providerAvatarId: avatar.providerAvatarId,
      providerVoiceId: avatar.providerVoiceId,
    });
  }
  return speakers;
}

export async function processTalkingHead(job: Job, deps: TalkingHeadDeps): Promise<VideoOutput> {
  const payload = job.data.payload as {
    avatarProfileId?: string;
    avatarProfileIds?: string[];
    scriptDraftId: string;
    /** 预览端点（/api/avatars/talking-head）契约：强制整段单视频，忽略 draft.segments。 */
    forceLegacy?: boolean;
  };
  const projectId = (job.data.projectId as string | undefined) ?? null;
  const ownerId = (job.data.ownerId as string) ?? "demo_user";

  const draft = await deps.scriptRepository.findById(payload.scriptDraftId);
  if (!draft) {
    throw new Error(`Script draft ${payload.scriptDraftId} not found`);
  }

  const avatarIds = payload.avatarProfileIds ?? (payload.avatarProfileId ? [payload.avatarProfileId] : []);
  if (avatarIds.length === 0) {
    throw new Error("talking_head requires at least one avatarProfileId");
  }
  const speakers = await resolveSpeakers(avatarIds, deps, ownerId);

  const segments = draft.segments ?? [];

  // ── Legacy 路径：无 segments 的老 draft，或预览端点显式 forceLegacy → 整段单视频 ──
  if (payload.forceLegacy || segments.length === 0) {
    const speaker = speakers[0] as ResolvedSpeaker;
    const result = await requestAvatarTalkingHead({
      provider: deps.provider,
      avatarProfileId: speaker.profileId,
      providerAvatarId: speaker.providerAvatarId,
      providerVoiceId: speaker.providerVoiceId,
      scriptText: draft.voiceover,
      onProgress: (attempt, maxAttempts) => {
        // Reserve 5..85 for polling; 90/100 reserved for store/finalize below.
        const pct = 5 + Math.round((attempt / maxAttempts) * 80);
        void job.updateProgress(pct);
      }
    });
    await job.updateProgress(90);
    const output = buildOutput(projectId, ownerId, result.videoAssetId, result.durationSeconds, "talking_head");
    await persistOutput(deps, output);
    await job.updateProgress(100);
    return output;
  }

  // ── Phase 3 分段路径 ──
  const plan = planSegmentSynthesis(segments, speakers, draft.speakerAvatarIds);
  const trackSegments: VoiceTrackSegment[] = [];

  for (let i = 0; i < plan.length; i++) {
    const { segment, speaker } = plan[i]!;
    if (segment.onCamera) {
      // 出镜段：数字人视频（音视频一体）
      const result = await deps.provider.generateTalkingHead({
        providerAvatarId: speaker.providerAvatarId,
        providerVoiceId: speaker.providerVoiceId,
        scriptText: segment.text,
      });
      trackSegments.push({
        index: segment.index,
        speakerIndex: segment.speakerIndex,
        onCamera: true,
        text: segment.text,
        videoStorageKey: result.videoAssetId,
        durationSec: result.durationSeconds,
      });
    } else {
      // 画外音段：克隆声音 TTS（含词级时间轴）；失败重试 1 次 → 降级数字人视频（spec §6.5）
      trackSegments.push(await synthesizeOffCameraSegment(segment, speaker, deps.provider));
    }
    void job.updateProgress(5 + Math.round(((i + 1) / plan.length) * 80));
  }

  const manifest: VoiceTrackManifest = {
    version: 1,
    segments: trackSegments,
    totalDurationSec: trackSegments.reduce((acc, s) => acc + s.durationSec, 0),
  };
  const manifestKey = voiceTrackManifestKey(projectId ?? job.id ?? createId("job"));
  await job.updateProgress(90);
  await deps.uploadManifest(manifestKey, manifest);

  const output = buildOutput(projectId, ownerId, manifestKey, manifest.totalDurationSec, "segmented_voice");
  await persistOutput(deps, output);
  await job.updateProgress(100);
  return output;
}

async function synthesizeOffCameraSegment(
  segment: { index: number; speakerIndex: number; text: string },
  speaker: ResolvedSpeaker,
  provider: AvatarProvider,
): Promise<VoiceTrackSegment> {
  const base = {
    index: segment.index,
    speakerIndex: segment.speakerIndex,
    onCamera: false as const,
    text: segment.text,
  };
  if (!speaker.providerVoiceId) {
    // 无克隆声音（理论上 ready 形象都有）→ 直接降级数字人视频
    const result = await provider.generateTalkingHead({
      providerAvatarId: speaker.providerAvatarId,
      scriptText: segment.text,
    });
    return { ...base, videoStorageKey: result.videoAssetId, durationSec: result.durationSeconds, fellBackToVideo: true };
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const speech = await provider.synthesizeSpeech({
        providerVoiceId: speaker.providerVoiceId,
        text: segment.text,
      });
      return {
        ...base,
        audioStorageKey: speech.audioStorageKey,
        durationSec: speech.durationSeconds,
        words: speech.words,
      };
    } catch (error) {
      console.warn(
        `[talking_head] TTS attempt ${attempt + 1} failed for segment ${segment.index}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const result = await provider.generateTalkingHead({
    providerAvatarId: speaker.providerAvatarId,
    providerVoiceId: speaker.providerVoiceId,
    scriptText: segment.text,
  });
  return { ...base, videoStorageKey: result.videoAssetId, durationSec: result.durationSeconds, fellBackToVideo: true };
}

function buildOutput(
  projectId: string | null,
  ownerId: string,
  storageKey: string,
  durationSeconds: number,
  kind: VideoOutput["kind"],
): VideoOutput {
  return {
    id: createId("output"),
    ownerId,
    renderProjectId: projectId,
    storageKey,
    coverStorageKey: undefined,
    aspectRatio: "9:16",
    durationSeconds,
    kind,
    status: "ready",
    createdAt: nowIso()
  };
}

async function persistOutput(deps: TalkingHeadDeps, output: VideoOutput): Promise<void> {
  // Persist 供 video_render 经 findTalkingHeadOutputByProject 获取；RenderProject
  // 状态由 finalizeProjectStatus() 统一收敛，避免并发竞争。
  try {
    await deps.renderRepository.createOutput(output);
  } catch (err) {
    console.error(
      `[talking_head] Failed to persist VideoOutput: ${err instanceof Error ? err.message : String(err)}`,
    );
    // Still return the output — the DB may not be available in dev
  }
}
