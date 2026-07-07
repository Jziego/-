# ffmpeg Video Composite — Implementation Plan B

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the placeholder `video_render` processor with a real ffmpeg pipeline that composes Mode C (digital-human full-frame + B-roll inserts + burned CJK subtitles + BGM), with graceful degradation to asset-only when there's no talking-head output.

**Architecture:** Pure, ffmpeg-free functions build (1) a timeline from `ScriptDraft.scenes`, (2) an ASS subtitle file, (3) a fluent-ffmpeg `filter_complex` descriptor. A thin runner executes ffmpeg with progress callbacks. The processor downloads inputs from R2 to a worker tmp dir, runs the runner, uploads the result. `BgmTrack` table + R2 `bgm/` prefix form the music library.

**Tech Stack:** fluent-ffmpeg + system ffmpeg (Alpine apk), libass + font-noto-cjk for CJK subtitles, Prisma 7, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-06-talking-head-async-and-ffmpeg-composite-design.md` (§F, §G, §B ScriptScene.role + BgmTrack)

**Prerequisite:** Plan A merged (talking_head job produces `VideoOutput(kind="talking_head")`; `findTalkingHeadOutputByProject` exists; `toFlowJobs` fixed).

**Scope of Plan B (opt2 + b5):** real video_render composite, BgmTrack library, ScriptScene.role, slideshow_render removal, graceful degradation. Falls back to asset-only if Mode C filter graph proves too brittle in the time budget (R1) — the pure functions and asset-only path ship regardless.

---

## File Structure

**Create:**
- `lib/services/video-compose.ts` — pure functions: `buildTimeline`, `resolveCompositionMode`, `buildAss`, `buildFilterGraph`.
- `tests/video-compose.test.ts` — unit tests for the above.
- `lib/services/ffmpeg-runner.ts` — executes ffmpeg via fluent-ffmpeg, reports progress.
- `tests/ffmpeg-runner.test.ts` — integration test (skipped if no ffmpeg binary).
- `prisma/bgm-seed-assets/README.md` — notes where sample BGM mp3s live before upload.

**Modify:**
- `prisma/schema.prisma` — add `BgmTrack` model; `ScriptScene.role` is a TS-only change (scenes is Json).
- `lib/types.ts` — `ScriptScene.role`, `BgmTrack` interface, `SubtitleStylePreset`.
- `lib/services/script-engine.ts` — `buildTemplateScenes` + AI schema carry `role`.
- `lib/repositories/{types,mappers,prisma,memory,index}.ts` — `BgmTrack` repository.
- `prisma/seed.ts` (or project seed location) — seed 3–5 BgmTrack rows.
- `worker/Dockerfile` — `apk add ffmpeg font-noto-cjk font-dejavu-sans`.
- `package.json` — `fluent-ffmpeg` + `@types/fluent-ffmpeg`.
- `worker/processors/video-render.ts` — full rewrite (Mode C + asset_only).
- `lib/queue.ts`, `lib/types.ts`, `worker/processors/index.ts`, `worker/index.ts`, `lib/services/render-pipeline.ts`, `app/api/render-projects/route.ts` — remove `slideshow_render` (b5).

---

## Phase 1 — Schema: ScriptScene.role + BgmTrack

### Task 1.1: Add `role` to ScriptScene + populate in builders

**Files:**
- Modify: `lib/types.ts:101-106`, `lib/services/script-engine.ts` (buildTemplateScenes `:279-306` + AI response schema `:25-35` + AI mapping `:192-198`)

- [ ] **Step 1: Extend the type**

In `lib/types.ts`:

```typescript
export type SceneRole = "presenter" | "broll";

export interface ScriptScene {
  order: number;
  text: string;
  durationSeconds: number;
  assetHints: string[];
  role: SceneRole;
}
```

- [ ] **Step 2: Write failing test for `buildTemplateScenes` role defaults**

In `tests/script-engine.test.ts` (or appropriate existing test file):

```typescript
it("assigns presenter to hook+cta scenes and broll to product scene", () => {
  const scenes = buildTemplateScenes(storeFixture, assetAnalysesFixture);
  expect(scenes[0]?.role).toBe("presenter"); // hook/storefront
  expect(scenes[1]?.role).toBe("broll");     // product demo
  expect(scenes[2]?.role).toBe("presenter"); // CTA
});
```

Run → FAIL (`role` undefined).

- [ ] **Step 3: Add `role` to `buildTemplateScenes`**

In `lib/services/script-engine.ts:286-305`:

```typescript
return [
  { order: 1, text: `开场展示${store.name}门店或招牌`, durationSeconds: 4, assetHints: hints.length ? hints : ["门店环境"], role: "presenter" },
  { order: 2, text: `展示${primaryProduct}和制作/服务过程`, durationSeconds: 7, assetHints: [primaryProduct, ...hints].slice(0, 3), role: "broll" },
  { order: 3, text: "展示优惠、地址或到店 CTA", durationSeconds: 4, assetHints: ["促销", "到店引流"], role: "presenter" },
];
```

- [ ] **Step 4: Carry `role` through the AI path**

Update the AI response schema (`:25-35`) to include `role` per scene; update the AI→ScriptScene mapping (`:192-198`) to `role: s.role === "presenter" ? "presenter" : "broll"` with a default. Update the system prompt example JSON (`:83-92`) to show `"role": "presenter"`. For AI scenes lacking `role`, default middle scenes to `"broll"`, first/last to `"presenter"`.

- [ ] **Step 5: Run tests → pass; typecheck**

Run: `npx vitest run tests/script-engine.test.ts && npm run typecheck` → green.

- [ ] **Step 6: Commit**

```bash
git add lib/types.ts lib/services/script-engine.ts tests/
git commit -m "feat(script): ScriptScene.role (presenter|broll) for Mode C timeline"
```

### Task 1.2: Add `BgmTrack` model + repository

**Files:**
- Modify: `prisma/schema.prisma`, `lib/types.ts`, `lib/repositories/{types,mappers,prisma,memory,index}.ts`

- [ ] **Step 1: Add the model**

In `prisma/schema.prisma`:

```prisma
model BgmTrack {
  id              String   @id
  name            String
  storageKey      String
  durationSeconds Float
  category        String   @default("general")
  createdAt       DateTime @default(now())
}
```

(System-level library — no ownerId.)

- [ ] **Step 2: Migrate**

Run: `npx prisma migrate dev --name bgm_track_library && npx prisma validate`
Expected: migration applied; schema valid.

- [ ] **Step 3: Add the TS type + repository**

In `lib/types.ts`:

```typescript
export interface BgmTrack {
  id: string;
  name: string;
  storageKey: string;
  durationSeconds: number;
  category: string;
  createdAt: string;
}
```

In `lib/repositories/types.ts`, add a `BgmTrackRepository` interface (`findById(id)`, `list()`). Implement in `prisma.ts` + `memory.ts`, wire `getBgmTrackRepository()` in `index.ts`, map in `mappers.ts`.

- [ ] **Step 4: Seed 3–5 tracks**

In the project seed file (find via `grep -rn "prisma" package.json` for the seed script path), insert:

```typescript
await db.bgmTrack.upsert({ where: { id: "bgm_upbeat_01" }, update: {}, create: { id: "bgm_upbeat_01", name: "明快节奏 01", storageKey: "bgm/bgm_upbeat_01.mp3", durationSeconds: 30, category: "upbeat" } });
await db.bgmTrack.upsert({ where: { id: "bgm_calm_01" }, update: {}, create: { id: "bgm_calm_01", name: "舒缓 01", storageKey: "bgm/bgm_calm_01.mp3", durationSeconds: 30, category: "calm" } });
await db.bgmTrack.upsert({ where: { id: "bgm_corporate_01" }, update: {}, create: { id: "bgm_corporate_01", name: "商务 01", storageKey: "bgm/bgm_corporate_01.mp3", durationSeconds: 30, category: "corporate" } });
```

Document in `prisma/bgm-seed-assets/README.md`: the three mp3 files must be uploaded to R2 at the listed keys (ops step, or a seed script that PUTs them from a local assets dir).

- [ ] **Step 5: Run seed + typecheck**

Run: `npm run typecheck` → green. (Seed run is an ops step; verify locally with `npx prisma db seed` if applicable.)

- [ ] **Step 6: Commit**

```bash
git add prisma/ lib/types.ts lib/repositories/ prisma/bgm-seed-assets/
git commit -m "feat(repo): BgmTrack system library (R2 bgm/ prefix)"
```

---

## Phase 2 — Pure compose functions (TDD, no ffmpeg)

### Task 2.1: `buildTimeline` + `resolveCompositionMode`

**Files:**
- Create: `lib/services/video-compose.ts`
- Create: `tests/video-compose.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, it, expect } from "vitest";
import { buildTimeline, resolveCompositionMode } from "@/lib/services/video-compose";
import type { ScriptScene, Asset, VideoOutput } from "@/lib/types";

const scenes: ScriptScene[] = [
  { order: 1, text: "开场", durationSeconds: 4, assetHints: ["门店"], role: "presenter" },
  { order: 2, text: "产品", durationSeconds: 7, assetHints: ["招牌产品"], role: "broll" },
  { order: 3, text: "CTA", durationSeconds: 4, assetHints: ["促销"], role: "presenter" },
];
const assets: Asset[] = [
  { id: "a1", type: "image", tags: ["招牌产品"], businessTags: [] } as Asset,
  { id: "a2", type: "video", tags: [], businessTags: ["门店"] } as Asset,
];

it("accumulates scene durations into [start,end] windows", () => {
  const tl = buildTimeline({ scenes, assets, selectedAssetIds: ["a1", "a2"] });
  expect(tl).toHaveLength(3);
  expect(tl[0]).toMatchObject({ startSec: 0, endSec: 4, durationSec: 4 });
  expect(tl[1]).toMatchObject({ startSec: 4, endSec: 11, durationSec: 7 });
  expect(tl[2]).toMatchObject({ startSec: 11, endSec: 15, durationSec: 4 });
});

it("resolves an asset for broll segments via hint intersection, null for presenter", () => {
  const tl = buildTimeline({ scenes, assets, selectedAssetIds: ["a1", "a2"] });
  expect(tl[0]?.assetId).toBeNull();                       // presenter
  expect(tl[1]?.assetId).toBe("a1");                       // broll: "招牌产品" matches a1.tags
  expect(tl[2]?.assetId).toBeNull();                       // presenter
});

it("falls back to round-robin selectedAssetIds when no hint match", () => {
  const noMatchAssets: ScriptScene[] = [{ order: 1, text: "x", durationSeconds: 4, assetHints: ["不存在"], role: "broll" }];
  const tl = buildTimeline({ scenes: noMatchAssets, assets, selectedAssetIds: ["a1"] });
  expect(tl[0]?.assetId).toBe("a1");
});

it("resolveCompositionMode returns presenter_broll when talking-head exists", () => {
  const th = { kind: "talking_head" } as VideoOutput;
  expect(resolveCompositionMode(th)).toBe("presenter_broll");
  expect(resolveCompositionMode(null)).toBe("asset_only");
});
```

Run → FAIL (module missing).

- [ ] **Step 2: Implement**

```typescript
// lib/services/video-compose.ts
import type { Asset, ScriptScene, VideoOutput } from "@/lib/types";

export type CompositionMode = "presenter_broll" | "asset_only";

export interface TimelineSegment {
  role: SceneRole;
  startSec: number;
  endSec: number;
  durationSec: number;
  sceneOrder: number;
  text: string;
  assetId: string | null;
}

export function resolveCompositionMode(talkingHead: VideoOutput | null): CompositionMode {
  return talkingHead ? "presenter_broll" : "asset_only";
}

export function buildTimeline(args: {
  scenes: ScriptScene[];
  assets: Asset[];
  selectedAssetIds: string[];
}): TimelineSegment[] {
  const selected = args.selectedAssetIds;
  let rr = 0; // round-robin cursor for fallback
  let cursor = 0;
  return args.scenes.map((scene) => {
    const duration = Math.max(scene.durationSeconds, 0.1);
    const start = cursor;
    const end = cursor + duration;
    cursor = end;
    const assetId = scene.role === "broll"
      ? resolveAssetForScene(scene, args.assets, selected, () => selected[rr++ % Math.max(selected.length, 1)] ?? null)
      : null;
    return { role: scene.role, startSec: start, endSec: end, durationSec: duration, sceneOrder: scene.order, text: scene.text, assetId };
  });
}

function resolveAssetForScene(
  scene: ScriptScene,
  assets: Asset[],
  selectedIds: string[],
  fallback: () => string | null,
): string | null {
  const hints = new Set(scene.assetHints.map((h) => h.toLowerCase()));
  const selected = new Set(selectedIds);
  // Prefer selected assets whose tags/businessTags intersect hints.
  const match = assets.find((a) =>
    selected.has(a.id) &&
    [...(a.tags ?? []), ...(a.businessTags ?? [])].some((t) => hints.has(String(t).toLowerCase())),
  );
  if (match) return match.id;
  return fallback();
}

// SceneRole imported from lib/types (added in Task 1.1)
import type { SceneRole } from "@/lib/types";
```

- [ ] **Step 3: Run → pass**

Run: `npx vitest run tests/video-compose.test.ts` → PASS.

- [ ] **Step 4: Commit**

```bash
git add lib/services/video-compose.ts tests/video-compose.test.ts
git commit -m "feat(compose): buildTimeline + resolveCompositionMode (pure)"
```

### Task 2.2: `buildAss` (subtitle file generator)

**Files:**
- Modify: `lib/services/video-compose.ts`, `tests/video-compose.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { buildAss } from "@/lib/services/video-compose";

it("emits an ASS file with one Dialogue line per segment, timestamps from timeline", () => {
  const segs: TimelineSegment[] = [
    { role: "presenter", startSec: 0, endSec: 4, durationSec: 4, sceneOrder: 1, text: "开场白", assetId: null },
    { role: "broll", startSec: 4, endSec: 11, durationSec: 7, sceneOrder: 2, text: "产品来了", assetId: "a1" },
  ];
  const ass = buildAss(segs, "default");
  expect(ass).toContain("[V4+ Styles]");
  expect(ass).toContain("Style: Default");
  expect(ass).toContain("Dialogue: 0,0:00:00.00,0:00:04.00,Default,,0,0,0,,开场白");
  expect(ass).toContain("Dialogue: 0,0:00:04.00,0:00:11.00,Default,,0,0,0,,产品来了");
});
```

Run → FAIL.

- [ ] **Step 2: Implement**

```typescript
export type SubtitleStylePreset = "default" | "bold_bottom" | "minimal";

interface AssStyleSpec {
  fontname: string;
  fontsize: number;
  primaryColour: string;   // &H00BBGGRR (ASS alpha+BGR)
  outlineColour: string;
  bold: 0 | 1;
  outline: number;
  alignment: number;       // 2 = bottom-center
  marginV: number;
}

const PRESETS: Record<SubtitleStylePreset, AssStyleSpec> = {
  default:     { fontname: "Noto Sans CJK SC", fontsize: 72, primaryColour: "&H00FFFFFF", outlineColour: "&H00000000", bold: 1, outline: 4, alignment: 2, marginV: 80 },
  bold_bottom: { fontname: "Noto Sans CJK SC", fontsize: 84, primaryColour: "&H0000F4FF", outlineColour: "&H00000000", bold: 1, outline: 6, alignment: 2, marginV: 60 },
  minimal:     { fontname: "Noto Sans CJK SC", fontsize: 56, primaryColour: "&H00EEEEEE", outlineColour: "&H80000000", bold: 0, outline: 2, alignment: 2, marginV: 100 },
};

function assTimestamp(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const sWhole = Math.floor(sec % 60);
  const cs = Math.round((sec - Math.floor(sec)) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(sWhole).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

export function buildAss(segments: TimelineSegment[], preset: SubtitleStylePreset): string {
  const s = PRESETS[preset] ?? PRESETS.default;
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 1080",
    "PlayResY: 1920",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,${s.fontname},${s.fontsize},${s.primaryColour},${s.outlineColour},${s.bold},0,1,${s.outline},0,${s.alignment},40,40,${s.marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const dialogues = segments.map((seg) =>
    `Dialogue: 0,${assTimestamp(seg.startSec)},${assTimestamp(seg.endSec)},Default,,0,0,0,,${seg.text}`,
  );
  return [...header, ...dialogues].join("\n");
}
```

Map `RenderProject.subtitleStyle` (String) → `SubtitleStylePreset` at the call site (default to `"default"` if unrecognized).

- [ ] **Step 3: Run → pass; commit**

```bash
npx vitest run tests/video-compose.test.ts
git add lib/services/video-compose.ts tests/video-compose.test.ts
git commit -m "feat(compose): buildAss generates ASS subtitles from timeline"
```

### Task 2.3: `buildFilterGraph` (ffmpeg `filter_complex` descriptor)

**Files:**
- Modify: `lib/services/video-compose.ts`, `tests/video-compose.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { buildFilterGraph } from "@/lib/services/video-compose";

it("builds presenter_broll filter_complex: trims talking-head for presenter, loops asset for broll, concats, burns subs, mixes bgm", () => {
  const segs: TimelineSegment[] = [
    { role: "presenter", startSec: 0, endSec: 4, durationSec: 4, sceneOrder: 1, text: "a", assetId: null },
    { role: "broll", startSec: 4, endSec: 11, durationSec: 7, sceneOrder: 2, text: "b", assetId: "a1" },
  ];
  const graph = buildFilterGraph({
    mode: "presenter_broll",
    segments: segs,
    assetInputIndex: { a1: 1 },           // asset a1 is ffmpeg input #1
    talkingHeadInputIndex: 0,
    bgmInputIndex: 2,
    assPath: "/tmp/subs.ass",
    width: 1080, height: 1920,
    totalDurationSec: 11,
  });
  expect(graph.filterComplex).toContain("[0:v]trim=start=0:duration=4");
  expect(graph.filterComplex).toContain("concat=n=2:v=1:a=0[vcat]");
  expect(graph.filterComplex).toContain("subtitles=/tmp/subs.ass");
  expect(graph.filterComplex).toContain("amix=inputs=2");
  expect(graph.mapVideo).toBe("[vsub]");
  expect(graph.mapAudio).toBe("[aout]");
});

it("asset_only mode: no talking-head trim, audio from bgm only", () => {
  const segs: TimelineSegment[] = [
    { role: "broll", startSec: 0, endSec: 5, durationSec: 5, sceneOrder: 1, text: "x", assetId: "a1" },
  ];
  const graph = buildFilterGraph({ mode: "asset_only", segments: segs, assetInputIndex: { a1: 0 }, bgmInputIndex: 1, assPath: "/tmp/subs.ass", width: 1080, height: 1920, totalDurationSec: 5 });
  expect(graph.filterComplex).not.toContain("[0:v]trim");
  expect(graph.mapAudio).toBe("[abgm]");
});
```

Run → FAIL.

- [ ] **Step 2: Implement**

```typescript
export interface FilterGraphResult {
  filterComplex: string;
  mapVideo: string;
  mapAudio: string;
}

export interface BuildFilterGraphArgs {
  mode: CompositionMode;
  segments: TimelineSegment[];
  assetInputIndex: Record<string, number>;   // assetId -> ffmpeg input index
  talkingHeadInputIndex?: number;            // input index of th.mp4
  bgmInputIndex?: number;                    // input index of bgm.mp3
  assPath: string;
  width: number;
  height: number;
  totalDurationSec: number;
}

function scaledPadChain(width: number, height: number, labelIn: string, labelOut: string): string {
  return `${labelIn}scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30${labelOut}`;
}

export function buildFilterGraph(args: BuildFilterGraphArgs): FilterGraphResult {
  const { width, height, assPath, totalDurationSec } = args;
  const parts: string[] = [];
  const videoLabels: string[] = [];

  let segIdx = 0;
  for (const seg of args.segments) {
    const outLabel = `[v${segIdx}]`;
    if (seg.role === "presenter" && args.mode === "presenter_broll" && args.talkingHeadInputIndex !== undefined) {
      const th = args.talkingHeadInputIndex;
      parts.push(`[${th}:v]trim=start=${seg.startSec}:duration=${seg.durationSec},setpts=PTS-STARTPTS`);
      parts.push(scaledPadChain(width, height, "", outLabel));  // chains onto previous (trim) output
    } else {
      // broll asset
      const idx = args.assetInputIndex[seg.assetId ?? ""];
      if (idx === undefined) {
        // no asset resolved — fall back to a color source so concat doesn't break
        parts.push(`color=c=black:s=${width}x${height}:d=${seg.durationSec},fps=30`);
        parts.push(`null${outLabel}`);
      } else {
        parts.push(`[${idx}:v]trim=duration=${seg.durationSec},setpts=PTS-STARTPTS`);
        parts.push(scaledPadChain(width, height, "", outLabel));
      }
    }
    videoLabels.push(outLabel);
    segIdx++;
  }

  // concat video segments
  const concatInput = videoLabels.join("");
  parts.push(`${concatInput}concat=n=${videoLabels.length}:v=1:a=0[vcat]`);
  parts.push(`[vcat]subtitles=${assPath}[vsub]`);

  // audio
  if (args.mode === "presenter_broll" && args.talkingHeadInputIndex !== undefined) {
    parts.push(`[${args.talkingHeadInputIndex}:a]atrim=duration=${totalDurationSec},apad,aresample=async=1[avoice]`);
    if (args.bgmInputIndex !== undefined) {
      parts.push(`[${args.bgmInputIndex}:a]volume=-20dB,atrim=duration=${totalDurationSec}[abgm]`);
      parts.push(`[avoice][abgm]amix=inputs=2:duration=first:dropout_transition=0[aout]`);
      return { filterComplex: parts.join(";"), mapVideo: "[vsub]", mapAudio: "[aout]" };
    }
    return { filterComplex: parts.join(";"), mapVideo: "[vsub]", mapAudio: "[avoice]" };
  }

  // asset_only: audio from bgm only (or silent)
  if (args.bgmInputIndex !== undefined) {
    parts.push(`[${args.bgmInputIndex}:a]volume=-12dB,atrim=duration=${totalDurationSec}[abgm]`);
    return { filterComplex: parts.join(";"), mapVideo: "[vsub]", mapAudio: "[abgm]" };
  }
  parts.push(`anullsrc=channel_layout=stereo:sample_rate=44100,atrim=duration=${totalDurationSec}[aout]`);
  return { filterComplex: parts.join(";"), mapVideo: "[vsub]", mapAudio: "[aout]" };
}
```

**Note for the implementer:** the per-segment `trim,setpts` then `scale,pad` chained with empty in-label is the fiddly part — when wiring the trim output into the scale chain, the trim filter's output stream feeds the scale filter. The exact label plumbing (e.g. `[0:v]trim=...[t0];[t0]scale=...[v0]`) must be made explicit if ffmpeg rejects the unlabeled chain. Treat the test as the contract; adjust label emission until the unit test passes AND a real ffmpeg run accepts the string (Task 4.2 integration test).

- [ ] **Step 3: Run → pass; commit**

```bash
npx vitest run tests/video-compose.test.ts
git add lib/services/video-compose.ts tests/video-compose.test.ts
git commit -m "feat(compose): buildFilterGraph emits ffmpeg filter_complex descriptor"
```

---

## Phase 3 — ffmpeg dependency

### Task 3.1: Add ffmpeg to worker image + npm deps

**Files:**
- Modify: `worker/Dockerfile:12`, `package.json`

- [ ] **Step 1: Update Dockerfile**

```dockerfile
RUN apk add --no-cache openssl ffmpeg font-noto-cjk font-dejavu-sans
```

- [ ] **Step 2: Add npm dependencies**

Run: `npm install fluent-ffmpeg && npm install -D @types/fluent-ffmpeg`
Commit the resulting `package.json` + `package-lock.json` changes.

- [ ] **Step 3: Verify ffmpeg present in a built image (empirical gate)**

If Docker Desktop has working network (proxy configured per spec §2.5), build the worker image and run:

```bash
docker build -t worker-probe:latest -f worker/Dockerfile .
docker run --rm worker-probe:latest sh -c "ffmpeg -hide_banner -version | head -3 && ffmpeg -hide_banner -encoders 2>/dev/null | grep libx264 && fc-list | grep -i 'noto.*cjk'"
```

Expected: ffmpeg version line, a `libx264` encoder line, and at least one Noto CJK font line. If network blocks this, defer verification to CI (ubuntu runner has ffmpeg) + first Zeabur deploy.

- [ ] **Step 4: Commit**

```bash
git add worker/Dockerfile package.json package-lock.json
git commit -m "feat(worker): install ffmpeg + CJK fonts; add fluent-ffmpeg"
```

---

## Phase 4 — ffmpeg runner + video_render rewrite

### Task 4.1: ffmpeg runner

**Files:**
- Create: `lib/services/ffmpeg-runner.ts`
- Create: `tests/ffmpeg-runner.test.ts`

- [ ] **Step 1: Implement the runner (thin fluent-ffmpeg wrapper)**

```typescript
import ffmpeg from "fluent-ffmpeg";
import type { FilterGraphResult } from "@/lib/services/video-compose";

export interface RunFfmpegArgs {
  inputs: string[];                 // ordered local file paths (matches input indices in the filter graph)
  filter: FilterGraphResult;
  outputPath: string;
  durationSec: number;
  onProgress?: (pct: number) => void;
}

export function runFfmpeg(args: RunFfmpegArgs): Promise<void> {
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg();
    for (const p of args.inputs) cmd.input(p);
    cmd.complexFilter(args.filter.filterComplex)
       .outputOptions(["-map", args.filter.mapVideo, "-map", args.filter.mapAudio])
       .outputOptions(["-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k"])
       .duration(args.durationSec)
       .output(args.outputPath);

    if (args.onProgress) {
      cmd.on("progress", (p: { percent?: number }) => {
        if (typeof p.percent === "number" && Number.isFinite(p.percent)) {
          args.onProgress!(Math.max(0, Math.min(100, Math.round(p.percent))));
        }
      });
    }
    cmd.on("end", () => resolve());
    cmd.on("error", (err: Error) => reject(new Error("ffmpeg failed: " + err.message)));
    cmd.run();
  });
}
```

- [ ] **Step 2: Integration test (skipped without ffmpeg)**

```typescript
import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { runFfmpeg } from "@/lib/services/ffmpeg-runner";
import { buildFilterGraph, buildAss, buildTimeline } from "@/lib/services/video-compose";

const hasFfmpeg = (() => { try { execSync("ffmpeg -version", { stdio: "ignore" }); return true; } catch { return false; } })();

describe.skip(!hasFfmpeg, "ffmpeg runner (requires ffmpeg)")(() => {
  it("produces a non-empty mp4 from an image + subtitle + bgm-less asset_only graph", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ff-"));
    try {
      // generate a 1s solid-color test input via ffmpeg
      execSync(`ffmpeg -f lavfi -i color=c=red:s=1080x1920:d=2 -frames:v 1 ${join(dir, "img.png")}`, { stdio: "ignore" });
      const segs = [{ role: "broll" as const, startSec: 0, endSec: 2, durationSec: 2, sceneOrder: 1, text: "测试字幕", assetId: "a1" }];
      const ass = buildAss(segs, "default");
      const assPath = join(dir, "subs.ass");
      writeFileSync(assPath, ass, "utf8");
      const filter = buildFilterGraph({ mode: "asset_only", segments: segs, assetInputIndex: { a1: 0 }, assPath, width: 1080, height: 1920, totalDurationSec: 2 });
      const out = join(dir, "out.mp4");
      await runFfmpeg({ inputs: [join(dir, "img.png")], filter, outputPath: out, durationSec: 2 });
      expect(existsSync(out)).toBe(true);
      expect(readFileSync(out).length).toBeGreaterThan(1000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

Run: `npx vitest run tests/ffmpeg-runner.test.ts`. On CI (ffmpeg present) it executes and passes; locally without ffmpeg it skips.

- [ ] **Step 3: Commit**

```bash
git add lib/services/ffmpeg-runner.ts tests/ffmpeg-runner.test.ts
git commit -m "feat(ffmpeg): runner with progress + image+subtitle smoke test"
```

### Task 4.2: Rewrite video_render processor (Mode C + asset_only)

**Files:**
- Modify: `worker/processors/video-render.ts`
- Modify: `tests/worker-processors.test.ts`

- [ ] **Step 1: Update the processor test**

Add a case asserting: given a talking-head VideoOutput + scenes + assets + bgm, the processor writes a `VideoOutput(kind="final_composite")` and the output file is produced (mock `runFfmpeg` to avoid the real binary in unit tests; assert the composed args). Add a degradation case: no talking-head output → `mode === "asset_only"` → still writes `final_composite`.

- [ ] **Step 2: Rewrite the processor**

```typescript
import { getRenderRepository } from "@/lib/repositories";
import { getAssetRepository } from "@/lib/repositories";
import { getBgmTrackRepository } from "@/lib/repositories";
import { getObjectToBuffer, putObjectFromBuffer } from "@/lib/storage";
import { getScriptRepository } from "@/lib/repositories";
import { buildTimeline, resolveCompositionMode, buildAss, buildFilterGraph } from "@/lib/services/video-compose";
import { runFfmpeg } from "@/lib/services/ffmpeg-runner";
import { createId } from "@/lib/ids";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RESOLUTIONS: Record<string, { w: number; h: number }> = {
  "9:16": { w: 1080, h: 1920 },
  "1:1":  { w: 1080, h: 1080 },
  "16:9": { w: 1920, h: 1080 },
};

export async function videoRenderProcessor(args: {
  job: { id: string; ownerId: string; projectId: string | null; payload: { aspectRatio: string; subtitleStyle: string; bgmTrackId?: string } };
  updateProgress: (pct: number) => void;
}): Promise<void> {
  const { job } = args;
  const repo = getRenderRepository();
  const projectId = job.projectId;
  if (!projectId) throw new Error("video_render requires a projectId");

  args.updateProgress(5);
  const project = await repo.findById(projectId);
  const draft = await getScriptRepository().findById(project.scriptDraftId);
  const talkingHead = await repo.findTalkingHeadOutputByProject(projectId);
  const mode = resolveCompositionMode(talkingHead);

  // resolve assets
  const assets = await getAssetRepository().findByIds(project.selectedAssetIds);
  const timeline = buildTimeline({ scenes: draft.scenes, assets, selectedAssetIds: project.selectedAssetIds });
  const totalDuration = timeline.reduce((s, seg) => s + seg.durationSec, 0);
  const { w: width, h: height } = RESOLUTIONS[project.aspectRatio] ?? RESOLUTIONS["9:16"];

  // download inputs to tmp
  const dir = mkdtempSync(join(tmpdir(), "render-"));
  try {
    args.updateProgress(15);
    const inputs: string[] = [];
    const assetInputIndex: Record<string, number> = {};
    if (mode === "presenter_broll" && talkingHead) {
      const thPath = join(dir, "th.mp4");
      await downloadToFile(talkingHead.storageKey, thPath);
      inputs.push(thPath);
    }
    const thIdx = mode === "presenter_broll" && talkingHead ? 0 : undefined;
    let nextIdx = thIdx !== undefined ? thIdx + 1 : 0;
    for (const seg of timeline) {
      if (seg.role === "broll" && seg.assetId && assetInputIndex[seg.assetId] === undefined) {
        const asset = assets.find((a) => a.id === seg.assetId)!;
        const ext = asset.type === "video" ? "mp4" : "png";
        const p = join(dir, `asset-${seg.assetId}.${ext}`);
        await downloadToFile(asset.storageKey, p);
        assetInputIndex[seg.assetId] = nextIdx;
        inputs.push(p);
        nextIdx++;
      }
    }
    let bgmIdx: number | undefined;
    if (job.payload.bgmTrackId) {
      const bgm = await getBgmTrackRepository().findById(job.payload.bgmTrackId);
      if (bgm) {
        const p = join(dir, "bgm.mp3");
        await downloadToFile(bgm.storageKey, p);
        bgmIdx = nextIdx; inputs.push(p); nextIdx++;
      }
    }

    // subtitles
    const assPath = join(dir, "subs.ass");
    writeFileSync(assPath, buildAss(timeline, (project.subtitleStyle as any) ?? "default"), "utf8");

    args.updateProgress(30);
    const filter = buildFilterGraph({
      mode, segments: timeline, assetInputIndex,
      talkingHeadInputIndex: thIdx, bgmInputIndex: bgmIdx,
      assPath, width, height, totalDurationSec: totalDuration,
    });

    const outPath = join(dir, "output.mp4");
    await runFfmpeg({
      inputs, filter, outputPath: outPath, durationSec: totalDuration,
      onProgress: (p) => args.updateProgress(30 + Math.round(p * 0.6)),   // 30..90
    });

    // upload
    args.updateProgress(92);
    const storageKey = `renders/${projectId}/output-${createId("vid")}.mp4`;
    const buffer = await readFileToBuffer(outPath);
    await putObjectFromBuffer(storageKey, buffer, "video/mp4");

    await repo.createOutput({
      id: createId("vid"), ownerId: job.ownerId, renderProjectId: projectId,
      storageKey, aspectRatio: project.aspectRatio, durationSeconds: totalDuration,
      kind: "final_composite", status: "ready",
    });
    args.updateProgress(100);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
```

(`downloadToFile`, `readFileToBuffer` are small helpers around `getObjectToBuffer` + `node:fs`; add them to `lib/storage.ts` or inline. Match the existing storage accessor signatures.)

- [ ] **Step 3: Run tests → pass**

Run: `npx vitest run tests/worker-processors.test.ts` → green (mock `runFfmpeg`).

- [ ] **Step 4: Commit**

```bash
git add worker/processors/video-render.ts tests/worker-processors.test.ts lib/storage.ts
git commit -m "feat(video-render): real ffmpeg composite (Mode C + asset_only degradation)"
```

---

## Phase 5 — Remove slideshow_render (b5)

### Task 5.1: Delete slideshow_render job type + recoverRenderFailure

**Files:**
- Modify: `lib/types.ts`, `lib/queue.ts:4-11`, `worker/processors/index.ts`, `worker/index.ts:137-144`, `lib/services/render-pipeline.ts:77-99` (recoverRenderFailure), `app/api/render-projects/route.ts:83-87`

- [ ] **Step 1: Remove the type + queue mapping**

In `lib/types.ts`, remove `"slideshow_render"` from `JobType`. In `lib/queue.ts`, remove the `slideshow_render` line.

- [ ] **Step 2: Remove recoverRenderFailure + its pre-enqueue**

Delete `recoverRenderFailure` from `lib/services/render-pipeline.ts` and the `recoverRenderFailure(...)` call in `app/api/render-projects/route.ts:83-87`. (Degradation is now inline in video_render via `resolveCompositionMode`.)

- [ ] **Step 3: Remove processor registration + worker**

Remove the `slideshow_render` registrations in `worker/processors/index.ts` and `"slideshow_render"` from `jobTypes` in `worker/index.ts`.

- [ ] **Step 4: Fix tests**

Update `tests/queue-flow.test.ts` (the old slideshow case was already rewritten in Plan A Task 1.1 — confirm no slideshow references remain). Update `tests/render-pipeline.test.ts` if it referenced recoverRenderFailure. Grep: `grep -rn "slideshow_render\|recoverRenderFailure" .` should return only docs/specs.

- [ ] **Step 5: Run full gate**

Run: `npm test && npm run typecheck && npm run lint && npx prisma validate && npm run build`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add lib/types.ts lib/queue.ts lib/services/render-pipeline.ts app/api/render-projects/route.ts worker/ tests/
git commit -m "fix(pipeline): remove slideshow_render + recoverRenderFailure (b5)

Degradation is now inline: video_render falls back to asset_only when
no talking-head output exists, instead of a parallel pre-enqueued fallback job."
```

### Task 5.2: Plan B regression + manual E2E

- [ ] **Step 1: Full gate**

Run: `npm test && npm run typecheck && npm run lint && npm run build` → green.

- [ ] **Step 2: Manual E2E (worker + Redis + R2)**

Trigger a one-click render with `includeAvatar=true`, selected assets, a script draft, and a bgmTrackId. Observe:
- avatar_generation → talking_head → video_render in correct order.
- talking_head SSE progresses 5→100.
- video_render produces a real mp4 at `renders/<projectId>/output-*.mp4`, downloadable, with: digital human full-frame during presenter scenes, B-roll during product scenes, burned CJK subtitles, BGM.
- Trigger a second render with talking_head forced to fail → video_render degrades to asset_only and still ships a video.

- [ ] **Step 3: Commit any fixups; Plan B done.**

---

## Plan B — Self-Review

**Spec coverage (Plan B scope):**
- §B ScriptScene.role: Task 1.1. ✓ | §B BgmTrack: Task 1.2. ✓
- §F pure functions (buildTimeline/generateAss/resolveCompositionMode): Tasks 2.1/2.2/2.3. ✓
- §F ffmpeg runner + Mode C assembly: Tasks 4.1/4.2. ✓
- §F Dockerfile/deps: Task 3.1. ✓
- §G asset_only degradation + b5 slideshow removal: Tasks 4.2/5.1. ✓
- §7 testing (pure unit + ffmpeg CI smoke): Tasks 2.x, 4.1. ✓

**Placeholder scan:** the `buildFilterGraph` label-plumbing carries an explicit implementer note to make trim→scale label wiring explicit if ffmpeg rejects unlabeled chains — that's a verified-risk callout (R1), not a placeholder; the unit test is the contract. `downloadToFile`/`readFileToBuffer` helpers are named and their origin specified.

**Type consistency:** `TimelineSegment`, `CompositionMode`, `SubtitleStylePreset`, `FilterGraphResult` defined once in `video-compose.ts` and reused by the runner + processor. `SceneRole` added in Task 1.1, imported in 2.1. `BgmTrack` repository method `findById` consistent across interface + caller.

**Risk acknowledgment (R1):** if Mode C `filter_complex` proves too brittle within the time budget, Task 4.2's asset_only path + the pure functions still ship value; the fallback (digital-human output persisted but not embedded) is one `mode` switch away. This is documented in the spec §8 R1.
