import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { POST } from "@/app/api/avatars/talking-head/route";
import {
  getAvatarRepository,
  getJobRepository,
  getScriptRepository,
  getStoreRepository
} from "@/lib/repositories";
import { resetRuntimeStateForTests } from "@/lib/runtime-store";
import { createId, nowIso } from "@/lib/ids";
import type { AvatarProfile, ScriptDraft, StoreProfile } from "@/lib/types";

// Force memory repositories regardless of DATABASE_URL
const savedDbUrl = process.env.DATABASE_URL;

function seedStore(): StoreProfile {
  return {
    id: createId("store"),
    ownerId: "demo_user",
    name: "测试门店",
    industry: "餐饮",
    location: "上海",
    mainProducts: ["面"],
    targetCustomers: ["上班族"],
    sellingPoints: ["快"],
    promotions: [],
    brandTone: "亲切",
    forbiddenWords: [],
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
}

function seedAvatar(ownerId: string): AvatarProfile {
  const now = nowIso();
  return {
    id: createId("avatar"),
    ownerId,
    storeId: "store_1",
    provider: "mock-avatar",
    providerAvatarId: "provider_av_x",
    providerVoiceId: "provider_v_x",
    consentAcceptedAt: now,
    trainingStatus: "ready",
    fallbackMode: "tts_voiceover",
    createdAt: now,
    updatedAt: now
  };
}

function seedScript(ownerId: string, storeId: string): ScriptDraft {
  return {
    id: createId("script"),
    ownerId,
    storeId,
    purpose: "promotion",
    platform: "douyin",
    title: "测试脚本",
    hook: "测试开场",
    scenes: [],
    voiceover: "测试配音文案",
    captions: [],
    cta: "测试CTA",
    generationMode: "ai",
    complianceWarnings: [],
    createdAt: nowIso()
  };
}

describe("POST /api/avatars/talking-head", () => {
  beforeEach(() => {
    delete process.env.DATABASE_URL;
    resetRuntimeStateForTests();
  });

  afterEach(() => {
    if (savedDbUrl) process.env.DATABASE_URL = savedDbUrl;
  });

  it("returns 202 + jobId and creates a talking_head job for a ready avatar + valid draft", async () => {
    const store = seedStore();
    await getStoreRepository().upsert(store);
    const avatar = seedAvatar("demo_user");
    await getAvatarRepository().create(avatar);
    const draft = seedScript("demo_user", store.id);
    await getScriptRepository().create(draft);

    const req = new Request("http://localhost/api/avatars/talking-head", {
      method: "POST",
      body: JSON.stringify({ avatarProfileId: avatar.id, scriptDraftId: draft.id })
    });
    const res = await POST(req);
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.jobId).toBeDefined();
    expect(body.status).toContain("/api/jobs/");

    const jobs = await getJobRepository().listByOwner("demo_user");
    const thJob = jobs.find((j) => j.type === "talking_head");
    expect(thJob).toBeDefined();
    expect(thJob?.payload).toMatchObject({
      avatarProfileId: avatar.id,
      scriptDraftId: draft.id
    });
  });

  it("returns 404 for an avatar owned by another user (IDOR)", async () => {
    const store = seedStore();
    await getStoreRepository().upsert(store);
    const foreignAvatar = seedAvatar("other_user");
    await getAvatarRepository().create(foreignAvatar);
    const draft = seedScript("demo_user", store.id);
    await getScriptRepository().create(draft);

    const req = new Request("http://localhost/api/avatars/talking-head", {
      method: "POST",
      body: JSON.stringify({ avatarProfileId: foreignAvatar.id, scriptDraftId: draft.id })
    });
    const res = await POST(req);
    expect(res.status).toBe(404);
  });

  it("returns 400 when required fields are missing", async () => {
    const req = new Request("http://localhost/api/avatars/talking-head", {
      method: "POST",
      body: JSON.stringify({})
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});
