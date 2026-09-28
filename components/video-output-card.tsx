"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deleteVideoOutputApi, fetchVideoOutputUrl } from "@/lib/api-client";
import type { VideoOutput, VideoOutputKind } from "@/lib/types";

const KIND_LABELS: Record<VideoOutputKind, string> = {
  talking_head: "口播成片",
  segmented_voice: "分段口播",
  final_composite: "素材成片",
  slideshow: "幻灯片"
};

function formatCreatedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function VideoOutputCard({ output }: { output: VideoOutput }) {
  const queryClient = useQueryClient();
  // Presigned URLs are short-lived (~15min). Cache ~10min so switching tabs
  // doesn't re-hit the route, and let it refresh after expiry.
  // Same defensive defaults as AssetThumbnail: no retries — a 429 here would
  // amplify reads against the presign route.
  const { data: url, isPending, isError } = useQuery({
    queryKey: ["output-url", output.id],
    queryFn: () => fetchVideoOutputUrl(output.id),
    staleTime: 10 * 60 * 1000,
    retry: false,
    refetchOnWindowFocus: false
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteVideoOutputApi(output.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["render-outputs"] });
    }
  });

  function handleDelete() {
    // 与素材/分身删除一致：window.confirm（确认弹窗组件是已拍板的延期打磨项）
    if (!window.confirm("确认删除该成片？该操作不可撤销。")) return;
    deleteMutation.mutate();
  }

  return (
    <div className="outputCard">
      {isPending ? (
        <div className="previewLoading">
          <span className="spinner" aria-hidden="true" />
          加载中…
        </div>
      ) : isError ? (
        <div className="previewLoading">预览链接生成失败</div>
      ) : (
        // 竖屏网格卡直接用 video 首帧当封面（与素材缩略图同款 preload=metadata），
        // 不引入单独的封面 URL 端点。
        <video className="outputCover" controls preload="metadata" src={url} />
      )}
      <div className="outputMeta">
        <strong>{KIND_LABELS[output.kind]}</strong>
        <span>
          {formatCreatedAt(output.createdAt)} · {output.durationSeconds}s
        </span>
      </div>
      <div className="outputActions">
        {url ? (
          <a className="secondaryButton previewDownload" download href={url} rel="noopener noreferrer" target="_blank">
            下载
          </a>
        ) : null}
        <button
          type="button"
          className="secondaryButton"
          aria-label={`删除成片 ${output.id}`}
          onClick={handleDelete}
          disabled={deleteMutation.isPending}
        >
          {deleteMutation.isPending ? "删除中…" : "删除"}
        </button>
      </div>
      {deleteMutation.isError ? <p className="outputError">删除失败，请稍后重试。</p> : null}
    </div>
  );
}
