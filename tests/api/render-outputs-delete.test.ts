import { beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE } from "@/app/api/render-projects/outputs/[id]/route";
import * as repositories from "@/lib/repositories";
import { MemoryRenderRepository } from "@/lib/repositories/memory";
import { resetRuntimeStateForTests } from "@/lib/runtime-store";
import * as storage from "@/lib/storage";
import type { VideoOutput } from "@/lib/types";

function sampleOutput(overrides: Partial<VideoOutput> = {}): VideoOutput {
  return {
    id: "out_1",
    ownerId: "demo_user",
    renderProjectId: null,
    storageKey: "outputs/out_1.mp4",
    aspectRatio: "9:16",
    durationSeconds: 45,
    kind: "talking_head",
    status: "ready",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function callDelete(id: string): Promise<Response> {
  const req = new Request(`http://localhost/api/render-projects/outputs/${id}`, { method: "DELETE" });
  return DELETE(req, { params: Promise.resolve({ id }) });
}

describe("DELETE /api/render-projects/outputs/[id]", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetRuntimeStateForTests();
    vi.spyOn(repositories, "getRenderRepository").mockImplementation(() => new MemoryRenderRepository());
    vi.spyOn(storage, "deleteObject").mockResolvedValue(undefined);
  });

  it("returns 404 when the output does not exist", async () => {
    const res = await callDelete("out_missing");
    expect(res.status).toBe(404);
  });

  it("returns 404 when the output belongs to another owner (IDOR guard)", async () => {
    const repo = new MemoryRenderRepository();
    await repo.createOutput(sampleOutput({ id: "out_foreign", ownerId: "other_user" }));

    const res = await callDelete("out_foreign");
    expect(res.status).toBe(404);
    expect(await repo.findOutputById("out_foreign")).not.toBeNull();
  });

  it("deletes the owner's output and cleans storage incl. cover", async () => {
    const repo = new MemoryRenderRepository();
    await repo.createOutput(sampleOutput({ id: "out_mine", coverStorageKey: "outputs/out_mine.jpg" }));

    const res = await callDelete("out_mine");

    expect(res.status).toBe(200);
    expect(await repo.findOutputById("out_mine")).toBeNull();
    expect(storage.deleteObject).toHaveBeenCalledWith("outputs/out_1.mp4");
    expect(storage.deleteObject).toHaveBeenCalledWith("outputs/out_mine.jpg");
  });

  it("still returns 200 when R2 cleanup fails (best-effort)", async () => {
    const repo = new MemoryRenderRepository();
    await repo.createOutput(sampleOutput({ id: "out_r2fail" }));
    vi.spyOn(storage, "deleteObject").mockRejectedValue(new Error("R2 down"));

    const res = await callDelete("out_r2fail");

    expect(res.status).toBe(200);
    expect(await repo.findOutputById("out_r2fail")).toBeNull();
  });
});
