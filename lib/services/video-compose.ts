import type { Asset, ScriptScene, VideoOutput } from "@/lib/types";

export type CompositionMode = "presenter_broll" | "asset_only";

export interface TimelineSegment {
  role: ScriptScene["role"];
  startSec: number;
  endSec: number;
  durationSec: number;
  sceneOrder: number;
  text: string;
  assetId: string | null;
}

/**
 * Mode C (presenter_broll) when a talking-head product exists for the project;
 * asset_only when there is none (includeAvatar=false OR talking_head failed).
 * The video_render processor branches on this.
 */
export function resolveCompositionMode(talkingHead: VideoOutput | null): CompositionMode {
  return talkingHead ? "presenter_broll" : "asset_only";
}

/**
 * Build a flat timeline of segments from scenes, accumulating durationSeconds
 * into [startSec, endSec] windows. Broll segments resolve a selected asset via
 * assetHint intersection (tags/businessTags); presenter segments get null.
 * When no hint matches, falls back to round-robin over selectedAssetIds.
 */
export function buildTimeline(args: {
  scenes: ScriptScene[];
  assets: Asset[];
  selectedAssetIds: string[];
}): TimelineSegment[] {
  const selectedIds = args.selectedAssetIds;
  let cursor = 0;
  let rr = 0;

  return args.scenes.map((scene) => {
    const duration = Math.max(scene.durationSeconds, 0.1);
    const start = cursor;
    const end = cursor + duration;
    cursor = end;

    const assetId =
      scene.role === "broll"
        ? resolveAssetForScene(scene, args.assets, selectedIds, () => {
            const id = selectedIds[rr % Math.max(selectedIds.length, 1)];
            rr += 1;
            return id ?? null;
          })
        : null;

    return {
      role: scene.role,
      startSec: start,
      endSec: end,
      durationSec: duration,
      sceneOrder: scene.order,
      text: scene.text,
      assetId
    };
  });
}

function resolveAssetForScene(
  scene: ScriptScene,
  assets: Asset[],
  selectedIds: string[],
  fallback: () => string | null
): string | null {
  const hints = new Set(scene.assetHints.map((h) => h.toLowerCase()));
  const selected = new Set(selectedIds);
  const match = assets.find((a) =>
    selected.has(a.id) &&
    [...(a.tags ?? []), ...(a.businessTags ?? [])].some((t) =>
      hints.has(String(t).toLowerCase())
    )
  );
  if (match) return match.id;
  return fallback();
}
