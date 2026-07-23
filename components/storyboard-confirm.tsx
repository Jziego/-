"use client";

import { useMemo, useState } from "react";
import type { Asset, ScriptDraft } from "@/lib/types";

const SUBTITLE_OPTIONS = [
  { value: "bold_bottom", label: "综艺黄（粗体底部）" },
  { value: "default", label: "标准白字" },
  { value: "minimal", label: "极简小字" },
];

interface Props {
  draft: ScriptDraft;
  assets: Asset[];
  bgmTracks: { id: string; name: string; category: string }[];
  onPatch: (scenes: { order: number; text?: string; matchedAssetId?: string | null }[]) => Promise<void>;
  onConfirm: (selection: { selectedAssetIds: string[]; subtitleStyle: string; bgmTrackId: string }) => Promise<void>;
  pending: boolean;
}

/** 分镜确认界面：逐镜改文案/换素材 + 全局字幕/BGM + 确认渲染。 */
export function StoryboardConfirm({ draft, assets, bgmTracks, onPatch, onConfirm, pending }: Props) {
  const [textByOrder, setTextByOrder] = useState<Record<number, string>>(() =>
    Object.fromEntries(draft.scenes.map((s) => [s.order, s.text])),
  );
  const [assetByOrder, setAssetByOrder] = useState<Record<number, string | null>>(() =>
    Object.fromEntries(draft.scenes.map((s) => [s.order, s.matchedAssetId ?? null])),
  );
  const [pickerForOrder, setPickerForOrder] = useState<number | null>(null);
  const [subtitleStyle, setSubtitleStyle] = useState("bold_bottom");
  const [bgmTrackId, setBgmTrackId] = useState(bgmTracks[0]?.id ?? "");

  const estimatedSec = useMemo(
    () => draft.scenes.reduce((sum, s) => sum + (s.durationSeconds || 0), 0),
    [draft.scenes],
  );

  async function patchText(order: number, text: string) {
    await onPatch([{ order, text }]);
  }

  async function patchAsset(order: number, matchedAssetId: string | null) {
    setAssetByOrder((prev) => ({ ...prev, [order]: matchedAssetId }));
    setPickerForOrder(null);
    await onPatch([{ order, matchedAssetId }]);
  }

  async function handleConfirm() {
    // 最终落地所有文本编辑（捕获未 blur 的改动）
    const scenes = draft.scenes.map((s) => ({
      order: s.order,
      text: textByOrder[s.order] ?? s.text,
      matchedAssetId: assetByOrder[s.order] ?? null,
    }));
    await onPatch(scenes);
    const selectedAssetIds = [...new Set(scenes.map((s) => s.matchedAssetId).filter((x): x is string => Boolean(x)))];
    await onConfirm({ selectedAssetIds, subtitleStyle, bgmTrackId });
  }

  return (
    <article className="card" id="storyboard-confirm">
      <div className="cardHeader">
        <div>
          <h2>分镜脚本</h2>
          <p>共 {draft.scenes.length} 镜 · 预计 {Math.round(estimatedSec)}s · 确认后开始渲染</p>
        </div>
      </div>

      {draft.scenes.map((scene) => {
        const matchedId = assetByOrder[scene.order] ?? null;
        const matched = assets.find((a) => a.id === matchedId);
        const isSwapped = matchedId !== (scene.matchedAssetId ?? null);
        const isPicker = pickerForOrder === scene.order;
        return (
          <div key={scene.order} className="storyboardRow" style={{ borderBottom: "1px solid #333", padding: "12px 0" }}>
            <strong>镜{scene.order}</strong>
            <span style={{ marginLeft: 8 }}>{scene.durationSeconds}s · {scene.role === "presenter" ? "口播" : "画面"}</span>
            <textarea
              aria-label={`镜${scene.order}文案`}
              value={textByOrder[scene.order] ?? ""}
              onChange={(e) => setTextByOrder((p) => ({ ...p, [scene.order]: e.target.value }))}
              onBlur={(e) => patchText(scene.order, e.target.value)}
              rows={2}
              style={{ width: "100%", margin: "6px 0" }}
            />
            <div>
              {matched ? (
                <span>匹配素材：{matched.originalFilename}（{isSwapped ? "已选" : (scene.matchTag ?? "已选")}）</span>
              ) : (
                <span style={{ color: "#ffb84d" }}>待匹配</span>
              )}{" "}
              <button type="button" onClick={() => setPickerForOrder(isPicker ? null : scene.order)}>
                {matched ? "换素材" : "选素材"}
              </button>
            </div>
            {isPicker ? (
              <div className="assetPicker" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
                {assets.map((a) => (
                  <button key={a.id} type="button" onClick={() => patchAsset(scene.order, a.id)} title={a.originalFilename}>
                    {a.originalFilename}
                  </button>
                ))}
                <button type="button" onClick={() => patchAsset(scene.order, null)}>清除</button>
              </div>
            ) : null}
          </div>
        );
      })}

      <div style={{ marginTop: 16, display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <label>
          字幕样式
          <select value={subtitleStyle} onChange={(e) => setSubtitleStyle(e.target.value)}>
            {SUBTITLE_OPTIONS.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
          </select>
        </label>
        <label>
          背景音乐
          <select value={bgmTrackId} onChange={(e) => setBgmTrackId(e.target.value)}>
            {bgmTracks.map((t) => (<option key={t.id} value={t.id}>{t.name}</option>))}
          </select>
        </label>
      </div>

      <button
        type="button"
        className="primaryButton"
        disabled={pending}
        onClick={handleConfirm}
        style={{ marginTop: 16 }}
      >
        {pending ? <span className="spinner" aria-hidden="true" /> : null}
        确认渲染
      </button>
    </article>
  );
}
