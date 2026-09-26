"use client";

import { useState } from "react";

interface Props {
  /** 区块标题（如「门店的主营业务」）。 */
  label: string;
  /** 已填条目。 */
  items: string[];
  /** 上限（主营 10 / 特色 12）。 */
  max: number;
  /** AI 候选池（未填入的候选）。 */
  candidates: string[];
  /** 候选池加载中。 */
  loading: boolean;
  onAdd: (value: string) => void;
  onRemove: (index: number) => void;
  onRefreshCandidates: () => void;
}

/**
 * 档案字段候选池（批次二，参照参考图）：已填条目列表 + 手动输入 + AI 候选池
 * （逐条「填入」+「重新生成一批」）。表单值仍由调用方以逗号串存 react-hook-form，
 * 本组件只收发数组，不感知表单库。
 */
export function StoreFieldCandidates({ label, items, max, candidates, loading, onAdd, onRemove, onRefreshCandidates }: Props) {
  const [manual, setManual] = useState("");
  const full = items.length >= max;
  const pool = candidates.filter((c) => !items.includes(c));

  /** 统一添加入口：按中英文逗号切分、逐条去重防空、满即止。 */
  function addValue(raw: string) {
    const parts = raw.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    let next = [...items];
    for (const part of parts) {
      if (next.length >= max || next.includes(part)) continue;
      next = [...next, part];
      onAdd(part);
    }
  }

  function submitManual() {
    if (!manual.trim() || full) return;
    addValue(manual);
    setManual("");
  }

  return (
    <div className="fieldCandidates" style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <strong>{label}</strong>
        <span style={{ fontSize: 12, color: "var(--muted, #888)" }}>{items.length}/{max}{full ? "（已达上限）" : ""}</span>
      </div>

      {items.length > 0 ? (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 4 }}>
          {items.map((item, index) => (
            <li key={`${item}-${index}`} style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <span>{index + 1}. <span>{item}</span></span>
              <button type="button" className="secondaryButton" aria-label={`删除 ${item}`} onClick={() => onRemove(index)}>删除</button>
            </li>
          ))}
        </ul>
      ) : null}

      <input
        type="text"
        placeholder="手动输入后回车添加"
        value={manual}
        disabled={full}
        maxLength={30}
        onChange={(e) => setManual(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submitManual(); } }}
      />

      <div style={{ borderTop: "1px solid var(--border, #333)", paddingTop: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 13 }}>选择你的{label.replace(/^门店的/, "")}</span>
          <button type="button" className="secondaryButton" disabled={loading} onClick={onRefreshCandidates}>
            {loading ? <span className="spinner" aria-hidden="true" /> : null}
            ↻ 重新生成一批
          </button>
        </div>
        {pool.length > 0 ? (
          <ul style={{ listStyle: "none", margin: "8px 0 0", padding: 0, display: "grid", gap: 4 }}>
            {pool.map((candidate) => (
              <li key={candidate} style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <span>{candidate}</span>
                <button type="button" className="secondaryButton" disabled={full} aria-label={`填入 ${candidate}`} onClick={() => addValue(candidate)}>填入</button>
              </li>
            ))}
          </ul>
        ) : (
          <p style={{ fontSize: 12, color: "var(--muted, #888)" }}>{loading ? "AI 生成候选中…" : "点「重新生成一批」让 AI 给候选"}</p>
        )}
      </div>
    </div>
  );
}
