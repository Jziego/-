import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as assetsPOST } from "@/app/api/assets/route";
import { POST as confirmPOST } from "@/app/api/assets/confirm/route";
import { POST as analyzePOST } from "@/app/api/assets/analyze/route";
import { POST as storeProfilesPOST } from "@/app/api/store-profiles/route";
import { POST as scriptDraftsPOST } from "@/app/api/script-drafts/route";
import { resetRuntimeStateForTests } from "@/lib/runtime-store";

const savedDbUrl = process.env.DATABASE_URL;
const savedStorageEndpoint = process.env.OBJECT_STORAGE_ENDPOINT;
const savedStorageBucket = process.env.OBJECT_STORAGE_BUCKET;
const savedStorageKeyId = process.env.OBJECT_STORAGE_ACCESS_KEY_ID;
const savedStorageKeySecret = process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY;

function req(url: string): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not valid json",
  });
}

const cases = [
  { name: "POST /api/assets", fn: () => assetsPOST(req("http://localhost/api/assets")) },
  { name: "POST /api/assets/confirm", fn: () => confirmPOST(req("http://localhost/api/assets/confirm")) },
  { name: "POST /api/assets/analyze", fn: () => analyzePOST(req("http://localhost/api/assets/analyze")) },
  { name: "POST /api/store-profiles", fn: () => storeProfilesPOST(req("http://localhost/api/store-profiles")) },
  { name: "POST /api/script-drafts", fn: () => scriptDraftsPOST(req("http://localhost/api/script-drafts")) },
];

describe("request.json() — invalid body returns 400 (not uncaught 500)", () => {
  beforeEach(() => {
    delete process.env.DATABASE_URL;
    resetRuntimeStateForTests();
    // confirm route short-circuits with 503 when storage is unconfigured — set
    // OBJECT_STORAGE_* so the request reaches the request.json() parse line.
    process.env.OBJECT_STORAGE_ENDPOINT = "http://localhost:9000";
    process.env.OBJECT_STORAGE_BUCKET = "test";
    process.env.OBJECT_STORAGE_ACCESS_KEY_ID = "test";
    process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY = "test";
  });
  afterEach(() => {
    if (savedDbUrl) process.env.DATABASE_URL = savedDbUrl;
    if (savedStorageEndpoint) process.env.OBJECT_STORAGE_ENDPOINT = savedStorageEndpoint;
    else delete process.env.OBJECT_STORAGE_ENDPOINT;
    if (savedStorageBucket) process.env.OBJECT_STORAGE_BUCKET = savedStorageBucket;
    else delete process.env.OBJECT_STORAGE_BUCKET;
    if (savedStorageKeyId) process.env.OBJECT_STORAGE_ACCESS_KEY_ID = savedStorageKeyId;
    else delete process.env.OBJECT_STORAGE_ACCESS_KEY_ID;
    if (savedStorageKeySecret) process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY = savedStorageKeySecret;
    else delete process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY;
  });

  for (const c of cases) {
    it(`${c.name} returns 400 on malformed JSON`, async () => {
      const res = await c.fn();
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/json/i);
    });
  }
});
