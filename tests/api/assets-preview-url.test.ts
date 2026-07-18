import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/assets/[id]/preview-url/route";
import { getAssetRepository } from "@/lib/repositories";
import { resetRuntimeStateForTests } from "@/lib/runtime-store";
import { createId, nowIso } from "@/lib/ids";
import type { Asset } from "@/lib/types";

// Keep tests on the in-memory repositories regardless of host DATABASE_URL.
const savedDbUrl = process.env.DATABASE_URL;

function createTestAsset(ownerId: string, overrides: Partial<Asset> = {}): Asset {
  return {
    id: createId("asset"),
    ownerId,
    storeId: "store_1",
    type: "video",
    originalFilename: "demo.mp4",
    storageKey: `stores/store_1/assets/${createId("asset")}-demo.mp4`,
    mimeType: "video/mp4",
    sizeBytes: 5000,
    tags: [],
    businessTags: [],
    status: "uploaded",
    createdAt: nowIso(),
    ...overrides
  };
}

function callRoute(id: string): Promise<Response> {
  const req = new Request(`http://localhost/api/assets/${id}/preview-url`);
  return GET(req, { params: Promise.resolve({ id }) });
}

describe("GET /api/assets/[id]/preview-url", () => {
  beforeEach(() => {
    delete process.env.DATABASE_URL;
    resetRuntimeStateForTests();
    // getSignedUrl signs locally without a network call; dummy creds are enough
    // to exercise the real storage path end-to-end in the route test.
    process.env.OBJECT_STORAGE_ENDPOINT = "http://127.0.0.1:9000";
    process.env.OBJECT_STORAGE_BUCKET = "ai-video-assistant";
    process.env.OBJECT_STORAGE_ACCESS_KEY_ID = "testkey";
    process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY = "testsecret";
    process.env.OBJECT_STORAGE_REGION = "us-east-1";
    // S3 client is module-cached; reset so it picks up the test env vars and so
    // createStorageLocation does not synthesize a public URL path.
    delete process.env.OBJECT_STORAGE_PUBLIC_URL;
  });

  afterEach(() => {
    if (savedDbUrl) process.env.DATABASE_URL = savedDbUrl;
  });

  it("returns a presigned url for the owner's asset", async () => {
    const { resetS3ClientForTests } = await import("@/lib/storage");
    resetS3ClientForTests();

    const asset = createTestAsset("demo_user");
    await getAssetRepository().create(asset);

    const res = await callRoute(asset.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.url).toBe("string");
    // Path-style presigned URL embeds the key — proves the route forwarded
    // the right storageKey, not some other key.
    expect(body.url).toContain(asset.storageKey);
    expect(body.mimeType).toBe("video/mp4");
    expect(body.type).toBe("video");
  });

  it("returns 404 when the asset does not exist", async () => {
    const { resetS3ClientForTests } = await import("@/lib/storage");
    resetS3ClientForTests();

    const res = await callRoute("asset_missing");
    expect(res.status).toBe(404);
  });

  it("returns 404 when the asset belongs to another owner (IDOR guard)", async () => {
    const { resetS3ClientForTests } = await import("@/lib/storage");
    resetS3ClientForTests();

    // Requester resolves to demo_user (demoOwnerId); asset is foreign.
    const asset = createTestAsset("other_user");
    await getAssetRepository().create(asset);

    const res = await callRoute(asset.id);
    expect(res.status).toBe(404);
  });

  it("returns 503 with a generic message when presigning fails", async () => {
    const { resetS3ClientForTests } = await import("@/lib/storage");
    resetS3ClientForTests();

    const asset = createTestAsset("demo_user");
    await getAssetRepository().create(asset);

    const storage = await import("@/lib/storage");
    vi.spyOn(storage, "createPresignedGetUrl").mockRejectedValue(new Error("Connection error: fetch failed to http://internal-host:9000"));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await callRoute(asset.id);

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("Failed to generate preview URL");
    // The internal endpoint must NOT leak to the client.
    expect(JSON.stringify(body)).not.toContain("internal-host");
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
