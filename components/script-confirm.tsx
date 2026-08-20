"use client";

import { useMemo, useState } from "react";
import { findHighlightRanges } from "@/lib/highlight-ranges";
import type { AvatarProfile, ScriptDraft } from "@/lib/types";

const SUBTITLE_OPTIONS = [
  { value: "bold_bottom", label: "综艺黄（粗体底部）" },
  { value: "default", label: "标准白字" },
  { value: "minimal", label: "极简小字" },
];

/** 中文口播语速假设（与 scene-derive 一致），仅用于预估时长提示。 */
const CHARS_PER_SECOND = 4.5;

export interface ScriptConfirmSelection {
  voiceover: string;
  selectedAssetIds: string[];
  avatarProfileIds: string[];
  subtitleStyle: string;
  bgmTrackId: string;
}

interface Props {
  draft: ScriptDraft;
  avatars: AvatarProfile[];
  bgmTracks: { id: string; name: string; category: string }[];
  /** 素材库完整勾选集合（未匹配的素材也必须进入渲染，B2 修复语义不变）。 */
  librarySelectedAssetIds: string[];
  onConfirm: (selection: ScriptConfirmSelection) => Promise<void>;
  pending: boolean;
}

/** 把口播稿按命中关键词切为 text/mark 片段（区间来自共享的 findHighlightRanges）。 */
function highlightParts(text: string, words: string[]): Array<{ text: string; hit: boolean }> {
  const ranges = findHighlightRanges(text, words);
  if (ranges.length === 0) return [{ text, hit: false }];
  const parts: Array<{ text: string; hit: boolean }> = [];
  let cursor = 0;
  for (const [s, e] of ranges) {
    if (s > cursor) parts.push({ text: text.slice(cursor, s), hit: false });
    parts.push({ text: text.slice(s, e), hit: true });
    cursor = e;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), hit: false });
  return parts;
}

/**
 * 口播确认卡片（Phase 2 去分镜）：标黄高亮预览 + 整稿编辑 + 形象单选 +
 * 字幕样式 + BGM（自 StoryboardConfirm 挪入）→ 确认生成。
 */
export function ScriptConfirm({ draft, avatars, bgmTracks, librarySelectedAssetIds, onConfirm, pending }: Props) {
  const [voiceover, setVoiceover] = useState(draft.voiceover);
  const [avatarId, setAvatarId] = useState(
    () => avatars.find((a) => a.trainingStatus === "ready")?.id ?? "",
  );
  const [subtitleStyle, setSubtitleStyle] = useState("bold_bottom");
  const [bgmTrackId, setBgmTrackId] = useState(bgmTracks[0]?.id ?? "");

  // 标黄词随编辑实时失效（spec §5.1：文中不存在的词渲染时自动失效）
  const parts = useMemo(
    () => highlightParts(voiceover, draft.highlights ?? []),
    [voiceover, draft.highlights],
  );
  const charCount = Array.from(voiceover).length;
  const estimatedSec = Math.round(charCount / CHARS_PER_SECOND);
  const canConfirm = voiceover.trim().length > 0 && !pending;

  async function handleConfirm() {
    await onConfirm({
      voiceover: voiceover.trim(),
      selectedAssetIds: librarySelectedAssetIds,
      avatarProfileIds: avatarId ? [avatarId] : [],
      subtitleStyle,
      bgmTrackId,
    });
  }

  return (
    <div className="scriptConfirm" id="script-confirm">
      <h3>确认口播稿</h3>
      <p className="scriptMeta">
        约 {charCount} 字 · 预计 {estimatedSec}s · 黄色为关键词高亮
      </p>

      <div className="voiceoverPreview" aria-label="口播稿预览">
        {parts.map((p, i) =>
          p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>,
        )}
      </div>

      <textarea
        aria-label="口播稿编辑"
        value={voiceover}
        onChange={(e) => setVoiceover(e.target.value)}
        rows={5}
        style={{ width: "100%", margin: "6px 0" }}
      />

      <fieldset className="avatarPicker">
        <legend>出镜形象</legend>
        <label>
          <input
            type="radio"
            name="avatar"
            checked={avatarId === ""}
            onChange={() => setAvatarId("")}
          />
          不用数字人（纯素材成片）
        </label>
        {avatars.map((a, i) => (
          <label key={a.id}>
            <input
              type="radio"
              name="avatar"
              checked={avatarId === a.id}
              disabled={a.trainingStatus !== "ready"}
              onChange={() => setAvatarId(a.id)}
            />
            AI 形象 {i + 1}
            {a.trainingStatus === "ready" ? "" : "（训练中）"}
          </label>
        ))}
      </fieldset>

      <div style={{ marginTop: 12, display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <label>
          字幕样式
          <select value={subtitleStyle} onChange={(e) => setSubtitleStyle(e.target.value)}>
            {SUBTITLE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <label>
          背景音乐
          <select value={bgmTrackId} onChange={(e) => setBgmTrackId(e.target.value)}>
            <option value="">无音乐</option>
            {bgmTracks.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </label>
      </div>

      <button
        type="button"
        className="primaryButton"
        disabled={!canConfirm}
        onClick={handleConfirm}
        style={{ marginTop: 16 }}
      >
        {pending ? <span className="spinner" aria-hidden="true" /> : null}
        确认生成
      </button>
    </div>
  );
}
