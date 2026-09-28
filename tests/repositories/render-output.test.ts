import { beforeEach, describe, expect, it } from "vitest";
import { MemoryRenderRepository } from "@/lib/repositories/memory";
import { resetRuntimeStateForTests } from "@/lib/runtime-store";
import type { VideoOutput } from "@/lib/types";

function sampleOutput(id: string, ownerId = "demo_user"): VideoOutput {
  return {
    id,
    ownerId,
    renderProjectId: null,
    storageKey: `outputs/${id}.mp4`,
    aspectRatio: "9:16",
    durationSeconds: 45,
    kind: "talking_head",
    status: "ready",
    createdAt: new Date().toISOString(),
  };
}

describe("MemoryRenderRepository.deleteOutput", () => {
  beforeEach(() => {
    resetRuntimeStateForTests();
  });

  it("deletes an existing output and returns true", async () => {
    const repo = new MemoryRenderRepository();
    await repo.createOutput(sampleOutput("out_1"));

    expect(await repo.deleteOutput("out_1")).toBe(true);
    expect(await repo.findOutputById("out_1")).toBeNull();
  });

  it("returns false for a missing output", async () => {
    const repo = new MemoryRenderRepository();
    expect(await repo.deleteOutput("out_missing")).toBe(false);
  });
});
