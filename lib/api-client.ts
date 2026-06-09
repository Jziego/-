import type {
  Asset,
  AssetAnalysis,
  AvatarProfile,
  Job,
  MarketingPurpose,
  ScriptDraft,
  StoreProfile
} from "@/lib/types";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers }
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(json.error ?? "Request failed");
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
  scriptText: string;
  forceFallback?: boolean;
}) {
  return api<{ result: unknown }>("/api/avatars/talking-head", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function createScriptDraftApi(input: {
  storeId: string;
  assetAnalysisIds: string[];
  purpose: MarketingPurpose;
  platform?: string;
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
