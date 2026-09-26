import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
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

describe("mappers: analysis persistence (批次二)", () => {
  const analysis = { overview: "概述", principles: "原则解析", structure: "结构解析" };

  it("maps a valid analysis object through unchanged", () => {
    const dbInput = toScriptDraftInput({ ...draft, analysis });
    const row = { ...dbInput, createdAt: new Date("2026-08-16T00:00:00.000Z") };
    const back = toScriptDraft(row as never);
    expect(back.analysis).toEqual(analysis);
  });

  it("writes undefined analysis as DbNull and maps SQL NULL back to undefined", () => {
    const dbInput = toScriptDraftInput({ ...draft, analysis: undefined });
    expect(dbInput.analysis).toBe(Prisma.DbNull);
    const row = { ...dbInput, analysis: null, createdAt: new Date("2026-08-16T00:00:00.000Z") };
    const back = toScriptDraft(row as never);
    expect(back.analysis).toBeUndefined();
  });

  it("maps legacy JSON null rows (Prisma.JsonNull) to undefined", () => {
    const dbInput = toScriptDraftInput({ ...draft, analysis });
    const row = {
      ...dbInput,
      analysis: Prisma.JsonNull,
      createdAt: new Date("2026-08-16T00:00:00.000Z"),
    };
    const back = toScriptDraft(row as never);
    expect(back.analysis).toBeUndefined();
  });
});
