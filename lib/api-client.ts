import type {
  Asset,
  AssetAnalysis,
  AvatarProfile,
  Job,
  MarketingPurpose,
  ScriptDraft,
  StoreProfile,
  VideoOutput
} from "@/lib/types";
import type { StoreSuggestion, StoreSuggestionInput } from "@/lib/services/store-suggest";

/**
 * Error from a non-2xx API response. Carries the HTTP status so callers (and
 * the react-query retry policy) can distinguish retryable 5xx/network errors
 * from 4xx that won't self-correct (e.g. 429 rate-limit, 401 auth).
 */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers }
  });
  const json = await res.json();
  if (!res.ok) {
    throw new ApiError(json.error ?? "Request failed", res.status);
  }
  return json as T;
}

export async function fetchAssets(): Promise<Asset[]> {
  const data = await api<{ assets: Asset[] }>("/api/assets");
  return data.assets;
}

export async function fetchAssetAnalyses(): Promise<AssetAnalysis[]> {
  const data = await api<{ analyses: AssetAnalysis[] }>("/api/asset-analyses");
  return data.analyses;
}

export async function fetchAvatars(): Promise<AvatarProfile[]> {
  const data = await api<{ avatars: AvatarProfile[] }>("/api/avatars");
  return data.avatars;
}

export async function fetchStores(): Promise<StoreProfile[]> {
  const data = await api<{ stores: StoreProfile[] }>("/api/store-profiles");
  return data.stores;
}

export async function fetchScriptDrafts(): Promise<ScriptDraft[]> {
  const data = await api<{ scripts: ScriptDraft[] }>("/api/script-drafts");
  return data.scripts;
}

export async function saveStore(profile: StoreProfile): Promise<StoreProfile> {
  const data = await api<{ store: StoreProfile }>("/api/store-profiles", {
    method: "POST",
    body: JSON.stringify(profile)
  });
  return data.store;
}

export async function suggestStoreProfileApi(input: StoreSuggestionInput): Promise<StoreSuggestion> {
  const data = await api<{ suggestion: StoreSuggestion }>("/api/store-profiles/suggest", {
    method: "POST",
    body: JSON.stringify(input)
  });
  return data.suggestion;
}

export interface UploadIntentResponse {
  assetId: string;
  storageKey: string;
  uploadUrl: string;
  headers: Record<string, string>;
  maxSizeBytes: number;
  expiresInSeconds: number;
}

export interface ConfirmAssetInput {
  assetId: string;
  storeId: string;
  ownerId?: string;
  storageKey: string;
  originalFilename: string;
  mimeType: string;
  type: "video" | "image" | "audio";
  sizeBytes?: number;
}

export async function createUploadIntentApi(input: {
  ownerId: string;
  storeId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
}): Promise<UploadIntentResponse> {
  const data = await api<{ intent: UploadIntentResponse }>("/api/assets/upload-intent", {
    method: "POST",
    body: JSON.stringify(input)
  });
  return data.intent;
}

export async function uploadFileToStorage(
  uploadUrl: string,
  file: File,
  headers: Record<string, string>,
  onProgress?: (ratio: number) => void
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl);

    for (const [key, value] of Object.entries(headers)) {
      xhr.setRequestHeader(key, value);
    }

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(event.loaded / event.total);
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
        return;
      }
      reject(new Error(`Upload failed with status ${xhr.status}`));
    };

    xhr.onerror = () => reject(new Error("Upload failed due to a network error"));
    xhr.send(file);
  });
}

export async function confirmAssetUpload(input: ConfirmAssetInput): Promise<Asset> {
  const data = await api<{ asset: Asset }>("/api/assets/confirm", {
    method: "POST",
    body: JSON.stringify(input)
  });
  return data.asset;
}

export async function saveAsset(asset: Asset): Promise<Asset> {
  const data = await api<{ asset: Asset }>("/api/assets", {
    method: "POST",
    body: JSON.stringify(asset)
  });
  return data.asset;
}

export async function deleteAsset(id: string): Promise<void> {
  await api<void>(`/api/assets/${id}`, { method: "DELETE" });
}

export interface AssetPreviewUrl {
  url: string;
  mimeType: string;
  type: Asset["type"];
}

export async function fetchAssetPreviewUrl(id: string): Promise<AssetPreviewUrl> {
  return api<AssetPreviewUrl>(`/api/assets/${id}/preview-url`);
}

export async function analyzeAssetApi(input: {
  assetId: string;
  storeId: string;
  visualLabels?: string[];
  transcript?: string;
}): Promise<AssetAnalysis> {
  const data = await api<{ analysis: AssetAnalysis }>("/api/assets/analyze", {
    method: "POST",
    body: JSON.stringify(input)
  });
  return data.analysis;
}

export async function createAvatarApi(input: {
  ownerId: string;
  storeId: string;
  trainingVideoAssetId: string;
  consentAccepted: boolean;
}): Promise<AvatarProfile> {
  const data = await api<{ avatar: AvatarProfile }>("/api/avatars", {
    method: "POST",
    body: JSON.stringify(input)
  });
  return data.avatar;
}

export async function requestTalkingHeadApi(input: {
  avatarProfileId: string;
  scriptDraftId: string;
}): Promise<{ jobId: string; status: string }> {
  return api<{ jobId: string; status: string }>("/api/avatars/talking-head", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function createScriptDraftApi(input: {
  storeId: string;
  assetAnalysisIds: string[];
  purpose: MarketingPurpose;
  platform?: string;
  targetDurationSec?: number;
}): Promise<ScriptDraft> {
  const data = await api<{ script: ScriptDraft }>("/api/script-drafts", {
    method: "POST",
    body: JSON.stringify(input)
  });
  return data.script;
}

export async function createRenderProjectApi(input: {
  scriptDraftId: string;
  selectedAssetIds: string[];
  avatarProfileId?: string;
  aspectRatio?: string;
  subtitleStyle?: string;
  bgmTrackId?: string;
}) {
  return api<{ project: unknown; jobs: Job[] }>("/api/render-projects", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function fetchJobs(): Promise<Job[]> {
  const data = await api<{ jobs: Job[] }>("/api/jobs");
  return data.jobs;
}

export async function clearCompletedJobsApi(): Promise<{ deleted: number }> {
  return api<{ deleted: number }>("/api/jobs", { method: "DELETE" });
}

export async function fetchRenderOutputs(): Promise<VideoOutput[]> {
  const data = await api<{ outputs: VideoOutput[] }>("/api/render-projects");
  return data.outputs;
}

export async function fetchVideoOutputUrl(outputId: string): Promise<string> {
  const data = await api<{ url: string }>(`/api/render-projects/outputs/${outputId}/url`);
  return data.url;
}

export async function updateScriptDraftApi(input: {
  scriptDraftId: string;
  scenes: { order: number; text?: string; matchedAssetId?: string | null }[];
}): Promise<ScriptDraft> {
  const data = await api<{ script: ScriptDraft }>(
    `/api/script-drafts/${encodeURIComponent(input.scriptDraftId)}`,
    { method: "PATCH", body: JSON.stringify({ scenes: input.scenes }) },
  );
  return data.script;
}

export interface BgmTrackOption {
  id: string;
  name: string;
  category: string;
  durationSeconds: number;
}

export async function fetchBgmTracks(): Promise<BgmTrackOption[]> {
  const data = await api<{ tracks: BgmTrackOption[] }>("/api/bgm-tracks");
  return data.tracks;
}
