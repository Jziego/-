import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/bgm-tracks/route";
import * as repositories from "@/lib/repositories";
import { MemoryBgmTrackRepository } from "@/lib/repositories/memory";
import { resetRuntimeStateForTests } from "@/lib/runtime-store";
import type { BgmTrack } from "@/lib/types";

function track(id: string, name: string): BgmTrack {
  return {
    id, name, storageKey: `bgm/${id}.mp3`, durationSeconds: 30,
    category: "general", createdAt: "2026-07-23T00:00:00.000Z",
  };
}

describe("GET /api/bgm-tracks", () => {
  beforeEach(() => {
    resetRuntimeStateForTests();
    vi.spyOn(repositories, "getBgmTrackRepository").mockImplementation(
      () => new MemoryBgmTrackRepository(),
    );
  });

  it("lists system tracks without leaking storageKey", async () => {
    const repo = new MemoryBgmTrackRepository();
    await repo.create(track("bgm_upbeat_01", "欢快01"));
    await repo.create(track("bgm_calm_01", "舒缓01"));

    const res = await GET(new Request("http://localhost/api/bgm-tracks"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.tracks).toHaveLength(2);
    expect(json.tracks[0]).toMatchObject({ id: "bgm_upbeat_01", name: "欢快01", category: "general" });
    // 安全：不返回 storageKey（对象存储路径）
    expect(JSON.stringify(json)).not.toContain("storageKey");
    expect(JSON.stringify(json)).not.toContain(".mp3");
  });
});
