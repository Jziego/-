import { describe, expect, it } from "vitest";
import {
  toRenderProject,
  toRenderProjectInput,
  toScriptDraft,
  toScriptDraftInput,
} from "@/lib/repositories/mappers";
import type { RenderProject, ScriptDraft } from "@/lib/types";

const draft: ScriptDraft = {
  id: "script_1",
  ownerId: "u",
  storeId: "s",
  purpose: "store_traffic",
  platform: "douyin",
  title: "t",
  hook: "h",
  scenes: [{ order: 1, text: "x", durationSeconds: 5, assetHints: [], role: "presenter" }],
  voiceover: "v",
  captions: [],
  cta: "c",
  generationMode: "ai",
  complianceWarnings: [],
  targetDurationSec: 45,
  createdAt: "2026-08-16T00:00:00.000Z",
};

const project: RenderProject = {
  id: "render_1",
  ownerId: "u",
  storeId: "s",
  scriptDraftId: "script_1",
  selectedAssetIds: ["a1"],
  purpose: "store_traffic",
  aspectRatio: "9:16",
  subtitleStyle: "default",
  targetDurationSec: 45,
  status: "queued",
  createdAt: "2026-08-16T00:00:00.000Z",
  updatedAt: "2026-08-16T00:00:00.000Z",
};

describe("mappers: targetDurationSec persistence", () => {
  it("toScriptDraftInput / toScriptDraft roundtrip targetDurationSec", () => {
    const dbInput = toScriptDraftInput(draft);
    expect(dbInput.targetDurationSec).toBe(45);
    const row = { ...dbInput, createdAt: new Date("2026-08-16T00:00:00.000Z") };
    const back = toScriptDraft(row as never);
    expect(back.targetDurationSec).toBe(45);
  });

  it("toRenderProjectInput / toRenderProject roundtrip targetDurationSec", () => {
    const dbInput = toRenderProjectInput(project);
    expect(dbInput.targetDurationSec).toBe(45);
    const row = {
      ...dbInput,
      createdAt: new Date("2026-08-16T00:00:00.000Z"),
      updatedAt: new Date("2026-08-16T00:00:00.000Z"),
    };
    const back = toRenderProject(row as never);
    expect(back.targetDurationSec).toBe(45);
  });
});

describe("mappers: highlights/segments persistence (Phase 2)", () => {
  it("toScriptDraftInput / toScriptDraft roundtrip highlights + segments", () => {
    const draftWithHl: ScriptDraft = {
      ...draft,
      highlights: ["牛肉面", "第二份半价"],
      segments: [
        { index: 0, text: "第一句。", speakerIndex: 0, onCamera: true },
        { index: 1, text: "第二句。", speakerIndex: 0, onCamera: false },
      ],
    };
    const dbInput = toScriptDraftInput(draftWithHl);
    expect(dbInput.highlights).toEqual(["牛肉面", "第二份半价"]);
    const row = { ...dbInput, createdAt: new Date("2026-08-16T00:00:00.000Z") };
    const back = toScriptDraft(row as never);
    expect(back.highlights).toEqual(["牛肉面", "第二份半价"]);
    expect(back.segments).toEqual([
      { index: 0, text: "第一句。", speakerIndex: 0, onCamera: true },
      { index: 1, text: "第二句。", speakerIndex: 0, onCamera: false },
    ]);
  });

  it("defaults highlights/segments to empty when absent on the domain object", () => {
    const dbInput = toScriptDraftInput({ ...draft, highlights: undefined, segments: undefined });
    expect(dbInput.highlights).toEqual([]);
    expect(dbInput.segments).toEqual([]);
  });
});
