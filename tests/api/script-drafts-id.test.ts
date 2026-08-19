import { beforeEach, describe, expect, it, vi } from "vitest";
import { PATCH } from "@/app/api/script-drafts/[id]/route";
import * as repositories from "@/lib/repositories";
import { MemoryScriptRepository } from "@/lib/repositories/memory";
import { resetRuntimeStateForTests } from "@/lib/runtime-store";
import type { ScriptDraft } from "@/lib/types";

function draftRow(id: string, ownerId: string): ScriptDraft {
  return {
    id, ownerId, storeId: "store_1", purpose: "store_traffic", platform: "douyin",
    title: "t", hook: "h",
    scenes: [{ order: 1, text: "旧镜", durationSeconds: 4, assetHints: [], role: "presenter" }],
    voiceover: "开场介绍产品词。结尾欢迎光临。",
    highlights: ["产品词", "已删词"],
    segments: [
      { index: 0, text: "开场介绍产品词。", speakerIndex: 0, onCamera: true },
      { index: 1, text: "结尾欢迎光临。", speakerIndex: 0, onCamera: false },
    ],
    captions: [], cta: "c", generationMode: "ai", complianceWarnings: [],
    createdAt: "2026-08-19T00:00:00.000Z",
  };
}

function req(body: unknown, id: string): [Request, { params: Promise<{ id: string }> }] {
  return [
    new Request(`http://localhost/api/script-drafts/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  ];
}

describe("PATCH /api/script-drafts/[id] (voiceover-centric)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetRuntimeStateForTests();
    vi.spyOn(repositories, "getScriptRepository").mockImplementation(() => new MemoryScriptRepository());
  });

  it("rewrites voiceover, re-derives segments/scenes and drops stale highlights", async () => {
    const scripts = new MemoryScriptRepository();
    await scripts.create(draftRow("script_patch", "demo_user"));

    const [request, ctx] = req({ voiceover: "全新的开场。全新的收尾。" }, "script_patch");
    const res = await PATCH(request, ctx);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.script.voiceover).toBe("全新的开场。全新的收尾。");
    expect(json.script.segments.map((s: { text: string }) => s.text)).toEqual([
      "全新的开场。", "全新的收尾。",
    ]);
    expect(
      json.script.segments.every((s: { speakerIndex: number }) => s.speakerIndex === 0),
    ).toBe(true);
    // 旧标黄词均不在新稿 → 全部失效
    expect(json.script.highlights).toEqual([]);
    // scenes 重派生：首/末句 presenter
    expect(json.script.scenes).toHaveLength(2);
    expect(json.script.scenes[0].text).toBe("全新的开场。");
    expect(json.script.scenes[0].role).toBe("presenter");
    // captions 统一落 [voiceover]，不滞留旧文本
    expect(json.script.captions).toEqual(["全新的开场。全新的收尾。"]);
  });

  it("keeps highlights still present and inherits onCamera for unchanged sentences", async () => {
    const scripts = new MemoryScriptRepository();
    await scripts.create(draftRow("script_patch", "demo_user"));

    const [request, ctx] = req(
      { voiceover: "开场介绍产品词。全新中段。全新收尾。" },
      "script_patch",
    );
    const res = await PATCH(request, ctx);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.script.highlights).toEqual(["产品词"]);
    expect(json.script.segments.map((s: { onCamera: boolean }) => s.onCamera)).toEqual([
      true, false, true,
    ]);
  });

  it("returns 400 when voiceover is missing or empty", async () => {
    const scripts = new MemoryScriptRepository();
    await scripts.create(draftRow("script_patch", "demo_user"));
    for (const body of [{}, { voiceover: "   " }, { voiceover: 42 }]) {
      const [request, ctx] = req(body, "script_patch");
      const res = await PATCH(request, ctx);
      expect(res.status).toBe(400);
    }
  });

  it("returns 400 when voiceover exceeds 2000 chars, 2000 chars is accepted", async () => {
    const scripts = new MemoryScriptRepository();
    await scripts.create(draftRow("script_patch", "demo_user"));
    const [tooLongReq, tooLongCtx] = req({ voiceover: "字".repeat(2001) }, "script_patch");
    expect((await PATCH(tooLongReq, tooLongCtx)).status).toBe(400);
    const [okReq, okCtx] = req({ voiceover: "字".repeat(2000) }, "script_patch");
    expect((await PATCH(okReq, okCtx)).status).toBe(200);
  });

  it("returns 404 for a draft owned by someone else (no existence leak)", async () => {
    const scripts = new MemoryScriptRepository();
    await scripts.create(draftRow("script_other", "user_other"));
    const [request, ctx] = req({ voiceover: "x" }, "script_other");
    const res = await PATCH(request, ctx);
    expect(res.status).toBe(404);
  });

  it("returns 400 when body is not valid JSON", async () => {
    const request = new Request("http://localhost/api/script-drafts/script_patch", {
      method: "PATCH",
      body: "not json",
    });
    const ctx = { params: Promise.resolve({ id: "script_patch" }) };
    const res = await PATCH(request, ctx);
    expect(res.status).toBe(400);
  });
});
