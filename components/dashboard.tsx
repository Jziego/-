"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import {
  analyzeAssetApi,
  createAvatarApi,
  createRenderProjectApi,
  createScriptDraftApi,
  createUploadIntentApi,
  fetchAssetAnalyses,
  fetchAssets,
  fetchAvatars,
  fetchJobs,
  fetchStores,
  requestTalkingHeadApi,
  saveAsset,
  saveStore
} from "@/lib/api-client";
import { clearStoreDraft, loadStoreDraft, loadStoreDraftStep, saveStoreDraft, saveStoreDraftStep } from "@/lib/draft-storage";
import { createId, nowIso } from "@/lib/ids";
import type { Asset, AssetAnalysis, AvatarProfile, Job, MarketingPurpose, ScriptDraft, StoreProfile } from "@/lib/types";

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
  asset_analysis: "AI 识别素材",
  avatar_generation: "AI 形象训练",
  video_render: "视频合成中",
  slideshow_render: "备用配音方案",
  subtitle_generation: "字幕生成"
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
  const [localAsset, setLocalAsset] = useState<Asset | null>(null);
  const [localAnalysis, setLocalAnalysis] = useState<AssetAnalysis | null>(null);
  const [localAvatar, setLocalAvatar] = useState<AvatarProfile | null>(null);
  const [script, setScript] = useState<ScriptDraft | null>(null);
  const [localJobs, setLocalJobs] = useState<Job[] | null>(null);
  const [message, setMessage] = useState("准备开始：先完成门店档案。");
  const [storeFormStep, setStoreFormStep] = useState(getInitialStoreFormStep);
  const [avatarConsent, setAvatarConsent] = useState(false);
  const [selectedPurpose, setSelectedPurpose] = useState<MarketingPurpose>("store_traffic");
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);

  const { data: stores = [] } = useQuery({
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
      const currentJobs = localJobs ?? query.state.data ?? [];
      return currentJobs.some((job) => job.status === "queued" || job.status === "processing") ? 5000 : false;
    }
  });

  const store = localStore ?? stores[0] ?? null;
  const asset =
    localAsset ?? (store ? (serverAssets.find((item) => item.storeId === store.id) ?? null) : null);
  const analysis =
    localAnalysis ?? (asset ? (serverAnalyses.find((item) => item.assetId === asset.id) ?? null) : null);
  const avatar =
    localAvatar ?? (store ? (serverAvatars.find((item) => item.storeId === store.id) ?? null) : null);
  const jobs = localJobs ?? serverJobs;
  const {
    control,
    register,
    trigger,
    getValues,
    getFieldState,
    setValue,
    reset,
    formState: { errors }
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
  }, [reset]);

  useEffect(() => {
    saveStoreDraft(currentDraft);
  }, [currentDraft]);

  const currentStepIndex = useMemo(() => {
    if (!store) return 0;
    if (!asset || !analysis) return 1;
    if (!avatar) return 2;
    return 3;
  }, [analysis, asset, avatar, store]);

  const workflowSteps = useMemo(
    () => [
      { label: "门店档案", href: "#store-profile", complete: Boolean(store) },
      { label: "素材库", href: "#media-upload", complete: Boolean(asset && analysis) },
      { label: "AI 分身", href: "#avatar-clone", complete: Boolean(avatar) },
      { label: "智能成片", href: "#one-click-video", complete: Boolean(script) }
    ],
    [analysis, asset, avatar, script, store]
  );

  const selectedStoreStep = storeFormSteps[storeFormStep];
  const renderLocked = !store;
  const renderMissingAssets = store && (!asset || !analysis);

  function goToStoreFormStep(step: number) {
    const nextStep = normalizeStoreFormStep(step);
    setStoreFormStep(nextStep);
    saveStoreDraftStep(nextStep);
  }

  async function submitCurrentStoreStep() {
    if (pendingAction) return;

    const isLastStep = storeFormStep >= storeFormSteps.length - 1;
    const fieldsToValidate = (isLastStep
      ? storeFormSteps.flatMap((step) => step.fields)
      : selectedStoreStep.fields) as StoreField[];
    const fieldNames = fieldsToValidate.map((field) => field.name);

    setPendingAction("store");

    try {
      if (typeof document !== "undefined") {
        for (const name of fieldNames) {
          const el = document.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
            `[name="${name}"]`
          );
          if (el) {
            setValue(name, el.value, { shouldValidate: false, shouldDirty: true });
          }
        }
      }

      if (isLastStep) {
        const merged = mergeStoreDraftWithDefaults(getValues());
        for (const key of Object.keys(merged) as StoreFieldName[]) {
          setValue(key, merged[key], { shouldValidate: false, shouldDirty: true });
        }
      }

      const valid = await trigger(fieldNames, { shouldFocus: true });

      if (!valid) {
        const visibleFields = isLastStep ? selectedStoreStep.fields : fieldsToValidate;
        const firstInvalidField = visibleFields.find((field) => getFieldState(field.name).invalid);
        setMessage(firstInvalidField ? `请先填写${firstInvalidField.label}。` : "请先补全当前步骤的必填项。");
        scrollToFirstFieldError(visibleFields);
        return;
      }

      if (!isLastStep) {
        goToStoreFormStep(storeFormStep + 1);
        setMessage("已保存本步内容，继续完善门店档案。");
        return;
      }

      const values = mergeStoreDraftWithDefaults(getValues());
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
      clearStoreDraft();
      await queryClient.invalidateQueries({ queryKey: ["stores"] });
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

  async function simulateAssetUpload() {
    if (!store) {
      setMessage("请先完成门店档案。");
      return;
    }

    setPendingAction("upload");

    try {
      const intent = await createUploadIntentApi({
        ownerId: store.ownerId,
        storeId: store.id,
        filename: "fresh-noodles.mp4",
        contentType: "video/mp4",
        sizeBytes: 12_000_000
      });
      const uploadedAsset = await saveAsset({
        id: intent.assetId,
        ownerId: store.ownerId,
        storeId: store.id,
        type: "video",
        originalFilename: "fresh-noodles.mp4",
        storageKey: intent.storageKey,
        mimeType: "video/mp4",
        sizeBytes: 12_000_000,
        durationSeconds: 18,
        width: 1080,
        height: 1920,
        tags: [],
        businessTags: [],
        status: "uploaded",
        createdAt: nowIso()
      });
      const analyzed = await analyzeAssetApi({
        assetId: uploadedAsset.id,
        storeId: store.id,
        visualLabels: ["food", "person", "storefront"],
        transcript: `${store.mainProducts[0]}刚出锅，午餐出餐很快`
      });
      setLocalAsset(uploadedAsset);
      setLocalAnalysis(analyzed);
      await queryClient.invalidateQueries({ queryKey: ["assets"] });
      await queryClient.invalidateQueries({ queryKey: ["asset-analyses"] });
      setMessage("上传完成：AI 已自动识别画面和语音内容。");
    } finally {
      setPendingAction(null);
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
        trainingVideoAssetId: asset?.id ?? "asset_training_demo",
        consentAccepted: true
      });
      await requestTalkingHeadApi({
        avatarProfileId: profile.id,
        scriptText: "今天来店里尝尝招牌产品",
        forceFallback: true
      });

      setLocalAvatar(profile);
      await queryClient.invalidateQueries({ queryKey: ["avatars"] });
      setMessage("已提交：正在训练你的 AI 形象，完成后自动合成视频；若暂未就绪会自动启用备用配音，保证按时出片。");
    } finally {
      setPendingAction(null);
    }
  }

  async function simulateOneClickRender() {
    if (!store) {
      setMessage("请先完成门店档案。");
      return;
    }

    if (!analysis || !asset) {
      setMessage("请先上传素材，让 AI 完成识别。");
      return;
    }

    setPendingAction("render");

    try {
      const draft = await createScriptDraftApi({
        storeId: store.id,
        assetAnalysisIds: [analysis.id],
        purpose: selectedPurpose,
        platform: "douyin"
      });
      const { jobs: plannedJobs } = await createRenderProjectApi({
        scriptDraftId: draft.id,
        selectedAssetIds: [asset.id],
        avatarProfileId: avatar?.id,
        aspectRatio: "9:16",
        subtitleStyle: "bold_bottom",
        bgmTrackId: "bgm_warm"
      });

      setScript(draft);
      setLocalJobs(plannedJobs);
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
      setMessage("AI 正在生成你的视频：自动写文案、剪画面、加字幕、配音乐。");
    } finally {
      setPendingAction(null);
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
            <span className={analysis ? "statusBadge success" : "statusBadge warning"}>{analysis ? "已完成" : "待完成"}</span>
          </div>

          <div className="uploadZone">
            {asset ? (
              <div className="mediaItem">
                <div className="thumbnail" aria-hidden="true" />
                <div>
                  <strong>{asset.originalFilename}</strong>
                  <span>{asset.durationSeconds ?? 0} 秒 · 已上传</span>
                </div>
                <span className="removeIcon" aria-hidden="true">
                  ×
                </span>
              </div>
            ) : (
              <div className="emptyState">
                <svg aria-hidden="true" viewBox="0 0 120 90">
                  <rect height="62" rx="14" width="86" x="17" y="18" />
                  <path d="M44 54l13-13 12 12 8-8 15 18H30z" />
                  <circle cx="78" cy="34" r="6" />
                </svg>
                <strong>拖拽或点击上传视频/图片</strong>
                <span>上传后 AI 自动提取画面和语音内容。</span>
              </div>
            )}
            {pendingAction === "upload" ? (
              <div className="progressTrack" aria-label="上传中">
                <span />
              </div>
            ) : null}
          </div>

          <button className="primaryButton" disabled={!store || Boolean(pendingAction)} onClick={simulateAssetUpload} type="button">
            {pendingAction === "upload" ? <span className="spinner" aria-hidden="true" /> : null}
            上传素材
          </button>

          {analysis ? (
            <div className="result">
              <strong>AI 自动分类</strong>
              <div className="tagList">
                {[...analysis.visualTags, ...analysis.businessTags].map((tag) => (
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

          <button
            className="primaryButton"
            disabled={renderLocked || Boolean(renderMissingAssets) || Boolean(pendingAction)}
            onClick={simulateOneClickRender}
            type="button"
          >
            {pendingAction === "render" ? <span className="spinner" aria-hidden="true" /> : null}
            {renderLocked ? "请先完成门店档案" : "开始生成视频"}
          </button>

          {script ? (
            <div className="result">
              <strong>{purposeLabels[script.purpose] ?? "营销视频"}</strong>
              <span>{script.hook}</span>
            </div>
          ) : null}
        </article>
      </section>

      <section className="statusPanel" aria-live="polite">
        <div className="cardHeader">
          <div>
            <h2>生成进度</h2>
            <p>AI 正在制作你的视频，AI 形象训练完成后自动合成。如果暂未就绪，会自动启用备用配音，保证视频按时出片。</p>
          </div>
        </div>
        <div className="timeline">
          {(jobs.length
            ? jobs.map((job) => ({
                id: job.id,
                title: jobTypeLabels[job.type] ?? "视频任务",
                status: jobStatusLabels[job.status] ?? "准备中",
                tone: job.status,
                detail: job.type === "slideshow_render" ? "备用方案已就绪，确保视频顺利生成。" : `进度 ${job.progress}%`
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
    </main>
  );
}

function splitCsv(value: string): string[] {
  return value
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
}
