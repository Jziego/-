import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/assets/upload-intent/route";
import * as env from "@/lib/env";
import * as assetsService from "@/lib/services/assets";

describe("POST /api/assets/upload-intent", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 503 when object storage is not configured", async () => {
    vi.spyOn(env, "hasObjectStorage").mockReturnValue(false);

    const response = await POST(
      new Request("http://localhost/api/assets/upload-intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storeId: "store_1",
          filename: "demo.mp4",
          contentType: "video/mp4",
          sizeBytes: 1000
        })
      })
    );

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toContain("Object storage is not configured");
  });

  it("returns a presigned upload intent when storage is configured", async () => {
    vi.spyOn(env, "hasObjectStorage").mockReturnValue(true);
    vi.spyOn(assetsService, "createUploadIntent").mockResolvedValue({
      assetId: "asset_1",
      storageKey: "stores/store_1/assets/asset_1-demo.mp4",
      uploadUrl: "https://signed.example/upload",
      headers: { "Content-Type": "video/mp4" },
      maxSizeBytes: 200 * 1024 * 1024,
      expiresInSeconds: 900
    });

    const response = await POST(
      new Request("http://localhost/api/assets/upload-intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storeId: "store_1",
          filename: "demo.mp4",
          contentType: "video/mp4",
          sizeBytes: 1000
        })
      })
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.intent.uploadUrl).toBe("https://signed.example/upload");
    expect(body.intent.headers["Content-Type"]).toBe("video/mp4");
  });
});
