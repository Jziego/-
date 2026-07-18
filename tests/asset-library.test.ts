import { describe, expect, it } from "vitest";
import { MAX_ASSETS_PER_STORE, clampUploadBatch } from "@/lib/asset-library";

describe("clampUploadBatch", () => {
  it("accepts all files when under the cap", () => {
    expect(clampUploadBatch(3, 4)).toEqual({ accepted: 4, rejected: 0 });
  });

  it("accepts up to the cap and rejects the overflow", () => {
    expect(clampUploadBatch(10, 5, MAX_ASSETS_PER_STORE)).toEqual({ accepted: 2, rejected: 3 });
  });

  it("rejects everything when the library is already full", () => {
    expect(clampUploadBatch(MAX_ASSETS_PER_STORE, 3)).toEqual({ accepted: 0, rejected: 3 });
  });

  it("never returns a negative accepted count", () => {
    expect(clampUploadBatch(MAX_ASSETS_PER_STORE + 5, 2)).toEqual({ accepted: 0, rejected: 2 });
  });
});
