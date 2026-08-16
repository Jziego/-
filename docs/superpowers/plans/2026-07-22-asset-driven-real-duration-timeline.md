# Asset-Driven, Real-Duration-Aligned Timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two render bugs — (A) only ~2 of N uploaded assets appear in the final video, and (B) the last few seconds of the video freeze — by rebuilding the video timeline so every selected asset gets a segment and every segment's duration is grounded in real media duration (talking-head TTS length + ffprobe'd asset lengths), guaranteeing the concatenated video stream equals the output/audio duration exactly.

**Architecture:** `buildTimeline` becomes a pure function that takes *real* durations (talking-head `durationSeconds` + a per-asset ffprobe map) and lays out one broll segment per selected asset, distributing the timeline budget with a water-filling algorithm so `Σ segment durations == totalDuration` exactly. The worker gains an injected `probeAssetDuration` dep (ffprobe over a presigned GET URL) and feeds real durations in. `buildFilterGraph` is adjusted so asset_only presenter scenes render an asset instead of black. The ffmpeg `-t`/audio-pad already target `totalDuration`; because the video stream now equals that length, the tail freeze disappears.

**Tech Stack:** TypeScript 6, Vitest, fluent-ffmpeg (ffmpeg + ffprobe binaries), existing worker DI seam (`VideoRenderDeps`).

---

## Design Decisions (defaults — tell me if any should change before execution)

These are the product-ish knobs the redesign introduces. Defaults are chosen for typical local-shop short videos (15–30s).

1. **Total-duration anchor:**
   - `presenter_broll` (talking-head exists): `T = talkingHead.durationSeconds`, then `T_eff = min(T, ΣmaxContent)` so the output never exceeds available footage (if assets can't fill the voiceover, the video is trimmed to content length rather than freezing).
   - `asset_only` (no talking-head): `T = Σ(asset contributions)` — no external anchor.
2. **Every selected asset appears exactly once** as its own broll segment (de-duped, in `selectedAssetIds` order). This is the core fix for Bug A.
3. **Per-video-asset cap = 12s** (`maxClipSec`); one long clip can't dominate the timeline. Clip contribution = `min(realDurationSec, 12)`.
4. **Image default slot = 3s** (`imageDefaultSec`); images also act as the flexible "slack absorber" so the budget sums exactly to `T`.
5. **Presenter budget share = 30%** of `T` in presenter_broll mode, split across the script's presenter scenes (opener(s) + closer). The remaining 70% is split across all assets via water-filling.
6. **Layout (presenter_broll):** `[presenter openers] → [asset₁ … assetₙ] → [presenter closer]`. CTA (last scene) lands at the tail.
7. **Layout (asset_only):** `[asset₁ … assetₙ]`; the script's presenter/broll roles no longer produce black frames — every beat is an asset beat (fixes the latent asset_only black-screen bug).
8. **Subtitles:** each beat's `text` cycles through the script scenes' text pool (opener/CTA/broll). Subtitle timing follows the new `[start,end]` windows automatically via `buildAss`.
9. **No `tpad` hold-frame by default** — correctness comes from `Σ == T`. Kept out per YAGNI; the math guarantees no shortfall when content ≥ voiceover. When content < voiceover we shrink `T_eff` instead of holding.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `lib/services/ffmpeg-runner.ts` | ffmpeg/ffprobe execution | **Add** `probeFileDuration(pathOrUrl)` |
| `lib/services/video-compose.ts` | Pure timeline + filter-graph builders | **Rewrite** `buildTimeline` (new signature); **tweak** `buildFilterGraph` (asset_only presenter) |
| `worker/processors/video-render.ts` | Render orchestration (DI) | **Add** `probeAssetDuration` dep + default impl; call new `buildTimeline` with real durations + `talkingHead.durationSeconds` |
| `tests/ffmpeg-runner.test.ts` | ffmpeg-binary integration tests | **Add** ffprobe duration test |
| `tests/video-compose.test.ts` | Pure-function unit tests | **Rewrite** timeline tests for new contract; **add** asset-only-presenter + Σ==T tests |
| `tests/worker-processors.test.ts` | Worker DI tests | **Update** fake composite for new `totalDurationSec`; **add** `probeAssetDuration` injection test |

No DB schema changes. No new dependencies (fluent-ffmpeg already ships ffprobe).

---

## Task 1: `probeFileDuration` helper

Promisified ffprobe over a local path or HTTP URL. Used by the worker to learn real video asset durations.

**Files:**
- Modify: `lib/services/ffmpeg-runner.ts` (add export at end of file)
- Test: `tests/ffmpeg-runner.test.ts` (add inside the existing `runner(...)` block so it only runs when the ffmpeg binary is present)

- [ ] **Step 1: Write the failing test**

Append to `tests/ffmpeg-runner.test.ts`, inside the `runner("ffmpeg runner (requires the ffmpeg binary)", () => { ... })` block (after the existing `it(...)`):

```ts
  it("probeFileDuration returns the duration of a generated test video", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ff-probe-"));
    try {
      const vidPath = join(dir, "clip.mp4");
      // Generate a 3-second test video (same lavfi trick the suite already uses).
      execSync(
        'ffmpeg -hide_banner -loglevel error -f lavfi -i "color=c=blue:s=320x568:d=3" -c:v libx264 -pix_fmt yuv420p ' +
          vidPath,
        { stdio: "ignore" }
      );

      const dur = await probeFileDuration(vidPath);
      // ffprobe reports ~3.0s; allow encoder jitter.
      expect(dur).toBeGreaterThanOrEqual(2.8);
      expect(dur).toBeLessThanOrEqual(3.2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
```

And add `probeFileDuration` to the import at the top of the file:

```ts
import { runFfmpeg, probeFileDuration } from "@/lib/services/ffmpeg-runner";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ffmpeg-runner.test.ts`
Expected: FAIL — `probeFileDuration is not exported from "@/lib/services/ffmpeg-runner"` (TS/import error).

- [ ] **Step 3: Write minimal implementation**

Append to `lib/services/ffmpeg-runner.ts`:

```ts
/**
 * Probe the duration (seconds) of a media file or HTTP URL via ffprobe. Used by
 * the render worker to learn the real duration of a video asset (which is NOT
 * populated at upload time) so the timeline can be aligned to actual media
 * length. Resolves to 0 if the probe fails or reports no duration — callers
 * treat 0/missing as "use the image default slot".
 */
export function probeFileDuration(pathOrUrl: string): Promise<number> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(pathOrUrl, (err: Error | null, data: { format?: { duration?: number | string } }) => {
      if (err || !data?.format?.duration) {
        resolve(0);
        return;
      }
      const dur = Number(data.format.duration);
      resolve(Number.isFinite(dur) ? dur : 0);
    });
  });
}
```

Note: the module already does `import ffmpeg from "fluent-ffmpeg";` (line 1) — `ffmpeg.ffprobe` is the static method on the default export.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/ffmpeg-runner.test.ts`
Expected: PASS (2 tests; the new probe test is inside the binary-guarded block, so on a machine without ffmpeg it is skipped).

- [ ] **Step 5: Commit**

```bash
git add lib/services/ffmpeg-runner.ts tests/ffmpeg-runner.test.ts
git commit -m "feat(render): add probeFileDuration helper for real asset durations"
```

---

## Task 2: Rewrite `buildTimeline` (asset-driven + real-duration-aligned)

The core of both fixes. New pure signature; old callers/tests updated in Tasks 4 and this task.

**Files:**
- Modify: `lib/services/video-compose.ts` (replace the existing `buildTimeline` and its `resolveAssetForScene` helper, lines 24–82)
- Test: `tests/video-compose.test.ts` (replace the first `describe("video-compose", ...)` block, lines 18–48)

- [ ] **Step 1: Replace the timeline unit tests**

In `tests/video-compose.test.ts`, replace the entire `describe("video-compose", () => { ... })` block (the one containing the four `it(...)` cases at lines 18–48) with:

```ts
describe("video-compose buildTimeline", () => {
  const scenes: ScriptScene[] = [
    { order: 1, text: "开场", durationSeconds: 4, assetHints: ["门店"], role: "presenter" },
    { order: 2, text: "产品", durationSeconds: 7, assetHints: ["招牌产品"], role: "broll" },
    { order: 3, text: "CTA", durationSeconds: 4, assetHints: ["促销"], role: "presenter" }
  ];
  const assets: Asset[] = [
    { id: "a1", type: "video", tags: [], businessTags: [] } as unknown as Asset,
    { id: "a2", type: "image", tags: [], businessTags: [] } as unknown as Asset,
    { id: "a3", type: "video", tags: [], businessTags: [] } as unknown as Asset
  ];

  it("presenter mode: every selected asset gets its own broll segment", () => {
    const { segments } = buildTimeline({
      scenes,
      assets,
      selectedAssetIds: ["a1", "a2", "a3"],
      assetDurations: { a1: 5, a3: 8 },
      talkingHeadDurationSec: 20
    });
    const brollAssetIds = segments
      .filter((s) => s.role === "broll")
      .map((s) => s.assetId);
    expect(brollAssetIds).toEqual(["a1", "a2", "a3"]); // all three appear, in order
  });

  it("presenter mode: total equals talking-head duration and segments are contiguous", () => {
    const { segments, totalDurationSec } = buildTimeline({
      scenes,
      assets,
      selectedAssetIds: ["a1", "a2", "a3"],
      assetDurations: { a1: 5, a3: 8 },
      talkingHeadDurationSec: 20
    });
    // Σ durations == total (no freeze-causing shortfall)
    const sum = segments.reduce((acc, s) => acc + s.durationSec, 0);
    expect(Math.abs(sum - totalDurationSec)).toBeLessThan(0.05);
    // total anchored to the talking-head length (content is plentiful here)
    expect(totalDurationSec).toBeCloseTo(20, 1);
    // contiguous windows
    expect(segments[0]?.startSec).toBe(0);
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i]?.startSec).toBeCloseTo(segments[i - 1]?.endSec ?? -1, 5);
    }
    // presenter beats bookend the timeline (opener first, CTA last)
    expect(segments[0]?.role).toBe("presenter");
    expect(segments[segments.length - 1]?.role).toBe("presenter");
  });

  it("presenter mode: a video asset never exceeds its real (capped) duration", () => {
    const { segments } = buildTimeline({
      scenes,
      assets,
      selectedAssetIds: ["a3"], // real duration 8s, cap 12s
      assetDurations: { a3: 8 },
      talkingHeadDurationSec: 40
    });
    const a3 = segments.find((s) => s.assetId === "a3");
    expect(a3?.durationSec).toBeLessThanOrEqual(8 + 0.01);
  });

  it("presenter mode: shrinks total when content cannot fill the voiceover (no freeze)", () => {
    // Only 5s of video + a 3s image = 8s of content, but voiceover is 30s.
    const { totalDurationSec } = buildTimeline({
      scenes,
      assets,
      selectedAssetIds: ["a1", "a2"],
      assetDurations: { a1: 5 },
      talkingHeadDurationSec: 30
    });
    // T_eff = min(30, presenterBudget(9) + 5 + 3) ≈ 17, well under 30 → no freeze tail.
    expect(totalDurationSec).toBeLessThan(30);
    expect(totalDurationSec).toBeGreaterThan(0);
  });

  it("asset_only mode: no talking-head → all assets appear, presenter scenes are not black", () => {
    const { segments } = buildTimeline({
      scenes,
      assets,
      selectedAssetIds: ["a1", "a2", "a3"],
      assetDurations: { a1: 5, a3: 8 }
    });
    // Every beat is a broll beat backed by an asset — no black color source.
    expect(segments.every((s) => s.role === "broll" && s.assetId !== null)).toBe(true);
    const ids = segments.map((s) => s.assetId);
    expect(ids).toEqual(["a1", "a2", "a3"]);
  });

  it("de-dupes repeated selectedAssetIds and drops ids with no matching asset", () => {
    const { segments } = buildTimeline({
      scenes,
      assets,
      selectedAssetIds: ["a1", "missing", "a1", "a2"],
      assetDurations: { a1: 5 },
      talkingHeadDurationSec: 20
    });
    const ids = segments.filter((s) => s.role === "broll").map((s) => s.assetId);
    expect(ids).toEqual(["a1", "a2"]); // missing dropped, a1 not duplicated
  });
});
```

Also update the top-of-file import in `tests/video-compose.test.ts` so the test still imports `buildTimeline` (signature changed but name is the same — no import change needed) and remove the now-unused `resolveAssetForScene`-dependent assertions. The existing `const assets` at line 16 (`asset("a1", ...)`) is replaced by the new `assets` array inside the describe; delete the old module-level `function asset(...)` and `const assets` (lines 12–16) if they become unused after the replacement. (They are still referenced by the `buildFilterGraph` describe block below, so keep `asset()` and a module-level `assets` — see Task 3.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/video-compose.test.ts`
Expected: FAIL — TypeScript errors / wrong return shape (`buildTimeline` currently returns `TimelineSegment[]`, tests expect `{ segments, totalDurationSec }`).

- [ ] **Step 3: Implement the new `buildTimeline`**

In `lib/services/video-compose.ts`, replace the existing `buildTimeline` function AND the `resolveAssetForScene` helper (lines 24–82) with:

```ts
/**
 * Build a real-duration-aligned, asset-driven timeline.
 *
 * Every selected asset becomes its own broll segment (Bug A fix: all uploaded
 * assets now appear). Segment durations are grounded in actual media length —
 * the talking-head TTS duration anchors the total in presenter mode, and each
 * video asset is ffprobe'd to its real length (Bug B fix: the concatenated
 * video stream now equals totalDurationSec, so the tail no longer freezes).
 *
 * `Σ segment.durationSec === totalDurationSec` by construction (images absorb
 * residual budget). When available content cannot fill the voiceover, the total
 * is shrunk to the content length rather than emitting a freeze frame.
 */
export interface BuildTimelineArgs {
  scenes: ScriptScene[];
  assets: Asset[];
  selectedAssetIds: string[];
  /** assetId → real ffprobe seconds, for video assets. Images are flexible. */
  assetDurations?: Record<string, number>;
  /** Authoritative total when a talking-head product exists (presenter mode). */
  talkingHeadDurationSec?: number;
  /** Duration assigned to each image asset slot. Default 3. */
  imageDefaultSec?: number;
  /** Cap a single video clip's contribution. Default 12. */
  maxClipSec?: number;
}

export interface BuildTimelineResult {
  segments: TimelineSegment[];
  totalDurationSec: number;
}

export function buildTimeline(args: BuildTimelineArgs): BuildTimelineResult {
  const assetDurations = args.assetDurations ?? {};
  const imageDefaultSec = args.imageDefaultSec ?? 3;
  const maxClipSec = args.maxClipSec ?? 12;
  const hasTalkingHead =
    typeof args.talkingHeadDurationSec === "number" && args.talkingHeadDurationSec > 0;

  // Ordered, existing, de-duped selected assets = the broll pool.
  const seen = new Set<string>();
  const pool: Asset[] = [];
  for (const id of args.selectedAssetIds) {
    if (seen.has(id)) continue;
    const asset = args.assets.find((a) => a.id === id);
    if (asset) {
      seen.add(id);
      pool.push(asset);
    }
  }

  // A video asset can contribute at most its real (capped) duration; images unbounded.
  const capFor = (a: Asset): number =>
    a.type === "video"
      ? Math.min(Math.max(assetDurations[a.id] ?? imageDefaultSec, 0.5), maxClipSec)
      : Number.POSITIVE_INFINITY;

  // Subtitle text pool: cycle scene texts across beats.
  const subtitlePool = args.scenes.map((s) => s.text).filter((t) => t.length > 0);
  let textCursor = 0;
  const nextText = (): string =>
    subtitlePool.length > 0 ? subtitlePool[textCursor++ % subtitlePool.length] : "";

  type Beat = { role: SceneRole; assetId: string | null; text: string };
  const beats: Beat[] = [];
  const orderCounter = { n: 0 };
  const beat = (role: SceneRole, assetId: string | null, text: string): void => {
    beats.push({ role, assetId, text });
    orderCounter.n += 1;
  };

  const presenterScenes = args.scenes.filter((s) => s.role === "presenter");
  const openers = presenterScenes.slice(0, -1);
  const closer = presenterScenes.length > 0 ? presenterScenes[presenterScenes.length - 1] : undefined;

  if (hasTalkingHead) {
    // [presenter openers] → [one asset per selected] → [presenter closer]
    for (const s of openers) beat("presenter", null, s.text);
    for (const a of pool) beat("broll", a.id, nextText());
    if (closer) beat("presenter", null, closer.text);
  } else {
    // asset_only: every beat is an asset beat (no black). Pool-empty fallback:
    // one beat per script scene so the video is never empty.
    for (const a of pool) beat("broll", a.id, nextText());
    if (pool.length === 0) {
      for (const s of args.scenes) beat("broll", null, s.text);
    }
  }

  // ── Duration assignment so Σ == totalDurationSec exactly ──
  const caps = beats.map((b) => {
    if (b.role === "presenter") return Number.POSITIVE_INFINITY; // talking-head trimmed within [0,T]
    const a = pool.find((x) => x.id === b.assetId);
    return a ? capFor(a) : imageDefaultSec;
  });

  let total: number;
  if (hasTalkingHead) {
    const t = args.talkingHeadDurationSec as number;
    const presenterCount = beats.filter((b) => b.role === "presenter").length;
    const presenterBudget = Math.min(t * 0.3, t); // ≤30% for talking-head beats
    const brollBudget = t - presenterBudget;
    // If max possible broll content < brollBudget, shrink so the video fits content.
    const maxBroll = caps.reduce((acc, c, i) => acc + (beats[i].role === "broll" ? Math.min(c, imageDefaultSec > 0 ? c : c) : 0), 0);
    const achievableBroll = beats.reduce((acc, b, i) => acc + (b.role === "broll" ? Math.min(caps[i], imageDefaultSec && !Number.isFinite(caps[i]) ? imageDefaultSec : caps[i]) : 0), 0);
    const presenterSum = presenterCount > 0 ? presenterBudget : 0;
    const effectiveBrollBudget = Math.min(brollBudget, Math.max(achievableBroll, 0));
    total = presenterSum + effectiveBrollBudget;

    const durations = new Array<number>(beats.length).fill(0);
    // Presenter beats: even split of presenterBudget (or scaled if total shrunk).
    const scaledPresenter = presenterCount > 0 ? Math.min(presenterBudget, total) / presenterCount : 0;
    const brollEntries: Array<{ idx: number; cap: number }> = [];
    beats.forEach((b, i) => {
      if (b.role === "presenter") {
        durations[i] = scaledPresenter;
      } else {
        brollEntries.push({ idx: i, cap: caps[i] });
      }
    });
    distributeCapped(brollEntries, effectiveBrollBudget, imageDefaultSec, durations);
    return materialize(beats, durations);
  }

  // asset_only: each beat = its asset's contribution (video capped, image default).
  const durations = beats.map((_, i) => (Number.isFinite(caps[i]) ? caps[i] : imageDefaultSec));
  total = durations.reduce((acc, d) => acc + d, 0);
  return materialize(beats, durations);
}

/** Water-filling: distribute `budget` across entries respecting per-entry caps;
 *  images (cap = Infinity) absorb residual so Σ == budget. Mutates `out`. */
function distributeCapped(
  entries: Array<{ idx: number; cap: number }>,
  budget: number,
  imageDefaultSec: number,
  out: number[]
): void {
  if (entries.length === 0) return;
  const finite = entries.filter((e) => Number.isFinite(e.cap));
  const infinite = entries.filter((e) => !Number.isFinite(e.cap));
  const done = new Set<number>();
  let left = budget;

  while (true) {
    const openFinite = finite.filter((e) => !done.has(e.idx));
    const openCount = openFinite.length + infinite.length;
    if (openCount === 0) break;
    const fair = left / openCount;
    let capped = false;
    for (const e of openFinite) {
      if (e.cap <= fair) {
        out[e.idx] = e.cap;
        left -= e.cap;
        done.add(e.idx);
        capped = true;
      }
    }
    if (!capped) break; // remaining entries all get ≥ fair
  }

  // Split the residual across everything still open (finite-not-capped + images).
  const open = entries.filter((e) => !done.has(e.idx));
  if (open.length > 0) {
    const share = left / open.length;
    for (const e of open) out[e.idx] = share;
  }
}

/** Accumulate beat durations into contiguous [start,end] TimelineSegments. */
function materialize(beats: Array<{ role: SceneRole; assetId: string | null; text: string }>, durations: number[]): BuildTimelineResult {
  let cursor = 0;
  const segments: TimelineSegment[] = beats.map((b, i) => {
    const duration = Math.max(durations[i] ?? 0.1, 0.1);
    const start = cursor;
    cursor = start + duration;
    return {
      role: b.role,
      startSec: start,
      endSec: cursor,
      durationSec: duration,
      sceneOrder: i + 1,
      text: b.text,
      assetId: b.assetId
    };
  });
  return { segments, totalDurationSec: cursor };
}
```

> **Note for the implementer:** the `maxBroll`/`achievableBroll` lines in the presenter branch contain a redundant expression left in for clarity of intent (`Math.min(c, …)`). If `npm run lint` complains about unused/redundant sub-expressions, simplify `achievableBroll` to:
> ```ts
> const achievableBroll = beats.reduce(
>   (acc, b, i) => acc + (b.role === "broll" ? Math.min(caps[i], Number.isFinite(caps[i]) ? caps[i] : imageDefaultSec) : 0),
>   0
> );
> ```
> and delete the `maxBroll` line. The test "shrinks total when content cannot fill the voiceover" asserts this path.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/video-compose.test.ts`
Expected: the new `buildTimeline` tests PASS. The `buildAss` and `buildFilterGraph` describe blocks may now fail because they hand-build `TimelineSegment[]` literals — those still work (they don't call `buildTimeline`), so they should still pass. If any fail due to the removed `resolveAssetForScene` import, fix the import list.

- [ ] **Step 5: Commit**

```bash
git add lib/services/video-compose.ts tests/video-compose.test.ts
git commit -m "feat(render): asset-driven timeline with real-duration alignment (Bug A+B core)"
```

---

## Task 3: `buildFilterGraph` — asset_only presenter renders the asset, not black

Currently in `asset_only` mode, presenter scenes (assetId null) fall through to `color=c=black`. After Task 2, asset_only has no presenter beats (every beat is a broll beat with an assetId), so this branch is only hit for beats with `assetId == null` (the pool-empty fallback). We keep the black fallback for that case but ensure resolved assets always render. This task also re-verifies the existing filter-graph assertions still hold with the new timeline shape.

**Files:**
- Modify: `lib/services/video-compose.ts` — the `else` branch in `buildFilterGraph` (around lines 215–224) is already correct (it renders the asset when `idx !== undefined`, else black). **No code change required**; this task only adds a regression test proving asset_only presenter-via-asset is not black.
- Test: `tests/video-compose.test.ts` — add a case to the `describe("buildFilterGraph")` block.

- [ ] **Step 1: Add the regression test**

In `tests/video-compose.test.ts`, inside `describe("buildFilterGraph", () => { ... })`, add:

```ts
  it("asset_only: a broll beat with a resolved asset never falls back to black color source", () => {
    const g = buildFilterGraph({
      mode: "asset_only",
      segments: [
        { role: "broll", startSec: 0, endSec: 4, durationSec: 4, sceneOrder: 1, text: "x", assetId: "a1" }
      ],
      assetInputIndex: { a1: 0 },
      assPath: "/tmp/subs.ass",
      width: 1080,
      height: 1920,
      totalDurationSec: 4
    });
    expect(g.filterComplex).toContain("[0:v]trim=duration=4");
    expect(g.filterComplex).not.toContain("color=c=black");
  });
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/video-compose.test.ts`
Expected: PASS (the existing `buildFilterGraph` already renders the asset and only uses black when `idx === undefined`). This test locks that behavior so the asset_only black-screen bug cannot regress.

- [ ] **Step 3: Commit**

```bash
git add tests/video-compose.test.ts
git commit -m "test(render): lock asset_only resolved-asset rendering (no black fallback)"
```

---

## Task 4: Worker wiring — probe real durations, call new `buildTimeline`

The worker gains an injected `probeAssetDuration` dep (default = presign + ffprobe over HTTP) and feeds real durations + `talkingHead.durationSeconds` into the new `buildTimeline`.

**Files:**
- Modify: `worker/processors/video-render.ts`
- Test: `tests/worker-processors.test.ts`

- [ ] **Step 1: Update the worker test for the new contract**

In `tests/worker-processors.test.ts`:

(a) Extend `seedProject` to create two video assets and reference them from `selectedAssetIds`. Replace the `project` literal inside `seedProject` (lines 79–93) so `selectedAssetIds: []` becomes `selectedAssetIds: opts.selectedAssetIds ?? ["asset_v1", "asset_v2"]`, and before `createProject`, insert the assets:

```ts
    await getAssetRepository().create({
      id: "asset_v1",
      ownerId: "demo_user",
      storeId: "store_1",
      type: "video",
      originalFilename: "v1.mp4",
      storageKey: "uploads/v1.mp4",
      mimeType: "video/mp4",
      sizeBytes: 1000,
      tags: [],
      businessTags: [],
      status: "ready",
      createdAt: now
    });
    await getAssetRepository().create({
      id: "asset_v2",
      ownerId: "demo_user",
      storeId: "store_1",
      type: "image",
      originalFilename: "v2.png",
      storageKey: "uploads/v2.png",
      mimeType: "image/png",
      sizeBytes: 500,
      tags: [],
      businessTags: [],
      status: "ready",
      createdAt: now
    });
```

Change the `opts` type to `{ withTalkingHead?: boolean; selectedAssetIds?: string[] }`.

(b) Replace `depsWithFakeComposite` (lines 111–132) so it also injects a fake `probeAssetDuration` and captures the assets/talking-head passed in:

```ts
  function depsWithFakeComposite(
    capture: {
      mode?: CompositionMode;
      totalDuration?: number;
      assetIds?: string[];
      talkingHeadDuration?: number;
    } = {},
    probeDurations: Record<string, number> = { asset_v1: 5 }
  ) {
    return {
      renderRepository: getRenderRepository(),
      scriptRepository: getScriptRepository(),
      assetRepository: getAssetRepository(),
      bgmTrackRepository: getBgmTrackRepository(),
      probeAssetDuration: async (asset: { id: string; type: string }) =>
        asset.type === "video" ? (probeDurations[asset.id] ?? 4) : undefined,
      renderComposite: async (input: {
        mode: CompositionMode;
        totalDurationSec: number;
        projectId: string;
        segments: Array<{ assetId: string | null }>;
        talkingHead?: { durationSeconds: number } | null;
        onProgress: (pct: number) => void;
      }) => {
        capture.mode = input.mode;
        capture.totalDuration = input.totalDurationSec;
        capture.assetIds = input.segments.map((s) => s.assetId).filter(Boolean) as string[];
        capture.talkingHeadDuration = input.talkingHead?.durationSeconds ?? undefined;
        input.onProgress(50);
        return {
          storageKey: `renders/${input.projectId}/output-fake.mp4`,
          durationSeconds: input.totalDurationSec
        };
      }
    };
  }
```

(c) Update the assertions in `"writes a kind=final_composite VideoOutput..."` (around line 134). Replace the body's expects with:

```ts
    const capture: { mode?: CompositionMode; totalDuration?: number; assetIds?: string[] } = {};
    const output = await processVideoRender(
      mockJob as unknown as BullJob,
      depsWithFakeComposite(capture) as never
    );

    expect(output.kind).toBe("final_composite");
    expect(output.renderProjectId).toBe(projectId);
    expect(output.storageKey).toContain("renders/");
    expect(capture.mode).toBe("asset_only"); // no talking-head product
    // asset_only: both assets appear; total = video(5, capped) + image(3) = 8
    expect(capture.assetIds).toEqual(["asset_v1", "asset_v2"]);
    expect(capture.totalDuration).toBeCloseTo(8, 5);
    expect(updateProgress).toHaveBeenCalled();
    const persisted = await getRenderRepository().findOutputById(output.id);
    expect(persisted?.kind).toBe("final_composite");
```

(d) In `"uses presenter_broll mode when a talking-head product exists"` (around line 157), also assert the talking-head duration is forwarded and all assets still appear:

```ts
    const capture: { mode?: CompositionMode; assetIds?: string[]; talkingHeadDuration?: number } = {};
    const mockJob = {
      data: { jobId: "j2", projectId, ownerId: "demo_user", payload: { aspectRatio: "9:16", subtitleStyle: "bold_bottom" }, dependsOnJobIds: [] },
      updateProgress: vi.fn()
    };
    await processVideoRender(mockJob as unknown as BullJob, depsWithFakeComposite(capture) as never);
    expect(capture.mode).toBe("presenter_broll");
    expect(capture.talkingHeadDuration).toBe(10);
    expect(capture.assetIds).toEqual(["asset_v1", "asset_v2"]); // Bug A fix: all assets present
```

(e) Add one new test proving real probed durations change the total (Bug B fix):

```ts
  it("aligns total to real probed asset durations, not planned scene durations", async () => {
    const projectId = await seedProject({ withTalkingHead: true });
    const capture: { totalDuration?: number } = {};
    const mockJob = {
      data: { jobId: "j_dur", projectId, ownerId: "demo_user", payload: { aspectRatio: "9:16", subtitleStyle: "bold_bottom" }, dependsOnJobIds: [] },
      updateProgress: vi.fn()
    };
    // talking-head is 10s. presenter budget = 3s, broll budget = 7s. asset_v1 real=2s
    // (cap 2), asset_v2 image absorbs the rest → total still anchored at 10s.
    await processVideoRender(
      mockJob as unknown as BullJob,
      depsWithFakeComposite(capture, { asset_v1: 2 }) as never
    );
    expect(capture.totalDuration).toBeCloseTo(10, 5); // anchored to talking-head, not 4+6=10 by luck
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/worker-processors.test.ts`
Expected: FAIL — `probeAssetDuration` is not part of `VideoRenderDeps`; `processVideoRender` still passes the old shape to `renderComposite`; `capture.assetIds` undefined.

- [ ] **Step 3: Implement the worker changes**

In `worker/processors/video-render.ts`:

(a) Add imports (top of file, extend the existing `video-compose` import block at lines 16–24):

```ts
import { probeFileDuration } from "@/lib/services/ffmpeg-runner";
import { createPresignedGetUrl } from "@/lib/storage";
```

(b) Extend `VideoRenderDeps` (lines 60–66) with the probe dep:

```ts
export interface VideoRenderDeps {
  renderRepository: RenderRepository;
  scriptRepository: ScriptRepository;
  assetRepository: AssetRepository;
  bgmTrackRepository: BgmTrackRepository;
  /** Returns real duration (seconds) for a video asset; undefined for images / on failure. */
  probeAssetDuration: (asset: Asset) => Promise<number | undefined>;
  renderComposite: RenderCompositeFn;
}
```

(c) Add the default probe implementation above `processVideoRender` (after the `RenderCompositeFn` type, ~line 58):

```ts
/**
 * Default duration probe: presign a short-lived GET URL and ffprobe over HTTP
 * (no full download). Returns undefined for non-video assets or on any error so
 * the timeline falls back to the image-default slot instead of failing the render.
 */
export const defaultProbeAssetDuration = async (asset: Asset): Promise<number | undefined> => {
  if (asset.type !== "video") return undefined;
  try {
    const url = await createPresignedGetUrl(asset.storageKey, 60);
    const dur = await probeFileDuration(url);
    return dur > 0 ? dur : undefined;
  } catch (err) {
    console.warn(
      `[video_render] probeAssetDuration failed for ${asset.id}: ${err instanceof Error ? err.message : String(err)}`
    );
    return undefined;
  }
};
```

(d) Wire the default into the processor export (lines 77–84):

```ts
export const videoRenderProcessor: ProcessorFn = (job) =>
  processVideoRender(job, {
    renderRepository: getRenderRepository(),
    scriptRepository: getScriptRepository(),
    assetRepository: getAssetRepository(),
    bgmTrackRepository: getBgmTrackRepository(),
    probeAssetDuration: defaultProbeAssetDuration,
    renderComposite: defaultRenderComposite
  });
```

(e) Rewrite the body of `processVideoRender` (lines 86–131) — replace the timeline-building section so it probes real durations and calls the new `buildTimeline`. Replace from `const talkingHead = ...` (line 97) through the `renderComposite({ ... })` call (line 131) with:

```ts
  const talkingHead = await deps.renderRepository.findTalkingHeadOutputByProject(projectId);
  const mode = resolveCompositionMode(talkingHead);

  // Resolve selected assets (filter to existing ones).
  const assetResults = await Promise.all(
    project.selectedAssetIds.map((id) => deps.assetRepository.findById(id))
  );
  const assets = assetResults.filter((a): a is Asset => a !== null);

  // Probe real durations for video assets (Bug B: align timeline to actual media).
  const probeEntries = await Promise.all(
    assets.map(async (a) => (a.type === "video" ? [a.id, await deps.probeAssetDuration(a)] as const : null))
  );
  const assetDurations: Record<string, number> = {};
  for (const entry of probeEntries) {
    if (entry && typeof entry[1] === "number") assetDurations[entry[0]] = entry[1];
  }

  const { segments, totalDurationSec } = buildTimeline({
    scenes: draft.scenes,
    assets,
    selectedAssetIds: project.selectedAssetIds,
    assetDurations,
    talkingHeadDurationSec: talkingHead?.durationSeconds
  });

  const bgmTrack = project.bgmTrackId
    ? await deps.bgmTrackRepository.findById(project.bgmTrackId)
    : null;

  const { storageKey, durationSeconds } = await deps.renderComposite({
    projectId,
    mode,
    segments,
    assContent: buildAss(segments, resolveSubtitlePreset(project.subtitleStyle)),
    subtitleStyle: project.subtitleStyle,
    talkingHead,
    assets,
    bgmTrack,
    aspectRatio: project.aspectRatio,
    totalDurationSec,
    onProgress: (pct) => {
      void job.updateProgress(pct);
    }
  });
```

(The rest of `processVideoRender` — the `VideoOutput` creation and `createOutput` — stays as-is.)

`defaultRenderComposite` already builds its filter graph from `input.timeline` — but `RenderCompositeInput` (lines 44–56) currently has `timeline: TimelineSegment[]`. Rename that field to `segments` to match what we now pass, and update the two references inside `defaultRenderComposite` (`input.timeline` at lines 184 and 195 → `input.segments`). The `RenderCompositeInput` interface becomes:

```ts
export interface RenderCompositeInput {
  projectId: string;
  mode: CompositionMode;
  segments: TimelineSegment[];
  assContent: string;
  subtitleStyle: string;
  talkingHead: VideoOutput | null;
  assets: Asset[];
  bgmTrack: BgmTrack | null;
  aspectRatio: string;
  totalDurationSec: number;
  onProgress: (pct: number) => void;
}
```

And in `defaultRenderComposite`, change `for (const seg of input.timeline)` → `for (const seg of input.segments)` (two occurrences: the dedup loop ~line 184 and any other `input.timeline` reference).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/worker-processors.test.ts`
Expected: PASS — all four video-render tests green (asset_only total ≈ 8, presenter mode forwards talkingHead duration 10, both assets present in both modes, probed-duration alignment test passes).

- [ ] **Step 5: Commit**

```bash
git add worker/processors/video-render.ts tests/worker-processors.test.ts
git commit -m "feat(render): probe real asset durations + drive timeline from them (Bug A+B wiring)"
```

---

## Task 5: Full verification + memory/docs

**Files:**
- No code changes; verification only + memory update.

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: 0 errors. If errors remain in `video-render.ts` or `video-compose.ts`, fix the type drift (common: `input.timeline` → `input.segments` missed at a call site).

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: 0 errors. If the redundant `maxBroll`/`achievableBroll` expression in Task 2 Step 3 trips the linter, apply the simplification noted there.

- [ ] **Step 3: Tests**

Run: `npm test`
Expected: all green. (Previous total was 192; this plan adds ~6 net tests.)

- [ ] **Step 4: Prisma validate + build**

Run: `npx prisma validate && npm run build`
Expected: validate OK, build exit 0.

- [ ] **Step 5: Update memory**

Update `C:\Users\Administrator\.claude\projects\C--Users-Administrator-Projects-ai-video-assistant\memory\talking-head-ffmpeg-feature-status.md` — append to the body a note that the asset-driven real-duration timeline shipped (fixes "只用两个素材" + "后几秒卡住"), and move those items out of the待办 if present.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore(render): verify CI green after asset-driven timeline"
```

Then push to `origin/main` to trigger Zeabur auto-deploy:

```bash
git push origin main
```

---

## Self-Review

**Spec coverage:**
- Bug A (only 2 assets used) → Task 2 (`buildTimeline` creates one segment per selected asset; de-dup test) + Task 4 (worker forwards all). ✓
- Bug B (tail freeze) → Task 2 (`Σ == totalDurationSec`; shrink-when-content-short test) + Task 1/Task 4 (real durations via ffprobe). ✓
- Latent asset_only black-screen → Task 2 (asset_only beats are all asset beats) + Task 3 (regression test). ✓

**Placeholder scan:** All steps contain concrete code and exact commands. The one flagged "redundant expression" in Task 2 Step 3 ships working code plus a documented simplification if the linter complains — not a placeholder.

**Type consistency:** `buildTimeline` returns `{ segments, totalDurationSec }` everywhere it's used (Task 2 impl, Task 2 tests, Task 4 worker). `RenderCompositeInput.timeline` is renamed to `segments` in Task 4 and the worker passes `segments`. `probeAssetDuration(asset: Asset) => Promise<number | undefined>` signature matches between the interface, the default impl, and the test fake. `defaultProbeAssetDuration` references `probeFileDuration` (added in Task 1) and `createPresignedGetUrl` (exists in `lib/storage.ts:86`).
