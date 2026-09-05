import { describe, expect, it, vi } from "vitest";

// 不触真 S3：presign 直接返回假 URL
vi.mock("@/lib/storage", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/storage")>();
  return { ...original, createPresignedPutUrl: vi.fn(async () => "https://signed.example/put") };
});

import { createUploadIntent, UploadValidationError } from "@/lib/services/assets";

describe("createUploadIntent avatar_footage size cap", () => {
  const base = { ownerId: "owner_1", storeId: "store_1", filename: "me.mp4", contentType: "video/mp4" };

  it("rejects avatar_footage over 30MiB with a user-facing message", async () => {
    await expect(
      createUploadIntent({ ...base, sizeBytes: 31 * 1024 * 1024, category: "avatar_footage" }),
    ).rejects.toThrow(UploadValidationError);
    await expect(
      createUploadIntent({ ...base, sizeBytes: 31 * 1024 * 1024, category: "avatar_footage" }),
    ).rejects.toThrow(/30MB/);
  });

  it("accepts avatar_footage at the cap", async () => {
    const intent = await createUploadIntent({ ...base, sizeBytes: 30 * 1024 * 1024, category: "avatar_footage" });
    expect(intent.category).toBe("avatar_footage");
  });

  it("does not apply the footage cap to material uploads (200MB 总上限不变)", async () => {
    const intent = await createUploadIntent({ ...base, sizeBytes: 150 * 1024 * 1024 });
    expect(intent.maxSizeBytes).toBeGreaterThan(30 * 1024 * 1024);
  });
});
