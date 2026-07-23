"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ChangeEvent, type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import {
  analyzeAssetApi,
  clearCompletedJobsApi,
  confirmAssetUpload,
  createAvatarApi,
  createRenderProjectApi,
  createScriptDraftApi,
  createUploadIntentApi,
  deleteAsset,
  fetchAssetAnalyses,
  fetchAssetPreviewUrl,
  fetchAssets,
  fetchAvatars,
  fetchBgmTracks,
  fetchJobs,
  fetchRenderOutputs,
  fetchScriptDrafts,
  fetchStores,
  fetchVideoOutputUrl,
  requestTalkingHeadApi,
  saveStore,
  suggestStoreProfileApi,
  updateScriptDraftApi,
  uploadFileToStorage
} from "@/lib/api-client";
import { StoryboardConfirm } from "@/components/storyboard-confirm";
import { MAX_ASSETS_PER_STORE, clampUploadBatch } from "@/lib/asset-library";
import { MAX_UPLOAD_BYTES } from "@/lib/services/assets";
import {
  clearStoreDraft,
  loadStoreDraft,
  loadStoreDraftStep,
  saveStoreDraft,
  saveStoreDraftStep
} from "@/lib/draft-storage";
import { createId, nowIso } from "@/lib/ids";
import { useJobProgressSSE } from "@/lib/use-job-progress";
import type { Asset, AssetAnalysis, AvatarProfile, Job, MarketingPurpose, ScriptDraft, StoreProfile, VideoOutput } from "@/lib/types";
import { selectLatestBatchJobs } from "@/lib/dashboard-jobs";

type StoreFormValues = {
  name: string;
  industry: string;
  location: string;
  mainProducts: string;
  targetCustomers: string;
  sellingPoints: string;
  promotions: string;
  brandTone: string;
  forbiddenWords: string;
};

type StoreFieldName = keyof StoreFormValues;
type PendingAction = "store" | "upload" | "avatar" | "render" | null;

type StoreField = {
  name: StoreFieldName;
  label: string;
  placeholder: string;
  required?: boolean;
  kind?: "input" | "textarea" | "select";
  options?: string[];
};

const defaultStoreForm: StoreFormValues = {
  name: "阿姨手作面馆",
  industry: "餐饮",
  location: "上海市徐汇区",
  mainProducts: "牛肉面, 葱油拌面",
  targetCustomers: "附近上班族, 社区居民",
  sellingPoints: "现熬牛骨汤, 午市出餐快",
  promotions: "工作日午餐第二份半价",
  brandTone: "亲切接地气",
  forbiddenWords: "最便宜, 全网第一"
};

const storeFormSteps: Array<{
  title: string;
  description: string;
  progress: string;
  fields: StoreField[];
}> = [
  {
    title: "基础信息",
    description: "先告诉 AI 你是谁、做什么、在哪里。",
    progress: "1/3",
    fields: [
      { name: "name", label: "门店名称", placeholder: "例：阿姨手作面馆", required: true },
      {
        name: "industry",
        label: "行业",
        placeholder: "请选择行业",
        required: true,
        kind: "select",
        options: ["餐饮", "美业", "零售", "生活服务", "教育培训", "其他"]
      },
      { name: "location", label: "位置", placeholder: "例：上海市徐汇区", required: true }
    ]
  },
  {
    title: "产品与人设",
    description: "越具体，AI 写出来的视频脚本越像你的店。",
    progress: "2/3",
    fields: [
      { name: "mainProducts", label: "主营产品", placeholder: "例：牛肉面, 葱油拌面", required: true },
      { name: "targetCustomers", label: "目标顾客", placeholder: "例：附近上班族, 社区居民", required: true },
      {
        name: "sellingPoints",
        label: "卖点",
        placeholder: "例：现熬牛骨汤，午市 10 分钟出餐",
        required: true,
        kind: "textarea"
      }
    ]
  },
  {
    title: "内容风格",
    description: "告诉 AI 你的活动、说话风格，以及需要避开的敏感词。",
    progress: "3/3",
    fields: [
      { name: "promotions", label: "促销活动", placeholder: "例：工作日午餐第二份半价", kind: "textarea" },
      { name: "brandTone", label: "说话风格", placeholder: "请选择说话风格", required: true },
      { name: "forbiddenWords", label: "敏感词 / 规避词", placeholder: "例：最便宜, 全网第一", kind: "textarea" }
    ]
  }
];

const purposeOptions: Array<{ value: MarketingPurpose; label: string; description: string }> = [
  { value: "store_traffic", label: "门店引流", description: "让附近刷到的人，忍不住想进店看看" },
  { value: "new_product", label: "新品推广", description: "讲清楚新品好在哪，让人看了就想尝" },
  { value: "promotion", label: "促销活动", description: "把优惠信息说清楚，看完就想下单/到店" }
];

const purposeLabels: Record<string, string> = {
  store_traffic: "门店引流",
  new_product: "新品推广",
  promotion: "促销活动"
};

const jobTypeLabels: Record<string, string> = {
  avatar_generation: "AI 形象训练",
  talking_head: "视频任务",
  video_render: "视频合成"
};

const jobStatusLabels: Record<string, string> = {
  queued: "进行中",
  processing: "生成中",
  completed: "已完成",
  failed: "已启用备用方案"
};

const tagDisplayLabels: Record<string, string> = {
  food: "美食",
  person: "人物",
  storefront: "门店环境"
};

function normalizeStoreFormStep(step: number): number {
  return Math.min(Math.max(step, 0), storeFormSteps.length - 1);
}

function getInitialStoreFormStep(): number {
  return normalizeStoreFormStep(loadStoreDraftStep() ?? 0);
}

function joinCsv(values: string[] | undefined): string {
  return (values ?? []).join(", ");
}

function storeProfileToFormValues(profile: StoreProfile): StoreFormValues {
  return {
    name: profile.name,
    industry: profile.industry,
    location: profile.location ?? "",
    mainProducts: joinCsv(profile.mainProducts),
    targetCustomers: joinCsv(profile.targetCustomers),
    sellingPoints: joinCsv(profile.sellingPoints),
    promotions: joinCsv(profile.promotions),
    brandTone: profile.brandTone,
    forbiddenWords: joinCsv(profile.forbiddenWords)
  };
}

function draftMatchesDefaults(draft: Partial<StoreFormValues>): boolean {
  return (Object.keys(defaultStoreForm) as StoreFieldName[]).every(
    (key) => mergeStoreDraftWithDefaults(draft)[key] === defaultStoreForm[key]
  );
}

function mergeStoreDraftWithDefaults(draft: Partial<StoreFormValues>): StoreFormValues {
  const merged: StoreFormValues = { ...defaultStoreForm };

  for (const key of Object.keys(defaultStoreForm) as StoreFieldName[]) {
    const value = draft[key];
    if (typeof value === "string" && value.trim() !== "") {
      merged[key] = value;
    }
  }

  return merged;
}

function collectStoreFormValues(
  getValues: () => StoreFormValues,
  dirtyFields: Partial<Record<StoreFieldName, unknown>>
): StoreFormValues {
  const storedDraft = loadStoreDraft<Partial<StoreFormValues>>() ?? {};
  const currentValues = getValues();
  const mergedDraft: Partial<StoreFormValues> = { ...storedDraft };

  for (const key of Object.keys(defaultStoreForm) as StoreFieldName[]) {
    const storedValue = storedDraft[key];
    const currentValue = currentValues[key];
    const currentValueIsDefault = currentValue === defaultStoreForm[key];

    if (dirtyFields[key] || !storedValue || !currentValueIsDefault) {
      mergedDraft[key] = currentValue;
    }
  }

  return mergeStoreDraftWithDefaults(mergedDraft);
}

function scrollToSection(sectionId: string): void {
  if (typeof window === "undefined") return;

  try {
    document.getElementById(sectionId)?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  } catch {
    // jsdom and some embedded browsers do not implement scrollIntoView.
  }
}

function scrollToFirstFieldError(fields: StoreField[]): void {
  if (typeof window === "undefined") return;

  for (const field of fields) {
    const errorElement = document.getElementById(`${field.name}-error`);
    if (errorElement) {
      errorElement.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }

    const input = document.querySelector<HTMLElement>(`[name="${field.name}"]`);
    if (input?.getAttribute("aria-invalid") === "true") {
      input.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
  }
}

export function Dashboard() {
  const queryClient = useQueryClient();
  const [localStore, setLocalStore] = useState<StoreProfile | null>(null);
  const [localAssets, setLocalAssets] = useState<Asset[]>([]);
  const [localAnalyses, setLocalAnalyses] = useState<AssetAnalysis[]>([]);
  const [selectedAssetIds, setSelectedAssetIds] = useState<Set<string>>(new Set());
  const [uploadingFiles, setUploadingFiles] = useState<
    { id: string; name: string; progress: number; status: "uploading" | "failed" }[]
  >([]);
  const seededSelectionRef = useRef(false);
  const [localAvatar, setLocalAvatar] = useState<AvatarProfile | null>(null);
  const [localScript, setLocalScript] = useState<ScriptDraft | null>(null);
  const [localJobs, setLocalJobs] = useState<Job[] | null>(null);
  const [message, setMessage] = useState("准备开始：先完成门店档案。");
  const [storeFormStep, setStoreFormStep] = useState(0);
  const [draftReady, setDraftReady] = useState(false);
  const [storeHydrationResolved, setStoreHydrationResolved] = useState(false);
  const [avatarConsent, setAvatarConsent] = useState(false);
  const [selectedPurpose, setSelectedPurpose] = useState<MarketingPurpose>("store_traffic");
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [clearingJobs, setClearingJobs] = useState(false);
  const [storyboardDraft, setStoryboardDraft] = useState<ScriptDraft | null>(null);
  const [bgmTracks, setBgmTracks] = useState<
    { id: string; name: string; category: string; durationSeconds: number }[]
  >([]);
  const [targetDuration, setTargetDuration] = useState<number>(30);
  const [generating, setGenerating] = useState(false);
  const draftClearedRef = useRef(false);
  const savedStoreHydratedRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: stores = [], isPending: storesPending } = useQuery({
    queryKey: ["stores"],
    queryFn: fetchStores
  });

  const { data: serverAssets = [] } = useQuery({
    queryKey: ["assets"],
    queryFn: fetchAssets
  });

  const { data: serverAnalyses = [] } = useQuery({
    queryKey: ["asset-analyses"],
    queryFn: fetchAssetAnalyses
  });

  const { data: serverAvatars = [] } = useQuery({
    queryKey: ["avatars"],
    queryFn: fetchAvatars
  });

  const { data: serverJobs = [] } = useQuery({
    queryKey: ["jobs"],
    queryFn: fetchJobs,
    refetchInterval: (query) => {
      const currentJobs = selectLatestBatchJobs(localJobs ?? (query.state.data ?? []));
      return currentJobs.some((job) => job.status === "queued" || job.status === "processing") ? 5000 : false;
    }
  });

  // Latest video-generation batch shown in the 生成进度 panel. Derived (not
  // stored): new tasks have the newest createdAt, so they auto-replace the
  // previous batch — no accumulation, survives reload. See selectLatestBatchJobs.
  const progressJobs = useMemo(() => selectLatestBatchJobs(localJobs ?? serverJobs), [localJobs, serverJobs]);

  // Completed render outputs surface here once video_render finishes; poll in
  // lockstep with the latest batch so a freshly-completed video appears without
  // a reload.
  const { data: serverOutputs = [] } = useQuery({
    queryKey: ["render-outputs"],
    queryFn: fetchRenderOutputs,
    refetchInterval: progressJobs.some((job) => job.status === "queued" || job.status === "processing")
      ? 5000
      : false
  });

  // SSE real-time progress for the latest batch's active jobs only.
  const jobProgressSSE = useJobProgressSSE(progressJobs);

  const { data: serverScripts = [] } = useQuery({
    queryKey: ["script-drafts"],
    queryFn: fetchScriptDrafts
  });

  const store = localStore ?? stores[0] ?? null;
  // Asset library is a per-store pool (DB-persisted + this session's uploads,
  // deduped by id). Selection is a subset the user ticks for rendering.
  const assets = useMemo(() => {
    const seen = new Set<string>();
    const merged: Asset[] = [];
    const storeAssets = store ? serverAssets.filter((item) => item.storeId === store.id) : [];
    for (const asset of [...localAssets, ...storeAssets]) {
      if (seen.has(asset.id)) continue;
      seen.add(asset.id);
      merged.push(asset);
    }
    return merged;
  }, [localAssets, serverAssets, store]);

  const analysesByAssetId = useMemo(() => {
    const map = new Map<string, AssetAnalysis>();
    for (const analysis of [...serverAnalyses, ...localAnalyses]) {
      map.set(analysis.assetId, analysis);
    }
    return map;
  }, [serverAnalyses, localAnalyses]);

  const selectedAssets = useMemo(
    () => assets.filter((a) => selectedAssetIds.has(a.id)),
    [assets, selectedAssetIds]
  );
  const selectedAnalyses = useMemo(
    () => selectedAssets.map((a) => analysesByAssetId.get(a.id)).filter((a): a is AssetAnalysis => Boolean(a)),
    [selectedAssets, analysesByAssetId]
  );

  const overallUploadProgress =
    uploadingFiles.length > 0
      ? Math.round(uploadingFiles.reduce((sum, f) => sum + f.progress, 0) / uploadingFiles.length)
      : 0;

  // Default-select every asset on first load; after that selection is driven
  // only by user toggle / upload / delete.
  useEffect(() => {
    if (seededSelectionRef.current || assets.length === 0) return;
    seededSelectionRef.current = true;
    setSelectedAssetIds(new Set(assets.map((a) => a.id)));
  }, [assets]);

  useEffect(() => {
    let cancelled = false;
    fetchBgmTracks()
      .then((tracks) => {
        if (!cancelled) setBgmTracks(Array.isArray(tracks) ? tracks : []);
      })
      .catch(() => {
        /* 静默：无曲目也能渲染 */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const avatar =
    localAvatar ?? (store ? (serverAvatars.find((item) => item.storeId === store.id) ?? null) : null);
  const script =
    localScript ??
    (store
      ? (serverScripts
          .filter((item) => item.storeId === store.id)
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null)
      : null);

  // Only completed final-composite videos are previewable/playable artifacts.
  // serverOutputs already comes newest-first; keep the preview list short so it
  // doesn't pile up alongside the progress panel.
  const completedOutputs = serverOutputs
    .filter((output) => output.kind === "final_composite" && output.status === "ready")
    .slice(0, 5);

  // Merge SSE real-time progress into the latest-batch job list for display
  const jobsWithProgress = useMemo(() => {
    if (jobProgressSSE.size === 0) return progressJobs;
    return progressJobs.map((job) => {
      const sseState = jobProgressSSE.get(job.id);
      if (!sseState) return job;
      return { ...job, status: sseState.status, progress: sseState.progress, error: sseState.error ?? job.error };
    });
  }, [progressJobs, jobProgressSSE]);
  const hasTerminalJobs = jobsWithProgress.some(
    (job) => job.status === "completed" || job.status === "failed"
  );
  const {
    control,
    register,
    trigger,
    getValues,
    setValue,
    getFieldState,
    reset,
    formState: { dirtyFields, errors }
  } = useForm<StoreFormValues>({
    defaultValues: defaultStoreForm,
    shouldUnregister: false
  });
  const currentDraft = useWatch({ control });

  useEffect(() => {
    const draft = loadStoreDraft<StoreFormValues>();
    if (draft) {
      reset(mergeStoreDraftWithDefaults(draft));
    }
    // Restore persisted step after hydration so SSR and the first client render stay aligned.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- client-only draft step must load after mount
    setStoreFormStep(getInitialStoreFormStep());
    setDraftReady(true);
  }, [reset]);

  useEffect(() => {
    if (!draftReady || storesPending || storeHydrationResolved) return;

    const savedStore = stores[0];
    const draft = loadStoreDraft<StoreFormValues>();

    if (savedStore && (!draft || draftMatchesDefaults(draft))) {
      savedStoreHydratedRef.current = true;
      draftClearedRef.current = true;
      if (draft) clearStoreDraft();
      reset(storeProfileToFormValues(savedStore));
      // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate completed profile from API after stores load
      setStoreFormStep(storeFormSteps.length - 1);
    }

    setStoreHydrationResolved(true);
  }, [draftReady, reset, storeHydrationResolved, stores, storesPending]);

  useEffect(() => {
    if (!draftReady || !storeHydrationResolved) return;
    if (draftClearedRef.current) return;
    saveStoreDraft(currentDraft);
  }, [currentDraft, draftReady, storeHydrationResolved]);

  useEffect(() => {
    if (avatar) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- mirror server avatar consent on refresh
      setAvatarConsent(true);
    }
  }, [avatar]);

  useEffect(() => {
    if (script) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- restore marketing purpose from saved script
      setSelectedPurpose(script.purpose);
    }
  }, [script]);

  const currentStepIndex = useMemo(() => {
    if (!store) return 0;
    if (assets.length === 0) return 1;
    if (!avatar) return 2;
    return 3;
  }, [assets, avatar, store]);

  const workflowSteps = useMemo(
    () => [
      { label: "门店档案", href: "#store-profile", complete: Boolean(store) },
      { label: "素材库", href: "#media-upload", complete: assets.length > 0 },
      { label: "AI 分身", href: "#avatar-clone", complete: Boolean(avatar) },
      { label: "智能成片", href: "#one-click-video", complete: Boolean(script) }
    ],
    [assets, avatar, script, store]
  );

  const selectedStoreStep = storeFormSteps[storeFormStep];
  const renderLocked = !store;
  const renderMissingAssets = store && selectedAssets.length === 0;

  function goToStoreFormStep(step: number) {
    const nextStep = normalizeStoreFormStep(step);
    setStoreFormStep(nextStep);
    saveStoreDraftStep(nextStep);
  }

  async function submitCurrentStoreStep() {
    if (pendingAction) return;

    const isLastStep = storeFormStep >= storeFormSteps.length - 1;
    // Only validate the current step's fields, not all fields across all steps.
    // Previous steps were already validated when the user clicked "保存并继续".
    // The API schema validation is the ultimate guard for data completeness.
    const fieldsToValidate = selectedStoreStep.fields as StoreField[];
    const fieldNames = fieldsToValidate.map((field) => field.name);

    setPendingAction("store");

    try {
      const valid = await trigger(fieldNames, { shouldFocus: true });

      if (!valid) {
        const firstInvalidField = fieldsToValidate.find((field) => getFieldState(field.name).invalid);
        setMessage(firstInvalidField ? `请先填写${firstInvalidField.label}。` : "请先补全当前步骤的必填项。");
        scrollToFirstFieldError(fieldsToValidate);
        return;
      }

      if (!isLastStep) {
        goToStoreFormStep(storeFormStep + 1);
        setMessage("已保存本步内容，继续完善门店档案。");
        return;
      }

      const values = collectStoreFormValues(getValues, dirtyFields);
      const now = nowIso();
      const profile: StoreProfile = {
        id: store?.id ?? createId("store"),
        ownerId: store?.ownerId ?? "demo_user",
        name: values.name,
        industry: values.industry,
        location: values.location,
        mainProducts: splitCsv(values.mainProducts),
        targetCustomers: splitCsv(values.targetCustomers),
        sellingPoints: splitCsv(values.sellingPoints),
        promotions: splitCsv(values.promotions),
        brandTone: values.brandTone,
        forbiddenWords: splitCsv(values.forbiddenWords),
        createdAt: store?.createdAt ?? now,
        updatedAt: now
      };
      const saved = await saveStore(profile);
      setLocalStore(saved);
      draftClearedRef.current = true;
      clearStoreDraft();
      // Fire background refresh but don't block the UI update — the local state already
      // holds the saved store, so the material library unlocks immediately.
      void queryClient.invalidateQueries({ queryKey: ["stores"] });
      setMessage("保存成功：请继续上传素材。");
      scrollToSection("media-upload");
    } catch (error) {
      const detail = error instanceof Error ? error.message : "保存失败，请稍后重试。";
      setMessage(`门店档案保存失败：${detail}`);
    } finally {
      setPendingAction(null);
    }
  }

  function handleStoreFormSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitCurrentStoreStep();
  }

  async function handleSuggestStore() {
    if (pendingAction) return;
    const name = getValues("name");
    const industry = getValues("industry");
    if (!name || !industry) {
      setMessage("请先填写门店名称和行业，再使用 AI 建议。");
      return;
    }
    setPendingAction("store");
    try {
      const suggestion = await suggestStoreProfileApi({
        name,
        industry,
        location: getValues("location") || undefined
      });
      setValue("mainProducts", joinCsv(suggestion.mainProducts), { shouldDirty: true });
      setValue("targetCustomers", joinCsv(suggestion.targetCustomers), { shouldDirty: true });
      setValue("sellingPoints", joinCsv(suggestion.sellingPoints), { shouldDirty: true });
      setValue("promotions", joinCsv(suggestion.promotions), { shouldDirty: true });
      setValue("brandTone", suggestion.brandTone, { shouldDirty: true });
      setMessage("AI 建议已填入，请审阅后保存。");
    } catch (error) {
      const detail = error instanceof Error ? error.message : "请稍后重试";
      setMessage(`AI 建议生成失败：${detail}（可重试或手动填写）`);
    } finally {
      setPendingAction(null);
    }
  }

  function inferAssetType(mimeType: string): "video" | "image" | "audio" {
    if (mimeType.startsWith("video/")) return "video";
    if (mimeType.startsWith("image/")) return "image";
    return "audio";
  }

  function openFilePicker() {
    fileInputRef.current?.click();
  }

  function toggleAssetSelected(id: string) {
    setSelectedAssetIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  async function handleDeleteAsset(id: string) {
    if (typeof window !== "undefined" && !window.confirm("确认删除该素材？该操作不可撤销。")) {
      return;
    }
    try {
      await deleteAsset(id);
      // Optimistic cache update — mirror the server-side delete in the
      // react-query cache directly instead of refetching. A refetch costs a
      // read against the shared L0/L2-read rate-limit budget; on the
      // multi-asset dashboard, consecutive-delete refetches tipped the limit
      // and cascaded into 429s. Worse, a 429'd refetch left the stale
      // (still-has-asset) cache so the deleted asset reappeared. setQueryData
      // updates instantly with zero extra requests.
      queryClient.setQueryData<Asset[]>(["assets"], (old) =>
        (old ?? []).filter((a) => a.id !== id)
      );
      setLocalAssets((prev) => prev.filter((a) => a.id !== id));
      setSelectedAssetIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      setMessage("已删除素材。");
    } catch {
      setMessage("删除失败，请稍后重试。");
    }
  }

  async function handleAssetUploads(files: File[]) {
    if (!store) {
      setMessage("请先完成门店档案。");
      return;
    }

    const { accepted, rejected } = clampUploadBatch(assets.length, files.length);
    if (accepted === 0) {
      setMessage(`单店最多 ${MAX_ASSETS_PER_STORE} 个素材，请先删除不需要的再上传。`);
      return;
    }
    const filesToUpload = rejected > 0 ? files.slice(0, accepted) : files;

    const validFiles = filesToUpload.filter(
      (file) =>
        (file.type.startsWith("video/") || file.type.startsWith("image/") || file.type.startsWith("audio/")) &&
        file.size <= MAX_UPLOAD_BYTES
    );

    if (validFiles.length === 0) {
      setMessage("仅支持上传视频、图片或音频文件（单个不超过 200MB）。");
      return;
    }

    setPendingAction("upload");

    let successCount = 0;
    let failCount = 0;

    for (const file of validFiles) {
      const uploadId = createId("upl");
      setUploadingFiles((prev) => [...prev, { id: uploadId, name: file.name, progress: 0, status: "uploading" }]);
      try {
        const intent = await createUploadIntentApi({
          ownerId: store.ownerId,
          storeId: store.id,
          filename: file.name,
          contentType: file.type,
          sizeBytes: file.size
        });

        await uploadFileToStorage(intent.uploadUrl, file, intent.headers, (ratio) => {
          setUploadingFiles((prev) =>
            prev.map((f) => (f.id === uploadId ? { ...f, progress: Math.round(ratio * 100) } : f))
          );
        });

        const uploadedAsset = await confirmAssetUpload({
          assetId: intent.assetId,
          storeId: store.id,
          ownerId: store.ownerId,
          storageKey: intent.storageKey,
          originalFilename: file.name,
          mimeType: file.type,
          type: inferAssetType(file.type),
          sizeBytes: file.size
        });

        const analyzed = await analyzeAssetApi({
          assetId: uploadedAsset.id,
          storeId: store.id
        });

        setLocalAssets((prev) => (prev.some((a) => a.id === uploadedAsset.id) ? prev : [...prev, uploadedAsset]));
        setLocalAnalyses((prev) => [...prev, analyzed]);
        setSelectedAssetIds((prev) => new Set(prev).add(uploadedAsset.id));
        successCount += 1;
      } catch {
        failCount += 1;
        setUploadingFiles((prev) => prev.map((f) => (f.id === uploadId ? { ...f, status: "failed" } : f)));
      } finally {
        // Task 5 scope: a finished/failed upload's row is removed immediately.
        // Task 6/7 reintroduce a persistent failed-row UI with a retry affordance.
        setUploadingFiles((prev) => prev.filter((f) => f.id !== uploadId));
      }
    }

    await queryClient.invalidateQueries({ queryKey: ["assets"] });
    await queryClient.invalidateQueries({ queryKey: ["asset-analyses"] });
    setPendingAction(null);

    if (failCount === 0) {
      const base =
        successCount > 1
          ? `上传完成：已上传 ${successCount} 个素材。`
          : "上传完成：AI 已自动识别画面和语音内容。";
      setMessage(rejected > 0 ? `${base}（已达上限，其余 ${rejected} 个未上传）` : base);
    } else {
      setMessage(`上传完成：成功 ${successCount} 个，失败 ${failCount} 个，可重试失败的文件。`);
    }
  }

  function handleFileInputChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length > 0) {
      void handleAssetUploads(files);
    }
  }

  async function simulateAvatarClone() {
    if (!store) {
      setMessage("请先完成门店档案。");
      return;
    }

    if (!avatarConsent) {
      setMessage("请先确认肖像和声音授权。");
      return;
    }

    setPendingAction("avatar");

    try {
      const profile = await createAvatarApi({
        ownerId: store.ownerId,
        storeId: store.id,
        trainingVideoAssetId:
          selectedAssets.find((a) => a.type === "video")?.id ?? "asset_training_demo",
        consentAccepted: true
      });
      setLocalAvatar(profile);
      await queryClient.invalidateQueries({ queryKey: ["avatars"] });

      if (!script) {
        setMessage("AI 形象已创建。请先生成脚本，再合成数字人口播视频。");
        return;
      }

      const th = await requestTalkingHeadApi({
        avatarProfileId: profile.id,
        scriptDraftId: script.id
      });
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
      setMessage(`已提交数字人口播任务（作业 ${th.jobId}），可在进度面板查看实时进度，完成后在产物中预览。`);
    } finally {
      setPendingAction(null);
    }
  }

  async function generateStoryboard() {
    if (pendingAction || generating) return;
    if (!store) {
      setMessage("请先完成门店档案。");
      return;
    }

    if (selectedAnalyses.length === 0 || selectedAssets.length === 0) {
      setMessage("请先上传素材，让 AI 完成识别。");
      return;
    }

    setGenerating(true);

    try {
      const draft = await createScriptDraftApi({
        storeId: store.id,
        assetAnalysisIds: selectedAnalyses.map((a) => a.id),
        purpose: selectedPurpose,
        platform: "douyin",
        targetDurationSec: targetDuration
      });
      setStoryboardDraft(draft);
      setLocalScript(draft);
      await queryClient.invalidateQueries({ queryKey: ["script-drafts"] });
      setMessage("分镜脚本已生成，请确认后再渲染。");
    } finally {
      setGenerating(false);
    }
  }

  async function patchStoryboard(
    scenes: { order: number; text?: string; matchedAssetId?: string | null }[]
  ) {
    if (!storyboardDraft) return;
    const updated = await updateScriptDraftApi({ scriptDraftId: storyboardDraft.id, scenes });
    setStoryboardDraft(updated);
    setLocalScript(updated);
  }

  async function confirmAndRender(selection: {
    selectedAssetIds: string[];
    subtitleStyle: string;
    bgmTrackId: string;
  }) {
    if (!storyboardDraft) return;
    setPendingAction("render");

    try {
      const { jobs: plannedJobs } = await createRenderProjectApi({
        scriptDraftId: storyboardDraft.id,
        selectedAssetIds: selection.selectedAssetIds,
        avatarProfileId: avatar?.id,
        aspectRatio: "9:16",
        subtitleStyle: selection.subtitleStyle,
        bgmTrackId: selection.bgmTrackId || undefined
      });
      setLocalJobs(plannedJobs);
      setStoryboardDraft(null);
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
      setMessage("AI 正在生成你的视频：自动写文案、剪画面、加字幕、配音乐。");
    } finally {
      setPendingAction(null);
    }
  }

  async function handleClearCompleted() {
    if (clearingJobs || pendingAction) return;
    if (typeof window !== "undefined" && !window.confirm("确认清理所有已完成的任务记录？该操作不可撤销。")) {
      return;
    }
    setClearingJobs(true);
    try {
      const { deleted } = await clearCompletedJobsApi();
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
      setMessage(deleted > 0 ? `已清理 ${deleted} 条已完成任务。` : "没有可清理的已完成任务。");
    } catch (error) {
      const detail = error instanceof Error ? error.message : "清理失败，请稍后重试。";
      setMessage(`清理失败：${detail}`);
    } finally {
      setClearingJobs(false);
    }
  }

  return (
    <main className="workspace">
      <div className="ambientGlow" aria-hidden="true" />
      <div className="toast" role="status" aria-live="polite">
        <span className="toastBar" aria-hidden="true" />
        {message}
      </div>

      <section className="hero">
        <p className="eyebrow">AI 视频工作台</p>
        <h1>不会拍视频？AI 一键帮你生成门店引流片</h1>
        <p>0 基础也能做。自动写脚本、配音乐、加字幕，你只管传素材，剩下的 AI 全包，让顾客主动找到你。</p>
      </section>

      <nav className="stepper" aria-label="全局步骤导航">
        {workflowSteps.map((item, index) => {
          const isCurrent = index === currentStepIndex;
          const stateClass = item.complete ? "complete" : isCurrent ? "current" : "locked";

          return (
            <a
              aria-current={isCurrent ? "step" : undefined}
              className={`step ${stateClass}`}
              href={item.complete || isCurrent ? item.href : "#store-profile"}
              key={item.label}
            >
              <span className="stepNode">{item.complete ? "✓" : index + 1}</span>
              <span>
                <strong>{item.label}</strong>
                <small>{item.complete ? "已完成" : isCurrent ? "当前步骤" : "未解锁"}</small>
              </span>
            </a>
          );
        })}
      </nav>

      <section className="grid">
        <article className="card cardFeatured" id="store-profile">
          <div className="cardHighlight" aria-hidden="true" />
          <div className="cardHeader">
            <div>
              <h2>门店档案</h2>
              <p>3 步设置好门店信息，AI 后续自动记忆，不用重复填写。</p>
            </div>
            <span className={store ? "statusBadge success" : "statusBadge warning"}>{store ? "已完成" : "待完成"}</span>
          </div>

          <form className="form" noValidate onSubmit={handleStoreFormSubmit}>
            <div className="formStepHeader">
              <div>
                <span className="stepKicker">{selectedStoreStep.progress}</span>
                <h3>{selectedStoreStep.title}</h3>
                <p>{selectedStoreStep.description}</p>
              </div>
            </div>

            <div className="formFields">
              {selectedStoreStep.fields.map((field) => {
                const fieldError = errors[field.name];
                const errorId = `${field.name}-error`;

                if (field.name === "brandTone") {
                  return (
                    <fieldset className="toneField" key={field.name}>
                      <legend>
                        {field.label}
                        {field.required ? <span className="required">*</span> : null}
                      </legend>
                      <div className="choiceGrid compact">
                        {["亲切接地气", "高端精致", "活泼有趣"].map((tone) => (
                          <label className="choiceCard toneOption" key={tone}>
                            <input
                              type="radio"
                              value={tone}
                              {...register("brandTone", { required: field.required })}
                            />
                            <span>{tone}</span>
                          </label>
                        ))}
                      </div>
                      {fieldError ? (
                        <span className="fieldError" id={errorId} role="alert">
                          请填写{field.label}
                        </span>
                      ) : null}
                    </fieldset>
                  );
                }

                return (
                  <label className="field" key={field.name}>
                    <span>
                      {field.label}
                      {field.required ? <span className="required">*</span> : null}
                    </span>
                    {field.kind === "textarea" ? (
                      <textarea
                        aria-describedby={fieldError ? errorId : undefined}
                        aria-invalid={Boolean(fieldError)}
                        placeholder={field.placeholder}
                        rows={3}
                        {...register(field.name, { required: field.required })}
                      />
                    ) : field.kind === "select" ? (
                      <select
                        aria-describedby={fieldError ? errorId : undefined}
                        aria-invalid={Boolean(fieldError)}
                        {...register(field.name, { required: field.required })}
                      >
                        <option disabled hidden value="">
                          {field.placeholder}
                        </option>
                        {field.options?.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        aria-describedby={fieldError ? errorId : undefined}
                        aria-invalid={Boolean(fieldError)}
                        placeholder={field.placeholder}
                        {...register(field.name, { required: field.required })}
                      />
                    )}
                    {fieldError ? (
                      <span className="fieldError" id={errorId} role="alert">
                        请填写{field.label}
                      </span>
                    ) : null}
                  </label>
                );
              })}
            </div>

            <div className="formActions">
              {storeFormStep >= 1 ? (
                <button
                  className="secondaryButton"
                  disabled={Boolean(pendingAction)}
                  onClick={() => void handleSuggestStore()}
                  type="button"
                >
                  {pendingAction === "store" ? <span className="spinner" aria-hidden="true" /> : null}
                  AI 建议
                </button>
              ) : null}
              <button
                className="secondaryButton"
                disabled={storeFormStep === 0 || Boolean(pendingAction)}
                onClick={() => goToStoreFormStep(storeFormStep - 1)}
                type="button"
              >
                上一步
              </button>
              <button className="primaryButton" disabled={Boolean(pendingAction)} onClick={() => void submitCurrentStoreStep()} type="button">
                {pendingAction === "store" ? <span className="spinner" aria-hidden="true" /> : null}
                {storeFormStep < storeFormSteps.length - 1 ? "保存并继续" : "完成设置"}
              </button>
            </div>
          </form>
        </article>

        <article className="card" id="media-upload">
          <div className="cardHeader">
            <div>
              <h2>素材库</h2>
              <p>上传你的视频、图片或音频，AI 自动看懂内容并分类，找素材时一搜就有</p>
            </div>
            <span className={assets.length > 0 ? "statusBadge success" : "statusBadge warning"}>{assets.length > 0 ? "已完成" : "待完成"}</span>
          </div>

          <input
            ref={fileInputRef}
            accept="video/*,image/*,audio/*"
            className="srOnly"
            multiple
            onChange={handleFileInputChange}
            type="file"
          />

          <div
            className="uploadZone"
            onClick={assets.length === 0 && !pendingAction ? openFilePicker : undefined}
            onKeyDown={
              assets.length === 0 && !pendingAction
                ? (event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      openFilePicker();
                    }
                  }
                : undefined
            }
            role={assets.length === 0 ? "button" : undefined}
            tabIndex={assets.length === 0 && !pendingAction ? 0 : undefined}
          >
            {assets.length > 0 ? (
              <div className="mediaGrid" role="list">
                {assets.map((item) => {
                  const selected = selectedAssetIds.has(item.id);
                  return (
                    <div className={`mediaItem ${selected ? "selected" : ""}`} key={item.id} role="listitem">
                      <label className="mediaSelect">
                        <input
                          aria-label={`选择素材 ${item.originalFilename}`}
                          checked={selected}
                          onChange={() => toggleAssetSelected(item.id)}
                          type="checkbox"
                        />
                        <AssetThumbnail asset={item} />
                      </label>
                      <div className="mediaMeta">
                        <strong>{item.originalFilename}</strong>
                        <span>
                          {item.type} · {Math.max(1, Math.ceil(item.sizeBytes / 1024))}KB
                        </span>
                      </div>
                      <button
                        aria-label={`删除素材 ${item.originalFilename}`}
                        className="removeIcon"
                        onClick={() => void handleDeleteAsset(item.id)}
                        type="button"
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="emptyState">
                <svg aria-hidden="true" viewBox="0 0 120 90">
                  <rect height="62" rx="14" width="86" x="17" y="18" />
                  <path d="M44 54l13-13 12 12 8-8 15 18H30z" />
                  <circle cx="78" cy="34" r="6" />
                </svg>
                <strong>拖拽或点击上传视频/图片</strong>
                <span>可一次选择多个文件，上传后 AI 自动提取画面和语音内容。</span>
              </div>
            )}
            {pendingAction === "upload" ? (
              <div
                aria-label="上传中"
                aria-valuemax={100}
                aria-valuemin={0}
                aria-valuenow={overallUploadProgress}
                className="progressTrack"
                role="progressbar"
              >
                <span style={{ width: `${Math.max(overallUploadProgress, 8)}%` }} />
              </div>
            ) : null}
          </div>

          {assets.length > 0 ? (
            <p className="mediaSummary">已选 {selectedAssets.length} / 共 {assets.length}</p>
          ) : null}

          <button
            className="primaryButton"
            disabled={!store || Boolean(pendingAction)}
            onClick={openFilePicker}
            type="button"
          >
            {pendingAction === "upload" ? <span className="spinner" aria-hidden="true" /> : null}
            上传素材
          </button>

          {selectedAnalyses.length > 0 ? (
            <div className="result">
              <strong>AI 自动分类</strong>
              <div className="tagList">
                {Array.from(
                  new Set(selectedAnalyses.flatMap((a) => [...a.visualTags, ...a.businessTags]))
                ).map((tag) => (
                  <span className="techTag" key={tag}>
                    {tagDisplayLabels[tag] ?? tag}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </article>

        <article className="card" id="avatar-clone">
          <div className="cardHeader">
            <div>
              <h2>AI 分身</h2>
              <p>上传一段真人视频，AI 学习你的形象和声音，以后不用出镜也能“真人”出镜</p>
            </div>
            <span className={avatar ? "statusBadge success" : "statusBadge warning"}>{avatar ? "已完成" : "待完成"}</span>
          </div>

          {!avatar ? (
            <div className="emptyState avatarEmpty">
              <svg aria-hidden="true" viewBox="0 0 110 110">
                <circle cx="55" cy="42" r="18" />
                <path d="M24 90c5-19 17-29 31-29s26 10 31 29" />
                <path d="M20 54c0-23 15-39 35-39s35 16 35 39" />
              </svg>
              <span>还没有 AI 形象时，可先上传授权视频。</span>
            </div>
          ) : (
            <div className="result">
              <strong>AI 形象已创建</strong>
              <span>{avatar.trainingStatus === "ready" ? "已完成" : "正在训练你的 AI 形象…"}</span>
              <span className="resultHint">预计需要 5-10 分钟，完成后会通知你。</span>
            </div>
          )}

          <label className="consentBox">
            <input checked={avatarConsent} onChange={(event) => setAvatarConsent(event.target.checked)} type="checkbox" />
            <span>我已确认拥有该视频的肖像/声音使用权，同意生成 AI 形象</span>
          </label>

          <button
            className="primaryButton"
            disabled={!store || !avatarConsent || Boolean(pendingAction)}
            onClick={simulateAvatarClone}
            type="button"
          >
            {pendingAction === "avatar" ? <span className="spinner" aria-hidden="true" /> : null}
            创建 AI 形象
          </button>

          <details className="advancedNote">
            <summary>高级说明 (?)</summary>
            <p>接入主流 AI 形象服务；如果暂未就绪，会自动启用备用配音方案，保证视频按时出片。</p>
          </details>
        </article>

        <article className="card cardFeatured" id="one-click-video">
          <div className="cardHighlight" aria-hidden="true" />
          <div className="cardHeader">
            <div>
              <h2>智能成片</h2>
              <p>选好素材和目的，AI 自动写文案、剪画面、加字幕，直接出片</p>
            </div>
            <span className={script ? "statusBadge success" : "statusBadge warning"}>{script ? "已完成" : "待完成"}</span>
          </div>

          <div className="choiceGrid">
            {purposeOptions.map((purpose) => (
              <button
                className={selectedPurpose === purpose.value ? "purposeCard selected" : "purposeCard"}
                key={purpose.value}
                onClick={() => setSelectedPurpose(purpose.value)}
                type="button"
              >
                <strong>{purpose.label}</strong>
                <span>{purpose.description}</span>
              </button>
            ))}
          </div>

          {renderLocked ? (
            <p className="lockNotice">
              请先完成门店档案 <a href="#store-profile">去填写档案 →</a>
            </p>
          ) : null}
          {renderMissingAssets ? <p className="lockNotice">上传素材并完成 AI 识别后，就可以开始生成。</p> : null}

          <div className="choiceGrid" style={{ marginBottom: 12 }}>
            {[
              { value: 15, label: "短 · 约15秒" },
              { value: 30, label: "中 · 约30秒" },
              { value: 60, label: "长 · 约60秒" }
            ].map((d) => (
              <button
                key={d.value}
                type="button"
                className={targetDuration === d.value ? "purposeCard selected" : "purposeCard"}
                onClick={() => setTargetDuration(d.value)}
              >
                <strong>{d.label}</strong>
              </button>
            ))}
          </div>

          <button
            className="primaryButton"
            disabled={renderLocked || Boolean(renderMissingAssets) || generating || Boolean(pendingAction)}
            onClick={generateStoryboard}
            type="button"
          >
            {generating ? <span className="spinner" aria-hidden="true" /> : null}
            {renderLocked
              ? "请先完成门店档案"
              : renderMissingAssets
                ? "请至少勾选一个素材"
                : "生成分镜脚本"}
          </button>

          {script ? (
            <div className="result">
              <strong>{purposeLabels[script.purpose] ?? "营销视频"}</strong>
              <span>{script.hook}</span>
            </div>
          ) : null}
        </article>

        {storyboardDraft ? (
          <StoryboardConfirm
            key={storyboardDraft.id}
            draft={storyboardDraft}
            assets={assets}
            bgmTracks={bgmTracks}
            onPatch={patchStoryboard}
            onConfirm={confirmAndRender}
            pending={pendingAction === "render"}
          />
        ) : null}
      </section>

      <section className="statusPanel" aria-live="polite">
        <div className="cardHeader">
          <div>
            <h2>生成进度</h2>
            <p>AI 正在制作你的视频，AI 形象训练完成后自动合成。如果暂未就绪，会自动启用备用配音，保证视频按时出片。</p>
          </div>
          {hasTerminalJobs ? (
            <button
              className="secondaryButton cleanupButton"
              disabled={clearingJobs || Boolean(pendingAction)}
              onClick={() => void handleClearCompleted()}
              type="button"
            >
              {clearingJobs ? <span className="spinner" aria-hidden="true" /> : null}
              清理已完成
            </button>
          ) : null}
        </div>
        <div className="timeline">
          {(jobsWithProgress.length
            ? jobsWithProgress.map((job) => ({
                id: job.id,
                title: jobTypeLabels[job.type] ?? "视频任务",
                status: jobStatusLabels[job.status] ?? "准备中",
                tone: job.status,
                detail: `进度 ${job.progress}%`
              }))
            : [
                {
                  id: "empty-queue",
                  title: "当前任务队列",
                  status: "准备中",
                  tone: "queued",
                  detail: message
                }
              ]
          ).map((item) => (
            <div className={`timelineItem ${item.tone}`} key={item.id}>
              <span className="timelineDot" aria-hidden="true" />
              <div>
                <strong>{item.title}</strong>
                <span className="timelineStatus">{item.status}</span>
                <p>{item.detail}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {completedOutputs.length > 0 ? (
        <section className="statusPanel" id="render-outputs" aria-live="polite">
          <div className="cardHeader">
            <div>
              <h2>产物预览</h2>
              <p>视频已合成完成，点击播放预览，或下载成片直接使用。</p>
            </div>
          </div>
          <div className="timeline">
            {completedOutputs.map((output) => (
              <VideoOutputCard key={output.id} output={output} />
            ))}
          </div>
        </section>
      ) : null}
    </main>
  );
}

function AssetThumbnail({ asset }: { asset: Asset }) {
  // Short-lived presigned URL. NO polling / window-focus refetch / retry — the
  // dashboard's 429 death-spiral came from read amplification, so preview URLs
  // are fetched once per card mount and cached under the URL expiry.
  const { data } = useQuery({
    queryKey: ["asset-preview", asset.id],
    queryFn: () => fetchAssetPreviewUrl(asset.id),
    // staleTime < 5-min URL expiry is a safety margin; it does NOT auto-refetch
    // (no refetchInterval). Re-fetch only happens on card re-mount.
    staleTime: 4 * 60 * 1000,
    gcTime: 5 * 60 * 1000,
    retry: false,
    refetchOnWindowFocus: false
  });

  if (!data) {
    return <span className="thumbnail" aria-hidden="true" />;
  }
  // Dispatch on the API response's `type` (single source of truth) rather than
  // asset.type — they should agree, but data.type is what we just fetched.
  if (data.type === "image") {
    return <img alt={asset.originalFilename} className="thumbnailImg" src={data.url} />;
  }
  if (data.type === "video") {
    return <video className="thumbnailVideo" data-testid="asset-thumbnail-video" muted preload="metadata" src={data.url} />;
  }
  return <span className="thumbnail thumbnailAudio" aria-hidden="true" />;
}

function VideoOutputCard({ output }: { output: VideoOutput }) {
  // Presigned URLs are short-lived (~15min). Cache ~10min so switching tabs
  // doesn't re-hit the route, and let it refresh after expiry.
  const { data: url, isPending, isError } = useQuery({
    queryKey: ["output-url", output.id],
    queryFn: () => fetchVideoOutputUrl(output.id),
    staleTime: 10 * 60 * 1000
  });

  return (
    <div className="previewCard">
      {isPending ? (
        <div className="previewLoading">
          <span className="spinner" aria-hidden="true" />
          正在生成预览链接…
        </div>
      ) : isError ? (
        <div className="previewLoading">预览链接生成失败，请稍后刷新重试。</div>
      ) : (
        <video className="previewVideo" controls preload="metadata" src={url} />
      )}
      <div className="previewMeta">
        <div>
          <strong>成片视频</strong>
          <span>
            {output.durationSeconds} 秒 · {output.aspectRatio}
          </span>
        </div>
        {url ? (
          <a className="secondaryButton previewDownload" download href={url} rel="noopener noreferrer" target="_blank">
            下载成片
          </a>
        ) : null}
      </div>
    </div>
  );
}

function splitCsv(value: string): string[] {
  return value
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
}
