import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendMock, getSignedUrlMock, presignMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  getSignedUrlMock: vi.fn(),
  presignMock: vi.fn()
}));

vi.mock("@aws-sdk/client-s3", () => {
  class S3Client {
    send = sendMock;
    constructor() {}
  }

  class PutObjectCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }

  class GetObjectCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }

  class HeadObjectCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }

  class DeleteObjectCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }

  return { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand };
});

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: (...args: unknown[]) => getSignedUrlMock(...args),
  S3RequestPresigner: class {
    constructor(public config: unknown) {}
    presign(request: unknown, options: unknown) {
      return presignMock(request, options);
    }
  }
}));

describe("object storage helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OBJECT_STORAGE_ENDPOINT = "http://127.0.0.1:9000";
    process.env.OBJECT_STORAGE_BUCKET = "ai-video-assistant";
    process.env.OBJECT_STORAGE_ACCESS_KEY_ID = "minioadmin";
    process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY = "minioadmin";
    process.env.OBJECT_STORAGE_REGION = "us-east-1";
    process.env.OBJECT_STORAGE_PUBLIC_URL = "https://cdn.example.com";
    delete process.env.OBJECT_STORAGE_CDN_URL;
  });

  it("creates presigned PUT URLs with bucket, key and content type", async () => {
    getSignedUrlMock.mockResolvedValue("https://signed.example/upload");

    const { createPresignedPutUrl, resetS3ClientForTests } = await import("@/lib/storage");
    resetS3ClientForTests();

    const url = await createPresignedPutUrl("stores/store_1/assets/asset_1-demo.mp4", "video/mp4", 600);

    expect(url).toBe("https://signed.example/upload");
    expect(getSignedUrlMock).toHaveBeenCalledTimes(1);
    const [, command, options] = getSignedUrlMock.mock.calls[0] ?? [];
    expect(command).toMatchObject({
      input: {
        Bucket: "ai-video-assistant",
        Key: "stores/store_1/assets/asset_1-demo.mp4",
        ContentType: "video/mp4"
      }
    });
    expect(options).toEqual({ expiresIn: 600 });
  });

  it("parses HeadObject metadata when the object exists", async () => {
    sendMock.mockResolvedValue({
      ContentLength: 12345,
      ContentType: "video/mp4"
    });

    const { headObject, resetS3ClientForTests } = await import("@/lib/storage");
    resetS3ClientForTests();

    const result = await headObject("stores/store_1/assets/asset_1-demo.mp4");

    expect(result).toEqual({
      exists: true,
      contentLength: 12345,
      contentType: "video/mp4"
    });
  });

  it("returns exists=false when HeadObject reports 404", async () => {
    sendMock.mockRejectedValue({ name: "NotFound", $metadata: { httpStatusCode: 404 } });

    const { headObject, resetS3ClientForTests } = await import("@/lib/storage");
    resetS3ClientForTests();

    const result = await headObject("missing-key");

    expect(result).toEqual({ exists: false });
  });

  it("deleteObject swallows NotFound and does not rethrow", async () => {
    sendMock.mockRejectedValue({ name: "NotFound", $metadata: { httpStatusCode: 404 } });

    const { deleteObject, resetS3ClientForTests } = await import("@/lib/storage");
    resetS3ClientForTests();

    await expect(deleteObject("stores/store_1/assets/asset_1-demo.mp4")).resolves.toBeUndefined();
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("deleteObject sends a DeleteObjectCommand with bucket and key", async () => {
    sendMock.mockResolvedValue({});

    const { deleteObject, resetS3ClientForTests } = await import("@/lib/storage");
    resetS3ClientForTests();

    await deleteObject("stores/store_1/assets/asset_1-demo.mp4");

    expect(sendMock.mock.calls[0]?.[0]).toMatchObject({
      input: { Bucket: "ai-video-assistant", Key: "stores/store_1/assets/asset_1-demo.mp4" }
    });
  });

  it("deleteObject logs and swallows non-404 errors", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    sendMock.mockRejectedValue(new Error("ServiceUnavailable"));

    const { deleteObject, resetS3ClientForTests } = await import("@/lib/storage");
    resetS3ClientForTests();

    await expect(deleteObject("stores/store_1/assets/asset_1-demo.mp4")).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[storage] deleteObject failed"),
      expect.anything()
    );
    warnSpy.mockRestore();
  });

  it("OBJECT_STORAGE_CDN_URL 设置时：GET 预签名指向 CDN 域名、路径不含 bucket", async () => {
    process.env.OBJECT_STORAGE_CDN_URL = "https://cdn.example.com";
    presignMock.mockResolvedValue({
      path: "/voices/a.mp3",
      query: { "X-Amz-Signature": "sig123", "X-Amz-Credential": "AKID/20260101/auto/s3/aws4_request" }
    });
    const { createPresignedGetUrl } = await import("@/lib/storage");
    const url = await createPresignedGetUrl("voices/a.mp3", 900);
    expect(url.startsWith("https://cdn.example.com/voices/a.mp3?")).toBe(true);
    expect(url).toContain("X-Amz-Signature=sig123");
    expect(url).toContain(encodeURIComponent("AKID/20260101/auto/s3/aws4_request"));
    // 必须按 CDN 主机名签名（R2 自定义域名要求签名与访问域名一致），且不带 bucket 前缀
    expect(presignMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        hostname: "cdn.example.com",
        path: "/voices/a.mp3",
        headers: expect.objectContaining({ host: "cdn.example.com" })
      }),
      { expiresIn: 900 }
    );
    expect(getSignedUrlMock).not.toHaveBeenCalled();
  });

  it("未设置 OBJECT_STORAGE_CDN_URL 时：GET 预签名保持源站 getSignedUrl 路径", async () => {
    getSignedUrlMock.mockResolvedValue("https://signed.example/get");
    const { createPresignedGetUrl } = await import("@/lib/storage");
    const url = await createPresignedGetUrl("voices/b.mp3", 300);
    expect(url).toBe("https://signed.example/get");
    expect(presignMock).not.toHaveBeenCalled();
  });

  it("builds public URLs from OBJECT_STORAGE_PUBLIC_URL when set", async () => {
    const { createStorageLocation } = await import("@/lib/storage");

    expect(createStorageLocation("stores/store_1/assets/demo.mp4")).toEqual({
      bucket: "ai-video-assistant",
      key: "stores/store_1/assets/demo.mp4",
      publicUrl: "https://cdn.example.com/stores/store_1/assets/demo.mp4"
    });
  });
});
