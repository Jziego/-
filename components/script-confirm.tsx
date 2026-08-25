"use client";

import { useMemo, useState } from "react";
import { estimateRenderCost } from "@/lib/cost-estimate";
import { findHighlightRanges } from "@/lib/highlight-ranges";
import { deriveSegmentsFromVoiceover } from "@/lib/services/scene-derive";
import { SPEECH_CHARS_PER_SECOND } from "@/lib/speech-rate";
import type { AvatarProfile, ScriptDraft } from "@/lib/types";

const SUBTITLE_OPTIONS = [
  { value: "bold_bottom", label: "综艺黄（粗体底部）" },
  { value: "default", label: "标准白字" },
  { value: "minimal", label: "极简小字" },
];

// 镜像服务端上限（app/api/script-drafts/[id]/route.ts 的 MAX_VOICEOVER_CHARS），
// 编辑器本地截断，避免 PATCH 被 400 拒绝。
const MAX_VOICEOVER_CHARS = 2000;

// 形象多选上限（Phase 3，spec §6.4）；服务端 render-projects 路由有同名上限校验。
const MAX_RENDER_AVATARS = 3;

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
 * 口播确认卡片（Phase 2 去分镜）：标黄高亮预览 + 整稿编辑 + 形象多选（≤3，Phase 3）+
 * 字幕样式 + BGM（自旧分镜确认卡片挪入）→ 确认生成。
 */
export function ScriptConfirm({ draft, avatars, bgmTracks, librarySelectedAssetIds, onConfirm, pending }: Props) {
  const [voiceover, setVoiceover] = useState(draft.voiceover);
  // 形象多选（Phase 3，spec §6.4）：≤3，默认勾选第一个 ready 形象；全不勾 = 纯素材成片。
  const [avatarIds, setAvatarIds] = useState<string[]>(
    () => {
      const first = avatars.find((a) => a.trainingStatus === "ready");
      return first ? [first.id] : [];
    },
  );
  const [subtitleStyle, setSubtitleStyle] = useState("bold_bottom");
  const [bgmTrackId, setBgmTrackId] = useState(bgmTracks[0]?.id ?? "");

  // 标黄词随编辑实时失效（spec §5.1：文中不存在的词渲染时自动失效）
  const parts = useMemo(
    () => highlightParts(voiceover, draft.highlights ?? []),
    [voiceover, draft.highlights],
  );
  const charCount = Array.from(voiceover).length;
  // 预估时长：语速取全局唯一来源 lib/speech-rate.ts
  const estimatedSec = Math.round(charCount / SPEECH_CHARS_PER_SECOND);
  // 数字人成本预估（spec §6.4）：跟随编辑中的口播稿实时重切 segments
  // （prev 命中保留出镜标记，与服务端 PATCH 重切同源），出镜段/画外音段分两档计价。
  const costEstimate = useMemo(
    () => estimateRenderCost(deriveSegmentsFromVoiceover(voiceover, { prev: draft.segments }), avatarIds.length),
    [voiceover, draft.segments, avatarIds.length],
  );
  const canConfirm = voiceover.trim().length > 0 && !pending;

  async function handleConfirm() {
    await onConfirm({
      voiceover: voiceover.trim(),
      selectedAssetIds: librarySelectedAssetIds,
      avatarProfileIds: avatarIds,
      subtitleStyle,
      bgmTrackId,
    });
  }

  return (
    <div className="scriptConfirm" id="script-confirm">
      <h3>确认口播稿</h3>
      <p className="scriptMeta">
        约 {charCount} / {MAX_VOICEOVER_CHARS} 字 · 预计 {estimatedSec}s · 高亮处为关键词
      </p>

      <div className="voiceoverPreview" role="group" aria-label="口播稿预览">
        {parts.map((p, i) =>
          p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>,
        )}
      </div>

      <textarea
        aria-label="口播稿编辑"
        maxLength={MAX_VOICEOVER_CHARS}
        value={voiceover}
        onChange={(e) => setVoiceover(e.target.value)}
        rows={5}
        style={{ width: "100%", margin: "6px 0" }}
      />

      <fieldset className="avatarPicker">
        <legend>出镜形象（可多选，轮播出镜，最多 {MAX_RENDER_AVATARS} 个；全不勾 = 纯素材成片）</legend>
        {avatars.map((a) => {
          const checked = avatarIds.includes(a.id);
          const ready = a.trainingStatus === "ready";
          const disabled = !ready || (!checked && avatarIds.length >= MAX_RENDER_AVATARS);
          return (
            <label key={a.id}>
              <input
                type="checkbox"
                name="avatar"
                checked={checked}
                disabled={disabled}
                onChange={() =>
                  setAvatarIds((prev) =>
                    checked ? prev.filter((id) => id !== a.id) : [...prev, a.id]
                  )
                }
              />
              {a.name || "未命名形象"}
              {ready ? "" : "（不可用）"}
            </label>
          );
        })}
        {avatars.length === 0 ? <span>暂无可用形象，将生成纯素材成片。</span> : null}
      </fieldset>

      {avatarIds.length > 0 ? (
        <p className="costHint" aria-label="成本预估">
          预计数字人成本约 ${costEstimate.totalUsd.toFixed(2)}（出镜 {costEstimate.onCameraSec}s +
          画外音 {costEstimate.voiceoverSec}s · 消耗 1 次生成配额）
        </p>
      ) : null}

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
