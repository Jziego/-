import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockGetOwnerId, mockFindOutputById, mockDeleteOutput, mockDeleteObject } = vi.hoisted(() => ({
  mockGetOwnerId: vi.fn(),
  mockFindOutputById: vi.fn(),
  mockDeleteOutput: vi.fn(),
  mockDeleteObject: vi.fn(),
}));

vi.mock("@/lib/auth-helpers", () => ({ getOwnerId: mockGetOwnerId }));
vi.mock("@/lib/rate-limit", () => ({ applyRateLimit: vi.fn(async () => null) }));
vi.mock("@/lib/repositories", () => ({
  getRenderRepository: () => ({
    findOutputById: mockFindOutputById,
    deleteOutput: mockDeleteOutput,
  }),
}));
vi.mock("@/lib/storage", () => ({ deleteObject: mockDeleteObject }));

import { DELETE } from "@/app/api/render-projects/outputs/[id]/route";

function makeRequest(): Request {
  return new Request("http://localhost/api/render-projects/outputs/out_1", { method: "DELETE" });
}
function makeCtx(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("DELETE /api/render-projects/outputs/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetOwnerId.mockResolvedValue("user_1");
  });

  it("returns English 404 message for missing or foreign output (IDOR-safe)", async () => {
    mockFindOutputById.mockResolvedValue(null);
    const res = await DELETE(makeRequest(), makeCtx("out_x"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Output not found");
  });

  it("returns English 404 when output belongs to another owner", async () => {
    mockFindOutputById.mockResolvedValue({ ownerId: "user_2", storageKey: "k" });
    const res = await DELETE(makeRequest(), makeCtx("out_1"));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Output not found");
  });

  it("deletes row and best-effort R2 objects (incl. cover) without try/catch wrap", async () => {
    mockFindOutputById.mockResolvedValue({
      ownerId: "user_1",
      storageKey: "renders/out_1.mp4",
      coverStorageKey: "renders/out_1.jpg",
    });
    mockDeleteOutput.mockResolvedValue(true);
    mockDeleteObject.mockResolvedValue(undefined);
    const res = await DELETE(makeRequest(), makeCtx("out_1"));
    expect(res.status).toBe(200);
    expect(mockDeleteObject).toHaveBeenCalledWith("renders/out_1.mp4");
    expect(mockDeleteObject).toHaveBeenCalledWith("renders/out_1.jpg");
  });
});
