# 素材库多素材上传 + 成片全量使用 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让素材库支持上传多个素材、勾选子集、删除、缩略图预览，并在一键成片时把所有勾选素材（及其 AI 分析）都传给脚本生成与渲染管线。

**Architecture:** 后端（schema→ffmpeg）已原生支持多素材，瓶颈在前端单值状态。本计划做最小后端增量（`deleteObject`、`deleteById`、两个新路由）+ 前端从单值状态重构为"集合 + 选择子集"。素材库为 store 维度的池；成片时 `selectedAssetIds` = 勾选集，`assetAnalysisIds` = 勾选集对应的全部 analysis（关键正确性修复）。

**Tech Stack:** Next.js 16 App Router, React 19, TanStack Query, Vitest + Testing Library, Prisma 7, AWS SDK v3 (S3)。

**Spec:** `docs/superpowers/specs/2026-07-18-multi-asset-upload-design.md`

**关键约束（不可违反）**
- 顺序上传，禁止并行（保护写限流 20/min）。
- preview-url 的 react-query 严禁轮询 / window-focus refetch / retry（避免 429 死亡螺旋）。
- 新路由一律 `getOwnerId()` 注入 owner + IDOR 校验（外 owner 返 404 不泄漏存在）。
- `deleteById` 在 prisma 必须事务内先删 `assetAnalysis` 再删 `asset`（FK 无级联）。

---

## File Structure

**新建**
- `app/api/assets/[id]/route.ts` — `DELETE /api/assets/[id]`（IDOR + best-effort S3 删除）
- `app/api/assets/[id]/preview-url/route.ts` — `GET` 返回短期 presigned GET URL
- `tests/api/assets-delete.test.ts` — DELETE 路由测试
- `tests/api/assets-preview-url.test.ts` — preview-url 路由测试
- `tests/repositories/asset.test.ts` — `deleteById` memory 实现测试
- `lib/asset-library.ts` — `MAX_ASSETS_PER_STORE` 常量 + `clampUploadBatch` 纯函数
- `tests/asset-library.test.ts` — clamp 纯函数测试

**修改**
- `lib/storage.ts` — 新增 `deleteObject`
- `tests/storage.test.ts` — mock 增加 `DeleteObjectCommand` + `deleteObject` 测试
- `lib/repositories/types.ts` — `AssetRepository` 加 `deleteById`
- `lib/repositories/memory.ts` — `MemoryAssetRepository.deleteById`
- `lib/repositories/prisma.ts` — `PrismaAssetRepository.deleteById`（事务）
- `lib/api-client.ts` — `deleteAsset`、`fetchAssetPreviewUrl`
- `components/dashboard.tsx` — 状态重构、多文件顺序上传、网格 UI、勾选、删除、缩略图、成片接线

---

## Task 1: `deleteObject` in `lib/storage.ts`

**Files:**
- Modify: `lib/storage.ts:1` (import), append new export
- Test: `tests/storage.test.ts` (extend mock + add test)

- [ ] **Step 1: Extend the S3 mock and add the failing test**

In `tests/storage.test.ts`, the `vi.mock("@aws-sdk/client-s3", ...)` factory (lines 8-29) currently returns `{ S3Client, PutObjectCommand, HeadObjectCommand }`. Add a `DeleteObjectCommand` class alongside `HeadObjectCommand`:

```ts
  class DeleteObjectCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
```

and change the return to:

```ts
  return { S3Client, PutObjectCommand, HeadObjectCommand, DeleteObjectCommand };
```

Then add this test inside the `describe("object storage helpers", ...)` block (after the "returns exists=false" test):

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/storage.test.ts`
Expected: FAIL — `deleteObject is not a function` (not yet exported).

- [ ] **Step 3: Implement `deleteObject`**

In `lib/storage.ts`, add `DeleteObjectCommand` to the import on line 1:

```ts
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
```

Append after `headObject` (after line 162):

```ts
/**
 * Best-effort object deletion. Swallows "not found" so DB-record deletion is
 * never blocked by a missing/stale S3 object — the DB row is the source of
 * truth. Other errors are logged but not rethrown (the caller has already
 * committed the DB delete by the time this runs).
 */
export async function deleteObject(key: string): Promise<void> {
  try {
    await getS3Client().send(
      new DeleteObjectCommand({ Bucket: getObjectStorageBucket(), Key: key })
    );
  } catch (error) {
    const statusCode =
      typeof error === "object" && error !== null && "$metadata" in error
        ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
        : undefined;
    const name = typeof error === "object" && error !== null && "name" in error ? String(error.name) : "";

    if (statusCode === 404 || name === "NotFound" || name === "NoSuchKey") return;

    console.warn(`[storage] deleteObject failed for ${key}:`, name || error);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/storage.test.ts`
Expected: PASS (all storage tests green).

- [ ] **Step 5: Commit**

```bash
git add lib/storage.ts tests/storage.test.ts
git commit -m "feat(storage): add best-effort deleteObject for asset cleanup

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: `deleteById` in `AssetRepository`

**Files:**
- Modify: `lib/repositories/types.ts:19-23` (interface)
- Modify: `lib/repositories/memory.ts:45-58` (memory impl)
- Modify: `lib/repositories/prisma.ts:85-102` (prisma impl, transactional)
- Test: `tests/repositories/asset.test.ts` (new — memory impl, mirrors `store.test.ts`)

- [ ] **Step 1: Write the failing test**

Create `tests/repositories/asset.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryAssetAnalysisRepository, MemoryAssetRepository } from "@/lib/repositories/memory";
import { resetRuntimeStateForTests } from "@/lib/runtime-store";
import type { Asset, AssetAnalysis } from "@/lib/types";

function sampleAsset(id: string, ownerId = "demo_user"): Asset {
  return {
    id,
    ownerId,
    storeId: "store_1",
    type: "video",
    originalFilename: `${id}.mp4`,
    storageKey: `stores/store_1/assets/${id}-demo.mp4`,
    mimeType: "video/mp4",
    sizeBytes: 5000,
    tags: [],
    businessTags: [],
    status: "uploaded",
    createdAt: new Date().toISOString()
  };
}

function sampleAnalysis(assetId: string): AssetAnalysis {
  return {
    id: `analysis_${assetId}`,
    assetId,
    visualTags: ["food"],
    businessTags: ["新品推荐"],
    keywords: ["面"],
    confidence: 0.8,
    recommendedUses: ["new_product"],
    createdAt: new Date().toISOString()
  };
}

describe("MemoryAssetRepository.deleteById", () => {
  beforeEach(() => {
    resetRuntimeStateForTests();
  });

  it("removes the asset and returns true when it existed", async () => {
    const repo = new MemoryAssetRepository();
    await repo.create(sampleAsset("asset_a"));

    const removed = await repo.deleteById("asset_a");

    expect(removed).toBe(true);
    expect(await repo.findById("asset_a")).toBeNull();
  });

  it("returns false and is a no-op when the asset is missing", async () => {
    const repo = new MemoryAssetRepository();

    const removed = await repo.deleteById("asset_missing");

    expect(removed).toBe(false);
  });

  it("also removes the asset's analysis (cascade cleanup)", async () => {
    const assetRepo = new MemoryAssetRepository();
    const analysisRepo = new MemoryAssetAnalysisRepository();
    await assetRepo.create(sampleAsset("asset_b"));
    await analysisRepo.create(sampleAnalysis("asset_b"));

    await assetRepo.deleteById("asset_b");

    expect(await analysisRepo.findByAssetId("asset_b")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/repositories/asset.test.ts`
Expected: FAIL — `repo.deleteById is not a function`.

- [ ] **Step 3: Add `deleteById` to the interface**

In `lib/repositories/types.ts`, replace the `AssetRepository` block (lines 19-23):

```ts
export interface AssetRepository {
  listByOwner(ownerId: string): Promise<Asset[]>;
  create(asset: Asset): Promise<Asset>;
  findById(id: string): Promise<Asset | null>;
  /** Delete an asset by id. Returns true iff a row was actually removed. */
  deleteById(id: string): Promise<boolean>;
}
```

- [ ] **Step 4: Implement memory `deleteById`**

In `lib/repositories/memory.ts`, add to `MemoryAssetRepository` (after `findById`, before the closing brace at line 58):

```ts
  async deleteById(id: string): Promise<boolean> {
    const state = getRuntimeState();
    const before = state.assets.length;
    state.assets = state.assets.filter((asset) => asset.id !== id);
    state.analyses = state.analyses.filter((analysis) => analysis.assetId !== id);
    return state.assets.length < before;
  }
```

- [ ] **Step 5: Implement prisma `deleteById` (transactional)**

In `lib/repositories/prisma.ts`, add to `PrismaAssetRepository` (after `findById`, before the closing brace at line 102):

```ts
  async deleteById(id: string): Promise<boolean> {
    const result = await this.prisma.$transaction([
      // FK has no onDelete cascade; child analysis must go first or the asset
      // delete violates the references constraint.
      this.prisma.assetAnalysis.deleteMany({ where: { assetId: id } }),
      this.prisma.asset.deleteMany({ where: { id } })
    ]);
    const assetDelete = result[1];
    return (assetDelete?.count ?? 0) > 0;
  }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/repositories/asset.test.ts && npm run typecheck`
Expected: PASS (memory test green; typecheck confirms prisma impl satisfies the interface).

- [ ] **Step 7: Commit**

```bash
git add lib/repositories/types.ts lib/repositories/memory.ts lib/repositories/prisma.ts tests/repositories/asset.test.ts
git commit -m "feat(repositories): add deleteById to AssetRepository (memory + prisma)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: `DELETE /api/assets/[id]` route

**Files:**
- Create: `app/api/assets/[id]/route.ts`
- Test: `tests/api/assets-delete.test.ts` (new — mirrors `assets-confirm.test.ts`)

- [ ] **Step 1: Write the failing test**

Create `tests/api/assets-delete.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE } from "@/app/api/assets/[id]/route";
import * as repositories from "@/lib/repositories";
import { MemoryAssetRepository } from "@/lib/repositories/memory";
import { resetRuntimeStateForTests } from "@/lib/runtime-store";
import * as storage from "@/lib/storage";
import type { Asset } from "@/lib/types";

function sampleAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: "asset_1",
    ownerId: "demo_user",
    storeId: "store_1",
    type: "video",
    originalFilename: "demo.mp4",
    storageKey: "stores/store_1/assets/asset_1-demo.mp4",
    mimeType: "video/mp4",
    sizeBytes: 5000,
    tags: [],
    businessTags: [],
    status: "uploaded",
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

function callDelete(id: string): Promise<Response> {
  const req = new Request(`http://localhost/api/assets/${id}`, { method: "DELETE" });
  return DELETE(req, { params: Promise.resolve({ id }) });
}

describe("DELETE /api/assets/[id]", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetRuntimeStateForTests();
    vi.spyOn(repositories, "getAssetRepository").mockImplementation(() => new MemoryAssetRepository());
    vi.spyOn(storage, "deleteObject").mockResolvedValue(undefined);
  });

  it("returns 404 when the asset does not exist", async () => {
    const res = await callDelete("asset_missing");
    expect(res.status).toBe(404);
  });

  it("returns 404 when the asset belongs to another owner (IDOR guard)", async () => {
    const repo = new MemoryAssetRepository();
    await repo.create(sampleAsset({ id: "asset_foreign", ownerId: "other_user" }));

    const res = await callDelete("asset_foreign");
    expect(res.status).toBe(404);
    expect(await repo.findById("asset_foreign")).not.toBeNull();
  });

  it("deletes the owner's asset and best-effort cleans storage", async () => {
    const repo = new MemoryAssetRepository();
    await repo.create(sampleAsset({ id: "asset_mine" }));

    const res = await callDelete("asset_mine");

    expect(res.status).toBe(200);
    expect(await repo.findById("asset_mine")).toBeNull();
    expect(storage.deleteObject).toHaveBeenCalledWith("stores/store_1/assets/asset_1-demo.mp4");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/api/assets-delete.test.ts`
Expected: FAIL — cannot resolve `@/app/api/assets/[id]/route` (route does not exist).

- [ ] **Step 3: Implement the route**

Create `app/api/assets/[id]/route.ts`:

```ts
import { jsonError, jsonOk } from "@/lib/api-response";
import { applyRateLimit } from "@/lib/rate-limit";
import { getOwnerId } from "@/lib/auth-helpers";
import { getAssetRepository } from "@/lib/repositories";
import { deleteObject } from "@/lib/storage";

/**
 * Hard-delete an asset (DB row + best-effort S3 object). IDOR: a missing or
 * foreign asset both resolve to 404 so existence is not leaked. Storage
 * cleanup is best-effort — a missing object must not block the DB delete.
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await context.params;
  const ownerId = await getOwnerId();

  const limited = await applyRateLimit(request, ownerId);
  if (limited) return limited;

  const asset = await getAssetRepository().findById(id);
  if (!asset || asset.ownerId !== ownerId) {
    return jsonError("Asset not found", 404);
  }

  await getAssetRepository().deleteById(id);
  await deleteObject(asset.storageKey);

  return jsonOk({ id });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/api/assets-delete.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/api/assets/[id]/route.ts tests/api/assets-delete.test.ts
git commit -m "feat(api): add DELETE /api/assets/[id] with IDOR guard

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: `GET /api/assets/[id]/preview-url` route

**Files:**
- Create: `app/api/assets/[id]/preview-url/route.ts`
- Test: `tests/api/assets-preview-url.test.ts` (new — mirrors `render-projects-outputs-url.test.ts`)

- [ ] **Step 1: Write the failing test**

Create `tests/api/assets-preview-url.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET } from "@/app/api/assets/[id]/preview-url/route";
import { getAssetRepository } from "@/lib/repositories";
import { resetRuntimeStateForTests } from "@/lib/runtime-store";
import { createId, nowIso } from "@/lib/ids";
import type { Asset } from "@/lib/types";

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
    process.env.OBJECT_STORAGE_ENDPOINT = "http://127.0.0.1:9000";
    process.env.OBJECT_STORAGE_BUCKET = "ai-video-assistant";
    process.env.OBJECT_STORAGE_ACCESS_KEY_ID = "testkey";
    process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY = "testsecret";
    process.env.OBJECT_STORAGE_REGION = "us-east-1";
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

    const asset = createTestAsset("other_user");
    await getAssetRepository().create(asset);

    const res = await callRoute(asset.id);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/api/assets-preview-url.test.ts`
Expected: FAIL — cannot resolve the route module.

- [ ] **Step 3: Implement the route**

Create `app/api/assets/[id]/preview-url/route.ts`:

```ts
import { jsonError, jsonOk } from "@/lib/api-response";
import { applyRateLimit } from "@/lib/rate-limit";
import { getOwnerId } from "@/lib/auth-helpers";
import { getAssetRepository } from "@/lib/repositories";
import { createPresignedGetUrl } from "@/lib/storage";

/**
 * Short-lived presigned GET URL so the dashboard can render an asset
 * thumbnail (video first frame / image) without exposing the bucket
 * publicly. IDOR: missing or foreign assets both resolve to 404.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await context.params;
  const ownerId = await getOwnerId();

  const limited = await applyRateLimit(request, ownerId);
  if (limited) return limited;

  const asset = await getAssetRepository().findById(id);
  if (!asset || asset.ownerId !== ownerId) {
    return jsonError("Asset not found", 404);
  }

  try {
    const url = await createPresignedGetUrl(asset.storageKey, 300);
    return jsonOk({ url, mimeType: asset.mimeType, type: asset.type });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to generate URL";
    return jsonError(message, 503);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/api/assets-preview-url.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/api/assets/[id]/preview-url/route.ts tests/api/assets-preview-url.test.ts
git commit -m "feat(api): add GET /api/assets/[id]/preview-url (short-lived presigned)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: Multi-asset collection state + sequential upload loop

This task refactors the dashboard from single-value asset state to collections, adds sequential multi-file upload, and keeps the existing single-item render (the grid comes in Task 6). The existing single-file upload test must still pass.

**Files:**
- Modify: `components/dashboard.tsx` (state lines 254-255, derived 326-329, `handleAssetUpload` 526-591, `handleFileInputChange` 593-599, progress bar JSX ~905-916)

- [ ] **Step 1: Write the failing test**

Append to `tests/dashboard.test.tsx` (inside the `describe("AI video assistant dashboard", ...)` block):

```ts
  it("uploads multiple files sequentially and confirms each", async () => {
    const user = userEvent.setup();
    const uploadSpy = vi.fn();
    const savedStore = {
      id: "store_multi",
      ownerId: "demo_user",
      name: "多素材店",
      industry: "餐饮",
      location: "上海",
      mainProducts: ["牛肉面"],
      targetCustomers: ["上班族"],
      sellingPoints: ["现熬牛骨汤"],
      promotions: [],
      brandTone: "亲切接地气",
      forbiddenWords: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };

    let intentCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";

        if (url === "/api/store-profiles" && method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}"));
          return { ok: true, json: async () => ({ store: { ...savedStore, ...body, id: savedStore.id } }) };
        }

        if (url === "/api/assets/upload-intent" && method === "POST") {
          intentCount += 1;
          return {
            ok: true,
            json: async () => ({
              intent: {
                assetId: `asset_${intentCount}`,
                storageKey: `stores/store_multi/assets/asset_${intentCount}-demo.mp4`,
                uploadUrl: "https://storage.example/upload",
                headers: { "Content-Type": "video/mp4" },
                maxSizeBytes: 200 * 1024 * 1024,
                expiresInSeconds: 900
              }
            })
          };
        }

        if (url === "/api/assets/confirm" && method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}"));
          return {
            ok: true,
            json: async () => ({
              asset: {
                id: body.assetId,
                ownerId: savedStore.ownerId,
                storeId: savedStore.id,
                type: "video",
                originalFilename: body.originalFilename,
                storageKey: body.storageKey,
                mimeType: body.mimeType,
                sizeBytes: body.sizeBytes ?? 1000,
                tags: [],
                businessTags: [],
                status: "uploaded",
                createdAt: new Date().toISOString()
              }
            })
          };
        }

        if (url === "/api/assets/analyze" && method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}"));
          return {
            ok: true,
            json: async () => ({
              analysis: {
                id: `analysis_${body.assetId}`,
                assetId: body.assetId,
                visualTags: ["food"],
                businessTags: ["新品推荐"],
                keywords: ["牛肉面"],
                confidence: 0.8,
                recommendedUses: ["new_product"],
                createdAt: new Date().toISOString()
              }
            })
          };
        }

        return {
          ok: true,
          json: async () => {
            if (url === "/api/store-profiles") return { stores: [savedStore] };
            if (url === "/api/assets") return { assets: [] };
            if (url === "/api/asset-analyses") return { analyses: [] };
            if (url === "/api/avatars") return { avatars: [] };
            if (url === "/api/jobs") return { jobs: [] };
            if (url === "/api/script-drafts") return { scripts: [] };
            return {};
          }
        };
      })
    );

    vi.spyOn(apiClient, "uploadFileToStorage").mockImplementation(async () => {
      uploadSpy();
    });

    renderDashboard();

    // Complete the store profile so upload unlocks.
    await user.click(screen.getByRole("button", { name: "保存并继续" }));
    await user.click(screen.getByRole("button", { name: "保存并继续" }));
    await user.click(screen.getByRole("button", { name: "完成设置" }));

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(fileInput, [
      new File(["video"], "one.mp4", { type: "video/mp4" }),
      new File(["video"], "two.mp4", { type: "video/mp4" })
    ]);

    expect(uploadSpy).toHaveBeenCalledTimes(2);
    expect(
      await within(screen.getByRole("status")).findByText(/已上传 2 个素材/)
    ).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/dashboard.test.tsx -t "uploads multiple files sequentially"`
Expected: FAIL — only one file is uploaded (current code reads `files[0]`), so `uploadSpy` called once and the "2 个素材" message never appears.

- [ ] **Step 3: Refactor state to collections**

In `components/dashboard.tsx`, replace lines 254-255:

```ts
  const [localAsset, setLocalAsset] = useState<Asset | null>(null);
  const [localAnalysis, setLocalAnalysis] = useState<AssetAnalysis | null>(null);
```

with:

```ts
  const [localAssets, setLocalAssets] = useState<Asset[]>([]);
  const [localAnalyses, setLocalAnalyses] = useState<AssetAnalysis[]>([]);
  const [selectedAssetIds, setSelectedAssetIds] = useState<Set<string>>(new Set());
  const [uploadingFiles, setUploadingFiles] = useState<
    { id: string; name: string; progress: number; status: "uploading" | "failed" }[]
  >([]);
  const seededSelectionRef = useRef(false);
```

(`Set` and `Asset`/`AssetAnalysis` are already imported via line 36; `useRef` via line 4.)

- [ ] **Step 4: Replace the derived singletons (lines 326-329)**

Replace:

```ts
  const asset =
    localAsset ?? (store ? (serverAssets.find((item) => item.storeId === store.id) ?? null) : null);
  const analysis =
    localAnalysis ?? (asset ? (serverAnalyses.find((item) => item.assetId === asset.id) ?? null) : null);
```

with:

```ts
  // Asset library is a per-store pool (DB-persisted + this session's uploads,
  // deduped by id). Selection is a subset the user ticks for rendering.
  const assets = useMemo(() => {
    const seen = new Set<string>();
    const merged: Asset[] = [];
    const storeAssets = store ? serverAssets.filter((item) => item.storeId === store.id) : [];
    for (const asset of [...localAssets, ...storeAssets]) {
      if (seen.has(asset.id)) continue;
      seen.add(asset.id);
      merged.push(asset);
    }
    return merged;
  }, [localAssets, serverAssets, store]);

  const analysesByAssetId = useMemo(() => {
    const map = new Map<string, AssetAnalysis>();
    for (const analysis of [...serverAnalyses, ...localAnalyses]) {
      map.set(analysis.assetId, analysis);
    }
    return map;
  }, [serverAnalyses, localAnalyses]);

  const selectedAssets = useMemo(
    () => assets.filter((a) => selectedAssetIds.has(a.id)),
    [assets, selectedAssetIds]
  );
  const selectedAnalyses = useMemo(
    () => selectedAssets.map((a) => analysesByAssetId.get(a.id)).filter((a): a is AssetAnalysis => Boolean(a)),
    [selectedAssets, analysesByAssetId]
  );

  // Default-select every asset on first load; after that selection is driven
  // only by user toggle / upload / delete.
  useEffect(() => {
    if (seededSelectionRef.current || assets.length === 0) return;
    seededSelectionRef.current = true;
    setSelectedAssetIds(new Set(assets.map((a) => a.id)));
  }, [assets]);

  // Singletons retained so existing avatar/script/preview code keeps compiling
  // until Tasks 6 & 9 rewire them to the full selection.
  const asset = selectedAssets[0] ?? null;
  const analysis = asset ? (analysesByAssetId.get(asset.id) ?? null) : null;
```

- [ ] **Step 5: Replace `handleAssetUpload` + `handleFileInputChange` (lines 526-599)**

Replace the entire `handleAssetUpload` function (526-591) and `handleFileInputChange` (593-599) with:

```ts
  function inferAssetType(mimeType: string): "video" | "image" | "audio" {
    if (mimeType.startsWith("video/")) return "video";
    if (mimeType.startsWith("image/")) return "image";
    return "audio";
  }

  function openFilePicker() {
    fileInputRef.current?.click();
  }

  async function handleAssetUploads(files: File[]) {
    if (!store) {
      setMessage("请先完成门店档案。");
      return;
    }

    const validFiles = files.filter(
      (file) =>
        (file.type.startsWith("video/") || file.type.startsWith("image/") || file.type.startsWith("audio/")) &&
        file.size <= MAX_UPLOAD_BYTES
    );

    if (validFiles.length === 0) {
      setMessage("仅支持上传视频、图片或音频文件（单个不超过 200MB）。");
      return;
    }

    setPendingAction("upload");

    let successCount = 0;
    let failCount = 0;

    for (const file of validFiles) {
      const uploadId = createId("upl");
      setUploadingFiles((prev) => [...prev, { id: uploadId, name: file.name, progress: 0, status: "uploading" }]);
      try {
        const intent = await createUploadIntentApi({
          ownerId: store.ownerId,
          storeId: store.id,
          filename: file.name,
          contentType: file.type,
          sizeBytes: file.size
        });

        await uploadFileToStorage(intent.uploadUrl, file, intent.headers, (ratio) => {
          setUploadingFiles((prev) =>
            prev.map((f) => (f.id === uploadId ? { ...f, progress: Math.round(ratio * 100) } : f))
          );
        });

        const uploadedAsset = await confirmAssetUpload({
          assetId: intent.assetId,
          storeId: store.id,
          ownerId: store.ownerId,
          storageKey: intent.storageKey,
          originalFilename: file.name,
          mimeType: file.type,
          type: inferAssetType(file.type),
          sizeBytes: file.size
        });

        const analyzed = await analyzeAssetApi({
          assetId: uploadedAsset.id,
          storeId: store.id,
          visualLabels: ["food", "person", "storefront"],
          transcript: `${store.mainProducts[0]}刚出锅，午餐出餐很快`
        });

        setLocalAssets((prev) => (prev.some((a) => a.id === uploadedAsset.id) ? prev : [...prev, uploadedAsset]));
        setLocalAnalyses((prev) => [...prev, analyzed]);
        setSelectedAssetIds((prev) => new Set(prev).add(uploadedAsset.id));
        successCount += 1;
      } catch {
        failCount += 1;
        setUploadingFiles((prev) => prev.map((f) => (f.id === uploadId ? { ...f, status: "failed" } : f)));
      } finally {
        setUploadingFiles((prev) => prev.filter((f) => f.id !== uploadId));
      }
    }

    await queryClient.invalidateQueries({ queryKey: ["assets"] });
    await queryClient.invalidateQueries({ queryKey: ["asset-analyses"] });
    setPendingAction(null);

    if (failCount === 0) {
      setMessage(
        successCount > 1
          ? `上传完成：已上传 ${successCount} 个素材。`
          : "上传完成：AI 已自动识别画面和语音内容。"
      );
    } else {
      setMessage(`上传完成：成功 ${successCount} 个，失败 ${failCount} 个，可重试失败的文件。`);
    }
  }

  function handleFileInputChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length > 0) {
      void handleAssetUploads(files);
    }
  }
```

- [ ] **Step 6: Drive the progress bar from per-file state**

Remove the now-unused `uploadProgress` state (line 266: `const [uploadProgress, setUploadProgress] = useState(0);`). Add an aggregate next to the other derived values (e.g. right after `selectedAnalyses`):

```ts
  const overallUploadProgress =
    uploadingFiles.length > 0
      ? Math.round(uploadingFiles.reduce((sum, f) => sum + f.progress, 0) / uploadingFiles.length)
      : 0;
```

In the uploadZone JSX (around line 914), replace `aria-valuenow={uploadProgress}` and `style={{ width: \`${Math.max(uploadProgress, 8)}%\` }}` with:

```tsx
                aria-valuenow={overallUploadProgress}
```
and
```tsx
                <span style={{ width: `${Math.max(overallUploadProgress, 8)}%` }} />
```

(The surrounding `{pendingAction === "upload" ? (...) : null}` wrapper stays unchanged.)

- [ ] **Step 7: Run the full dashboard test suite to verify pass + no regression**

Run: `npx vitest run tests/dashboard.test.tsx`
Expected: PASS — both the new multi-file test and the existing single-file upload test pass (single file yields `successCount === 1` → the original "AI 已自动识别画面和语音内容。" message).

- [ ] **Step 8: Commit**

```bash
git add components/dashboard.tsx tests/dashboard.test.tsx
git commit -m "feat(dashboard): multi-asset collection state + sequential upload

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: Asset grid UI + selection toggle + render gate

Replace the single `.mediaItem` render with a grid of selectable cards, add a "已选 N / 共 M" summary, and rewire the workflow step / status badge / render gate to the collection.

**Files:**
- Modify: `components/dashboard.tsx` (uploadZone JSX 867-940, status badge 856, workflow 432, currentStepIndex 422-427, renderMissingAssets 441, generate button 1021-1029)

- [ ] **Step 1: Write the failing tests**

Append to `tests/dashboard.test.tsx`:

```ts
  it("renders the asset library as a selectable grid and defaults to all selected", async () => {
    const savedStore = {
      id: "store_grid",
      ownerId: "demo_user",
      name: "网格店",
      industry: "餐饮",
      location: "上海",
      mainProducts: ["牛肉面"],
      targetCustomers: ["上班族"],
      sellingPoints: ["现熬牛骨汤"],
      promotions: [],
      brandTone: "亲切接地气",
      forbiddenWords: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    const savedAssets = [
      { id: "asset_a", ownerId: "demo_user", storeId: "store_grid", type: "video", originalFilename: "a.mp4", storageKey: "k1", mimeType: "video/mp4", sizeBytes: 1000, tags: [], businessTags: [], status: "uploaded", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "asset_b", ownerId: "demo_user", storeId: "store_grid", type: "image", originalFilename: "b.jpg", storageKey: "k2", mimeType: "image/jpeg", sizeBytes: 2000, tags: [], businessTags: [], status: "uploaded", createdAt: "2026-01-01T00:00:00.000Z" }
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        json: async () => {
          if (url === "/api/store-profiles") return { stores: [savedStore] };
          if (url === "/api/assets") return { assets: savedAssets };
          if (url === "/api/asset-analyses") return { analyses: [] };
          if (url === "/api/avatars") return { avatars: [] };
          if (url === "/api/jobs") return { jobs: [] };
          if (url === "/api/script-drafts") return { scripts: [] };
          return {};
        }
      }))
    );

    renderDashboard();

    expect(await screen.findByText("已选 2 / 共 2")).toBeInTheDocument();
    expect(screen.getByLabelText("选择素材 a.mp4")).toBeChecked();
    expect(screen.getByLabelText("选择素材 b.jpg")).toBeChecked();
  });

  it("disables generation when no asset is selected", async () => {
    const user = userEvent.setup();
    const savedStore = {
      id: "store_gate",
      ownerId: "demo_user",
      name: "门禁店",
      industry: "餐饮",
      location: "上海",
      mainProducts: ["牛肉面"],
      targetCustomers: ["上班族"],
      sellingPoints: ["现熬牛骨汤"],
      promotions: [],
      brandTone: "亲切接地气",
      forbiddenWords: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    const savedAssets = [
      { id: "asset_only", ownerId: "demo_user", storeId: "store_gate", type: "video", originalFilename: "only.mp4", storageKey: "k1", mimeType: "video/mp4", sizeBytes: 1000, tags: [], businessTags: [], status: "uploaded", createdAt: "2026-01-01T00:00:00.000Z" }
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        json: async () => {
          if (url === "/api/store-profiles") return { stores: [savedStore] };
          if (url === "/api/assets") return { assets: savedAssets };
          if (url === "/api/asset-analyses") return { analyses: [] };
          if (url === "/api/avatars") return { avatars: [] };
          if (url === "/api/jobs") return { jobs: [] };
          if (url === "/api/script-drafts") return { scripts: [] };
          return {};
        }
      }))
    );

    renderDashboard();

    await screen.findByText("已选 1 / 共 1");
    await user.click(screen.getByLabelText("选择素材 only.mp4"));

    expect(screen.getByText("已选 0 / 共 1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "请至少勾选一个素材" })).toBeDisabled();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/dashboard.test.tsx -t "selectable grid"`
Expected: FAIL — no "已选 N / 共 M" text, no per-asset checkbox labels.

- [ ] **Step 3: Rewire status badge, workflow step, currentStepIndex, render gate**

In `components/dashboard.tsx`:

- `currentStepIndex` (lines 422-427) — replace `if (!asset || !analysis) return 1;` with `if (assets.length === 0) return 1;` and update the dependency array to `[assets, avatar, store]`:
```ts
  const currentStepIndex = useMemo(() => {
    if (!store) return 0;
    if (assets.length === 0) return 1;
    if (!avatar) return 2;
    return 3;
  }, [assets, avatar, store]);
```

- `workflowSteps` (line 432) — change the 素材库 `complete` to `assets.length > 0`:
```ts
      { label: "素材库", href: "#media-upload", complete: assets.length > 0 },
```
and update that memo's dependency array to `[assets, avatar, script, store]`.

- `renderMissingAssets` (line 441) — change to:
```ts
  const renderMissingAssets = store && selectedAssets.length === 0;
```

- Status badge inside the media-upload card (line 856) — change `{analysis ? "statusBadge success" : "statusBadge warning"}` and its label to:
```tsx
            <span className={assets.length > 0 ? "statusBadge success" : "statusBadge warning"}>
              {assets.length > 0 ? "已完成" : "待完成"}
            </span>
```

- [ ] **Step 4: Replace the uploadZone inner content (lines 883-904) with a grid**

Add a `toggleAssetSelected` helper near `openFilePicker`:

```ts
  function toggleAssetSelected(id: string) {
    setSelectedAssetIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }
```

Replace the `{asset ? (<div className="mediaItem">...</div>) : (<div className="emptyState">...</div>)}` block (lines 883-904) with:

```tsx
            {assets.length > 0 ? (
              <div className="mediaGrid" role="list">
                {assets.map((item) => {
                  const selected = selectedAssetIds.has(item.id);
                  return (
                    <div className={`mediaItem ${selected ? "selected" : ""}`} key={item.id} role="listitem">
                      <label className="mediaSelect">
                        <input
                          aria-label={`选择素材 ${item.originalFilename}`}
                          checked={selected}
                          onChange={() => toggleAssetSelected(item.id)}
                          type="checkbox"
                        />
                        <span className="thumbnail" aria-hidden="true" />
                      </label>
                      <div className="mediaMeta">
                        <strong>{item.originalFilename}</strong>
                        <span>
                          {item.type} · {Math.max(1, Math.round(item.sizeBytes / 1024))}KB
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="emptyState">
                <svg aria-hidden="true" viewBox="0 0 120 90">
                  <rect height="62" rx="14" width="86" x="17" y="18" />
                  <path d="M44 54l13-13 12 12 8-8 15 18H30z" />
                  <circle cx="78" cy="34" r="6" />
                </svg>
                <strong>拖拽或点击上传视频/图片</strong>
                <span>可一次选择多个文件，上传后 AI 自动提取画面和语音内容。</span>
              </div>
            )}
```

- [ ] **Step 5: Add the selection summary + rewire the uploadZone open-on-click + generate button**

The `.uploadZone` `onClick`/`role`/`tabIndex` (lines 869-881) currently open the picker only when `!asset`. Change the condition to `assets.length === 0` (open picker on the empty state only; once there's a grid, the dedicated "上传素材" button handles new uploads):

```tsx
          <div
            className="uploadZone"
            onClick={assets.length === 0 && !pendingAction ? openFilePicker : undefined}
            onKeyDown={
              assets.length === 0 && !pendingAction
                ? (event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      openFilePicker();
                    }
                  }
                : undefined
            }
            role={assets.length === 0 ? "button" : undefined}
            tabIndex={assets.length === 0 && !pendingAction ? 0 : undefined}
          >
```

Just below the closing `</div>` of `.uploadZone` (after line 917) and before the "上传素材" button, add the summary:

```tsx
          {assets.length > 0 ? (
            <p className="mediaSummary">已选 {selectedAssets.length} / 共 {assets.length}</p>
          ) : null}
```

For the generate button (lines 1021-1029): it currently keys off `renderLocked || renderMissingAssets`. With `renderMissingAssets` now meaning "no selection", add an explicit gated label. Replace the button block with:

```tsx
          <button
            className="primaryButton"
            disabled={renderLocked || Boolean(renderMissingAssets) || Boolean(pendingAction)}
            onClick={simulateOneClickRender}
            type="button"
          >
            {pendingAction === "render" ? <span className="spinner" aria-hidden="true" /> : null}
            {renderLocked
              ? "请先完成门店档案"
              : renderMissingAssets
                ? "请至少勾选一个素材"
                : "开始生成视频"}
          </button>
```

(The `lockNotice` lines 1014-1019 can stay; the `renderMissingAssets` notice at 1019 remains accurate since it now reads "no selection".)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/dashboard.test.tsx`
Expected: PASS — both new grid/gate tests green, and the Task 5 multi-file test still passes (its uploaded assets render into the grid; "已选 2 / 共 2" appears).

- [ ] **Step 7: Commit**

```bash
git add components/dashboard.tsx tests/dashboard.test.tsx
git commit -m "feat(dashboard): asset grid with per-asset selection + render gate

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7: Per-asset delete + soft cap (12)

Wire the delete × button to the DELETE route, and cap the library at 12 assets per store via a tested pure helper.

**Files:**
- Create: `lib/asset-library.ts`
- Test: `tests/asset-library.test.ts` (new)
- Modify: `lib/api-client.ts` (add `deleteAsset`)
- Modify: `components/dashboard.tsx` (× button + cap in `handleAssetUploads`)

- [ ] **Step 1: Write the failing pure-function test**

Create `tests/asset-library.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/asset-library.test.ts`
Expected: FAIL — cannot resolve `@/lib/asset-library`.

- [ ] **Step 3: Create `lib/asset-library.ts`**

```ts
/** Soft cap on assets per store — bounds render complexity and write-rate-limit
 *  exposure (each upload = 3 writes against the 20/min write bucket). */
export const MAX_ASSETS_PER_STORE = 12;

/**
 * Decide how many of `fileCount` new uploads fit under the per-store cap given
 * the current library size. Pure so the cap logic is unit-testable without
 * rendering the dashboard.
 */
export function clampUploadBatch(
  currentCount: number,
  fileCount: number,
  max: number = MAX_ASSETS_PER_STORE
): { accepted: number; rejected: number } {
  const accepted = Math.max(0, Math.min(fileCount, max - currentCount));
  return { accepted, rejected: fileCount - accepted };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/asset-library.test.ts`
Expected: PASS.

- [ ] **Step 5: Add `deleteAsset` to the API client**

In `lib/api-client.ts`, append (after `saveAsset`, around line 153):

```ts
export async function deleteAsset(id: string): Promise<void> {
  await api<void>(`/api/assets/${id}`, { method: "DELETE" });
}
```

- [ ] **Step 6: Write the failing delete integration test**

Append to `tests/dashboard.test.tsx`:

```ts
  it("deletes an asset via the × button and removes it from the library", async () => {
    const user = userEvent.setup();
    const savedStore = {
      id: "store_del",
      ownerId: "demo_user",
      name: "删除店",
      industry: "餐饮",
      location: "上海",
      mainProducts: ["牛肉面"],
      targetCustomers: ["上班族"],
      sellingPoints: ["现熬牛骨汤"],
      promotions: [],
      brandTone: "亲切接地气",
      forbiddenWords: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    const savedAssets = [
      { id: "asset_del", ownerId: "demo_user", storeId: "store_del", type: "video", originalFilename: "del.mp4", storageKey: "k1", mimeType: "video/mp4", sizeBytes: 1000, tags: [], businessTags: [], status: "uploaded", createdAt: "2026-01-01T00:00:00.000Z" }
    ];

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url === "/api/assets/asset_del" && method === "DELETE") {
        return { ok: true, json: async () => ({ id: "asset_del" }) };
      }
      return {
        ok: true,
        json: async () => {
          if (url === "/api/store-profiles") return { stores: [savedStore] };
          if (url === "/api/assets") return { assets: savedAssets };
          if (url === "/api/asset-analyses") return { analyses: [] };
          if (url === "/api/avatars") return { avatars: [] };
          if (url === "/api/jobs") return { jobs: [] };
          if (url === "/api/script-drafts") return { scripts: [] };
          return {};
        }
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    vi.spyOn(window, "confirm").mockReturnValue(true);

    renderDashboard();

    await screen.findByText("已选 1 / 共 1");
    await user.click(screen.getByRole("button", { name: "删除素材 del.mp4" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/assets/asset_del",
      expect.objectContaining({ method: "DELETE" })
    );
    expect(
      await within(screen.getByRole("status")).findByText("已删除素材。")
    ).toBeInTheDocument();
  });
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `npx vitest run tests/dashboard.test.tsx -t "deletes an asset"`
Expected: FAIL — no "删除素材 del.mp4" button exists yet.

- [ ] **Step 8: Wire delete + cap in `components/dashboard.tsx`**

Add `deleteAsset` to the import from `@/lib/api-client` (lines 6-25) and add an import for the cap helper near line 26:

```ts
import { MAX_ASSETS_PER_STORE, clampUploadBatch } from "@/lib/asset-library";
```

Add a `handleDeleteAsset` helper near `toggleAssetSelected`:

```ts
  async function handleDeleteAsset(id: string) {
    if (typeof window !== "undefined" && !window.confirm("确认删除该素材？该操作不可撤销。")) {
      return;
    }
    try {
      await deleteAsset(id);
      setLocalAssets((prev) => prev.filter((a) => a.id !== id));
      setSelectedAssetIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      await queryClient.invalidateQueries({ queryKey: ["assets"] });
      setMessage("已删除素材。");
    } catch {
      setMessage("删除失败，请稍后重试。");
    }
  }
```

Inside the grid card (Task 6's `.mediaItem`), add a delete button after `.mediaMeta`:

```tsx
                      <button
                        aria-label={`删除素材 ${item.originalFilename}`}
                        className="removeIcon"
                        onClick={() => void handleDeleteAsset(item.id)}
                        type="button"
                      >
                        ×
                      </button>
```

Apply the cap at the top of `handleAssetUploads` (right after the `if (!store)` guard, before computing `validFiles`):

```ts
    const { accepted, rejected } = clampUploadBatch(assets.length, files.length);
    if (accepted === 0) {
      setMessage(`单店最多 ${MAX_ASSETS_PER_STORE} 个素材，请先删除不需要的再上传。`);
      return;
    }
    const filesToUpload = rejected > 0 ? files.slice(0, accepted) : files;
```

Then change the rest of the function to iterate `filesToUpload` instead of `files`: replace `const validFiles = files.filter(...)` with `const validFiles = filesToUpload.filter(...)`, and after the loop, if `rejected > 0 && failCount === 0`, append a note to the message:

```ts
    if (failCount === 0) {
      const base =
        successCount > 1
          ? `上传完成：已上传 ${successCount} 个素材。`
          : "上传完成：AI 已自动识别画面和语音内容。";
      setMessage(rejected > 0 ? `${base}（已达上限，其余 ${rejected} 个未上传）` : base);
    } else {
      setMessage(`上传完成：成功 ${successCount} 个，失败 ${failCount} 个，可重试失败的文件。`);
    }
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npx vitest run tests/dashboard.test.tsx tests/asset-library.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add lib/asset-library.ts tests/asset-library.test.ts lib/api-client.ts components/dashboard.tsx tests/dashboard.test.tsx
git commit -m "feat(dashboard): per-asset delete + 12-asset soft cap

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 8: Asset thumbnail preview (native `<video>`/`<img>`)

Replace the placeholder `.thumbnail` span with an `AssetThumbnail` that fetches a short-lived presigned URL (no polling) and renders a native element.

**Files:**
- Modify: `lib/api-client.ts` (add `fetchAssetPreviewUrl`)
- Modify: `components/dashboard.tsx` (add `AssetThumbnail` component, swap into grid card)

- [ ] **Step 1: Write the failing test**

Append to `tests/dashboard.test.tsx`:

```ts
  it("renders a video element for a video asset thumbnail", async () => {
    const savedStore = {
      id: "store_thumb",
      ownerId: "demo_user",
      name: "缩略图店",
      industry: "餐饮",
      location: "上海",
      mainProducts: ["牛肉面"],
      targetCustomers: ["上班族"],
      sellingPoints: ["现熬牛骨汤"],
      promotions: [],
      brandTone: "亲切接地气",
      forbiddenWords: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    const savedAssets = [
      { id: "asset_v", ownerId: "demo_user", storeId: "store_thumb", type: "video", originalFilename: "clip.mp4", storageKey: "stores/store_thumb/assets/asset_v-clip.mp4", mimeType: "video/mp4", sizeBytes: 1000, tags: [], businessTags: [], status: "uploaded", createdAt: "2026-01-01T00:00:00.000Z" }
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        json: async () => {
          if (url === "/api/store-profiles") return { stores: [savedStore] };
          if (url === "/api/assets") return { assets: savedAssets };
          if (url === "/api/asset-analyses") return { analyses: [] };
          if (url === "/api/avatars") return { avatars: [] };
          if (url === "/api/jobs") return { jobs: [] };
          if (url === "/api/script-drafts") return { scripts: [] };
          if (url === `/api/assets/asset_v/preview-url`) {
            return { url: "https://signed.example/clip", mimeType: "video/mp4", type: "video" };
          }
          return {};
        }
      }))
    );

    renderDashboard();

    const video = await screen.findByTestId("asset-thumbnail-video");
    expect(video.tagName).toBe("VIDEO");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/dashboard.test.tsx -t "video element for a video asset thumbnail"`
Expected: FAIL — no element with testid `asset-thumbnail-video`.

- [ ] **Step 3: Add `fetchAssetPreviewUrl` to the API client**

In `lib/api-client.ts`, append:

```ts
export interface AssetPreviewUrl {
  url: string;
  mimeType: string;
  type: Asset["type"];
}

export async function fetchAssetPreviewUrl(id: string): Promise<AssetPreviewUrl> {
  return api<AssetPreviewUrl>(`/api/assets/${id}/preview-url`);
}
```

- [ ] **Step 4: Add the `AssetThumbnail` component and swap it into the card**

In `components/dashboard.tsx`, add `fetchAssetPreviewUrl` to the `@/lib/api-client` import. Then add the component near `VideoOutputCard` (after line 1144):

```tsx
function AssetThumbnail({ asset }: { asset: Asset }) {
  // Short-lived presigned URL. NO polling / window-focus refetch / retry — the
  // dashboard's 429 death-spiral came from read amplification, so preview URLs
  // are fetched once per card mount and cached under the URL expiry.
  const { data } = useQuery({
    queryKey: ["asset-preview", asset.id],
    queryFn: () => fetchAssetPreviewUrl(asset.id),
    staleTime: 4 * 60 * 1000,
    gcTime: 5 * 60 * 1000,
    retry: false,
    refetchOnWindowFocus: false
  });

  if (!data) {
    return <span className="thumbnail" aria-hidden="true" />;
  }
  if (asset.type === "image") {
    return <img alt={asset.originalFilename} className="thumbnailImg" src={data.url} />;
  }
  if (asset.type === "video") {
    return <video className="thumbnailVideo" data-testid="asset-thumbnail-video" muted preload="metadata" src={data.url} />;
  }
  return <span className="thumbnail thumbnailAudio" aria-hidden="true" />;
}
```

In the grid card (Task 6/7), replace the placeholder `<span className="thumbnail" aria-hidden="true" />` inside `.mediaSelect` with:

```tsx
                        <AssetThumbnail asset={item} />
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/dashboard.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/api-client.ts components/dashboard.tsx tests/dashboard.test.tsx
git commit -m "feat(dashboard): native video/img asset thumbnails via presigned preview-url

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 9: Pass all selected assets + analyses to script generation and render

The headline correctness fix: `assetAnalysisIds` and `selectedAssetIds` carry every selected asset, so the script has enough material to schedule multiple broll scenes and `buildTimeline` can place them all.

**Files:**
- Modify: `components/dashboard.tsx` (avatar training 617-619, script-draft 654-659, render 660-667, AI tags 929-940)
- Test: `tests/dashboard.test.tsx` (assert request bodies)

- [ ] **Step 1: Write the failing test**

Append to `tests/dashboard.test.tsx`:

```ts
  it("passes all selected assets and analyses when generating", async () => {
    const user = userEvent.setup();
    const savedStore = {
      id: "store_passall",
      ownerId: "demo_user",
      name: "全量店",
      industry: "餐饮",
      location: "上海",
      mainProducts: ["牛肉面"],
      targetCustomers: ["上班族"],
      sellingPoints: ["现熬牛骨汤"],
      promotions: [],
      brandTone: "亲切接地气",
      forbiddenWords: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    const savedAssets = [
      { id: "asset_p1", ownerId: "demo_user", storeId: "store_passall", type: "video", originalFilename: "p1.mp4", storageKey: "k1", mimeType: "video/mp4", sizeBytes: 1000, tags: [], businessTags: [], status: "uploaded", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "asset_p2", ownerId: "demo_user", storeId: "store_passall", type: "image", originalFilename: "p2.jpg", storageKey: "k2", mimeType: "image/jpeg", sizeBytes: 2000, tags: [], businessTags: [], status: "uploaded", createdAt: "2026-01-01T00:00:00.000Z" }
    ];
    const savedAnalyses = [
      { id: "analysis_p1", assetId: "asset_p1", visualTags: ["food"], businessTags: ["新品推荐"], keywords: ["面"], confidence: 0.8, recommendedUses: ["new_product"], createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "analysis_p2", assetId: "asset_p2", visualTags: ["storefront"], businessTags: ["门店引流"], keywords: ["店"], confidence: 0.7, recommendedUses: ["store_traffic"], createdAt: "2026-01-01T00:00:00.000Z" }
    ];

    const fetchedBodies: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (method === "POST") fetchedBodies[url] = JSON.parse(String(init?.body ?? "{}"));
        return {
          ok: true,
          json: async () => {
            if (url === "/api/script-drafts") {
              return {
                script: {
                  id: "script_passall",
                  ownerId: "demo_user",
                  storeId: "store_passall",
                  purpose: "store_traffic",
                  platform: "douyin",
                  title: "引流",
                  hook: "来店",
                  scenes: [],
                  voiceover: "来店",
                  captions: [],
                  cta: "到店",
                  generationMode: "ai",
                  complianceWarnings: [],
                  createdAt: "2026-01-02T00:00:00.000Z"
                }
              };
            }
            if (url === "/api/render-projects") return { project: { id: "proj_passall" }, jobs: [] };
            if (url === "/api/store-profiles") return { stores: [savedStore] };
            if (url === "/api/assets") return { assets: savedAssets };
            if (url === "/api/asset-analyses") return { analyses: savedAnalyses };
            if (url === "/api/avatars") return { avatars: [] };
            if (url === "/api/jobs") return { jobs: [] };
            return {};
          }
        };
      })
    );

    renderDashboard();

    await screen.findByText("已选 2 / 共 2");
    await user.click(screen.getByRole("button", { name: "开始生成视频" }));

    await waitFor(() => {
      expect(fetchedBodies["/api/script-drafts"]).toBeDefined();
      expect(fetchedBodies["/api/render-projects"]).toBeDefined();
    });
    expect(fetchedBodies["/api/script-drafts"]).toMatchObject({
      assetAnalysisIds: expect.arrayContaining(["analysis_p1", "analysis_p2"])
    });
    expect((fetchedBodies["/api/script-drafts"] as { assetAnalysisIds: string[] }).assetAnalysisIds).toHaveLength(2);
    expect(fetchedBodies["/api/render-projects"]).toMatchObject({
      selectedAssetIds: expect.arrayContaining(["asset_p1", "asset_p2"])
    });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/dashboard.test.tsx -t "passes all selected assets"`
Expected: FAIL — currently `assetAnalysisIds` has length 1 and `selectedAssetIds` length 1.

- [ ] **Step 3: Rewire script-draft + render + avatar training + AI tags**

In `components/dashboard.tsx`:

- `simulateAvatarClone` training video (line 618) — change `trainingVideoAssetId: asset?.id ?? "asset_training_demo"` to use the first selected video:
```ts
        trainingVideoAssetId:
          selectedAssets.find((a) => a.type === "video")?.id ?? "asset_training_demo",
```

- `simulateOneClickRender` script-draft call (lines 654-659) — change `assetAnalysisIds: [analysis.id]` to pass all selected analyses:
```ts
      const draft = await createScriptDraftApi({
        storeId: store.id,
        assetAnalysisIds: selectedAnalyses.map((a) => a.id),
        purpose: selectedPurpose,
        platform: "douyin"
      });
```

- `simulateOneClickRender` render call (lines 660-667) — change `selectedAssetIds: [asset.id]` to pass all selected assets:
```ts
      const { jobs: plannedJobs } = await createRenderProjectApi({
        scriptDraftId: draft.id,
        selectedAssetIds: selectedAssets.map((a) => a.id),
        avatarProfileId: avatar?.id,
        aspectRatio: "9:16",
        subtitleStyle: "bold_bottom",
        bgmTrackId: "bgm_warm"
      });
```

- AI 自动分类 tag display (lines 929-940) — aggregate tags across all selected analyses instead of the single `analysis`:
```tsx
          {selectedAnalyses.length > 0 ? (
            <div className="result">
              <strong>AI 自动分类</strong>
              <div className="tagList">
                {Array.from(
                  new Set(selectedAnalyses.flatMap((a) => [...a.visualTags, ...a.businessTags]))
                ).map((tag) => (
                  <span className="techTag" key={tag}>
                    {tagDisplayLabels[tag] ?? tag}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
```

- [ ] **Step 4: Run the full test suite**

Run: `npx vitest run tests/dashboard.test.tsx`
Expected: PASS — the pass-all test green; the `analysis`/`asset` singletons are no longer referenced by these code paths.

- [ ] **Step 5: Commit**

```bash
git add components/dashboard.tsx tests/dashboard.test.tsx
git commit -m "fix(dashboard): pass all selected assets + analyses to script & render

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 10: Full CI regression

**Files:** none (verification only)

- [ ] **Step 1: Run the complete CI command set**

Run:
```bash
npm run typecheck && npm test && npm run lint && npx prisma validate && npm run build
```
Expected: all green (typecheck 0 errors; all tests pass; lint 0 errors; prisma validate OK; build exit 0).

- [ ] **Step 2: If any step fails, fix before proceeding**

Do not mark this task complete on a red step. Investigate with systematic-debugging; the most likely failure is a lingering reference to the removed `localAsset`/`localAnalysis`/`uploadProgress` symbols or an unused-import lint error from the `asset`/`analysis` singletons becoming unused.

- [ ] **Step 3: Commit any fixups, then confirm clean tree**

Run: `git status`
Expected: clean working tree (all changes committed across Tasks 1-9).

---

## Self-Review Notes

- **Spec coverage:** §5.1 `deleteObject` → Task 1. §5.2 `deleteById` (interface+memory+prisma) → Task 2. §5.3 DELETE route → Task 3, preview-url route → Task 4. §6.1 collection state + seed → Task 5. §6.2 multi-file input → Task 5. §6.3 sequential loop + failure isolation → Task 5. §6.4 grid + checkboxes + summary → Task 6. §6.5 script/render wiring + gate → Tasks 6 & 9. §6.6 api-client (`deleteAsset`, `fetchAssetPreviewUrl`) → Tasks 7 & 8. §6.7 preview-url caching (no polling) → Task 8. §7 12-asset cap → Task 7. §4.9 training video → Task 9. All spec sections mapped.
- **Type consistency:** `deleteById(id): Promise<boolean>` used identically in interface, memory, prisma, route, and test. `fetchAssetPreviewUrl` returns `{url, mimeType, type}` matching the route's `jsonOk` shape and the `AssetThumbnail` consumer. `selectedAssetIds: Set<string>` threaded consistently through `toggleAssetSelected`, `handleDeleteAsset`, the seed effect, and the render gate.
- **Placeholder scan:** every code step contains real code; commit messages are concrete; no "TODO"/"similar to" escapes.
- **Rate-limit invariant:** preview-url query (Task 8) sets `retry: false`, `refetchOnWindowFocus: false`, no `refetchInterval`; uploads are sequential (Task 5 `for...of`, no `Promise.all`).
