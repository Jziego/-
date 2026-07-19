import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/assets/upload-intent/route";
import { resetRuntimeStateForTests } from "@/lib/runtime-store";

const savedDbUrl = process.env.DATABASE_URL;

function req(body: unknown): Request {
  return new Request("http://localhost/api/assets/upload-intent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/assets/upload-intent — error handling", () => {
  beforeEach(() => {
    delete process.env.DATABASE_URL;
    resetRuntimeStateForTests();
    process.env.OBJECT_STORAGE_ENDPOINT = "http://localhost:9000";
    process.env.OBJECT_STORAGE_ACCESS_KEY_ID = "test";
    process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY = "test";
    process.env.OBJECT_STORAGE_BUCKET = "test";
  });
  afterEach(() => {
    if (savedDbUrl) process.env.DATABASE_URL = savedDbUrl;
    delete process.env.OBJECT_STORAGE_ENDPOINT;
    delete process.env.OBJECT_STORAGE_ACCESS_KEY_ID;
    delete process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY;
    delete process.env.OBJECT_STORAGE_BUCKET;
  });

  it("returns 400 on invalid JSON body", async () => {
    const { resetS3ClientForTests } = await import("@/lib/storage");
    resetS3ClientForTests();

    const res = await POST(req("{not json"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/json/i);
  });

  it("returns 400 with a user-facing message on validation error (bad content type)", async () => {
    const { resetS3ClientForTests } = await import("@/lib/storage");
    resetS3ClientForTests();

    const res = await POST(req({
      storeId: "store_x", filename: "a.mp4", contentType: "text/html", sizeBytes: 100,
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/content type/i);
  });

  it("returns 503 with a generic message when presigning fails (no endpoint leak)", async () => {
    const storage = await import("@/lib/storage");
    storage.resetS3ClientForTests();

    // Valid payload so the request passes UploadValidationError and reaches the
    // presign call. Then simulate an AWS SDK error whose message embeds the
    // internal endpoint — §8 contract: log server-side, return a generic
    // message so host/region never reaches the client.
    vi.spyOn(storage, "createPresignedPutUrl").mockRejectedValue(
      new Error("Connection error: connect ECONNREFUSED internal-host:9000")
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(req({
      storeId: "store_x",
      filename: "clip.mp4",
      contentType: "video/mp4",
      sizeBytes: 1024,
    }));

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("Failed to create upload intent");
    // The internal endpoint must NOT leak to the client (CLAUDE.md §7/§8).
    expect(JSON.stringify(body)).not.toContain("internal-host");
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
