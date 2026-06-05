"use client";

import { useEffect, useMemo, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { loadStoreDraft, saveStoreDraft } from "@/lib/draft-storage";
import { classifyAsset, createUploadIntent } from "@/lib/services/assets";
import { createMockAvatarProvider, createAvatarProfile, requestAvatarTalkingHead } from "@/lib/services/avatar-provider";
import { createScriptDraft } from "@/lib/services/script-engine";
import { createRenderProject, planRenderJobs, recoverRenderFailure } from "@/lib/services/render-pipeline";
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

export function Dashboard() {
  const [store, setStore] = useState<StoreProfile | null>(null);
  const [asset, setAsset] = useState<Asset | null>(null);
  const [analysis, setAnalysis] = useState<AssetAnalysis | null>(null);
  const [avatar, setAvatar] = useState<AvatarProfile | null>(null);
  const [script, setScript] = useState<ScriptDraft | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [message, setMessage] = useState("准备开始：先填写门店档案，再上传素材。");
  const { control, register, handleSubmit, reset } = useForm<StoreFormValues>({
    defaultValues: defaultStoreForm
  });
  const currentDraft = useWatch({ control });

  useEffect(() => {
    const draft = loadStoreDraft<StoreFormValues>();
    if (draft) reset(draft);
  }, [reset]);

  useEffect(() => {
    saveStoreDraft(currentDraft);
  }, [currentDraft]);

  const readiness = useMemo(
    () => [
      { label: "档案", ready: Boolean(store) },
      { label: "素材", ready: Boolean(asset && analysis) },
      { label: "数字人", ready: Boolean(avatar) },
      { label: "脚本", ready: Boolean(script) }
    ],
    [analysis, asset, avatar, script, store]
  );

  const onSubmitStore = handleSubmit((values) => {
    const now = new Date().toISOString();
    const profile: StoreProfile = {
      id: "store_demo",
      ownerId: "demo_user",
      name: values.name,
      industry: values.industry,
      location: values.location,
      mainProducts: splitCsv(values.mainProducts),
      targetCustomers: splitCsv(values.targetCustomers),
      sellingPoints: splitCsv(values.sellingPoints),
      promotions: splitCsv(values.promotions),
      brandTone: values.brandTone,
      forbiddenWords: splitCsv(values.forbiddenWords),
      createdAt: now,
      updatedAt: now
    };
    setStore(profile);
    setMessage("门店档案已保存为本地草稿，并可同步到服务端。");
  });

  async function simulateAssetUpload() {
    if (!store) {
      setMessage("请先完成门店建档。");
      return;
    }

    const intent = createUploadIntent({
      ownerId: store.ownerId,
      storeId: store.id,
      filename: "fresh-noodles.mp4",
      contentType: "video/mp4",
      sizeBytes: 12_000_000
    });
    const uploadedAsset: Asset = {
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
      createdAt: new Date().toISOString()
    };
    const analyzed = await classifyAsset({
      asset: uploadedAsset,
      store,
      visualLabels: ["food", "person", "storefront"],
      transcript: `${store.mainProducts[0]}刚出锅，午餐出餐很快`
    });
    setAsset(uploadedAsset);
    setAnalysis(analyzed);
    setMessage("素材已生成签名直传地址，并完成自动标签分析。");
  }

  async function simulateAvatarClone() {
    if (!store) {
      setMessage("请先完成门店建档。");
      return;
    }

    const profile = await createAvatarProfile({
      ownerId: store.ownerId,
      storeId: store.id,
      provider: createMockAvatarProvider({ avatarId: "provider_avatar_demo", voiceId: "provider_voice_demo" }),
      trainingVideoAssetId: "asset_training_demo",
      consentAccepted: true
    });
    const fallbackPreview = await requestAvatarTalkingHead({
      provider: createMockAvatarProvider({ failTalkingHead: true }),
      avatarProfileId: profile.id,
      providerAvatarId: profile.providerAvatarId ?? "",
      providerVoiceId: profile.providerVoiceId,
      scriptText: "今天来店里尝尝招牌产品",
      allowFallback: true
    });

    setAvatar(profile);
    setMessage(`数字人训练任务已创建，试听降级模式：${fallbackPreview.mode}。`);
  }

  async function simulateOneClickRender() {
    if (!store || !analysis || !asset) {
      setMessage("请先完成门店档案和素材分析。");
      return;
    }

    const draft = await createScriptDraft({
      store,
      assetAnalyses: [analysis],
      purpose: "store_traffic",
      platform: "douyin"
    });
    const project = createRenderProject({
      ownerId: store.ownerId,
      storeId: store.id,
      scriptDraft: draft,
      selectedAssetIds: [asset.id],
      avatarProfile: avatar ?? undefined,
      aspectRatio: "9:16",
      subtitleStyle: "bold_bottom",
      bgmTrackId: "bgm_warm"
    });
    const plannedJobs = planRenderJobs({ project, includeAvatar: Boolean(avatar) });
    const fallbackJob = recoverRenderFailure({
      projectId: project.id,
      ownerId: store.ownerId,
      reason: "ffmpeg_timeout"
    });

    setScript(draft);
    setJobs([...plannedJobs, fallbackJob]);
    setMessage("AI 文案、数字人可选片段和后端渲染任务已编排。");
  }

  return (
    <main className="workspace">
      <section className="hero">
        <p className="eyebrow">AI Short Video SaaS</p>
        <h1>小店老板的一键短视频助手</h1>
        <p>
          单页工作台覆盖门店建档、素材上传、数字人克隆和一键成片。前端负责交互和轻预览，后端负责对象存储、AI 编排、任务队列和视频渲染。
        </p>
        <div className="readiness" aria-label="模块完成状态">
          {readiness.map((item) => (
            <span key={item.label} className={item.ready ? "pill ready" : "pill"}>
              {item.label} {item.ready ? "已就绪" : "待完成"}
            </span>
          ))}
        </div>
      </section>

      <section className="grid">
        <article className="card">
          <div className="cardHeader">
            <h2>门店建档</h2>
            <span>本地草稿 + 服务端同步</span>
          </div>
          <form className="form" onSubmit={onSubmitStore}>
            <label>
              门店名称
              <input {...register("name", { required: true })} />
            </label>
            <label>
              行业
              <input {...register("industry", { required: true })} />
            </label>
            <label>
              位置
              <input {...register("location")} />
            </label>
            <label>
              主营产品
              <input {...register("mainProducts", { required: true })} />
            </label>
            <label>
              目标顾客
              <input {...register("targetCustomers", { required: true })} />
            </label>
            <label>
              卖点
              <input {...register("sellingPoints", { required: true })} />
            </label>
            <label>
              促销活动
              <input {...register("promotions")} />
            </label>
            <label>
              品牌语气
              <input {...register("brandTone")} />
            </label>
            <label>
              禁用词
              <input {...register("forbiddenWords")} />
            </label>
            <button type="submit">保存档案</button>
          </form>
        </article>

        <article className="card">
          <div className="cardHeader">
            <h2>素材上传</h2>
            <span>对象存储直传 + 自动标签队列</span>
          </div>
          <p>支持视频、图片、音频直传对象存储。浏览器可做缩略图和时长读取，正式转码、抽帧、ASR 和视觉识别交给后端队列。</p>
          <button type="button" onClick={simulateAssetUpload}>模拟上传并分析</button>
          {analysis ? (
            <div className="result">
              <strong>标签：</strong>
              {[...analysis.visualTags, ...analysis.businessTags].join(" / ")}
            </div>
          ) : null}
        </article>

        <article className="card">
          <div className="cardHeader">
            <h2>数字人克隆</h2>
            <span>第三方数字人 API + TTS 降级</span>
          </div>
          <p>上传真人训练视频前必须确认肖像和声音授权。第一版通过 provider 接口接入 HeyGen/D-ID/Tavus 等服务，失败时降级到 TTS 旁白或模板数字人。</p>
          <button type="button" onClick={simulateAvatarClone}>创建数字人任务</button>
          {avatar ? <div className="result">训练状态：{avatar.trainingStatus}，供应商：{avatar.provider}</div> : null}
        </article>

        <article className="card">
          <div className="cardHeader">
            <h2>一键成片</h2>
            <span>后端渲染 Worker + 字幕/BGM</span>
          </div>
          <p>选择素材和营销目的后，AI 生成标题、钩子、分镜、旁白、字幕和 CTA；最终视频由后端 Worker 合成字幕、BGM、转场和数字人片段。</p>
          <div className="buttonRow">
            {(["store_traffic", "new_product", "promotion"] satisfies MarketingPurpose[]).map((purpose) => (
              <span className="pill" key={purpose}>{purpose}</span>
            ))}
          </div>
          <button type="button" onClick={simulateOneClickRender}>生成脚本与渲染任务</button>
          {script ? <div className="result">文案：{script.hook}</div> : null}
        </article>
      </section>

      <section className="statusPanel" aria-live="polite">
        <h2>任务状态与降级</h2>
        <p>{message}</p>
        <div className="jobs">
          {jobs.map((job) => (
            <span className="pill" key={job.id}>
              {job.type}: {job.status}
            </span>
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
