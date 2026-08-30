import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { resetRuntimeStateForTests } from "@/lib/runtime-store";
import { getAvatarRepository } from "@/lib/repositories";
import { createMockProvider } from "@/lib/services/providers/mock";
import type { AvatarProvider } from "@/lib/services/avatar-provider";
import { nowIso } from "@/lib/ids";
import type { AvatarProfile } from "@/lib/types";

// vi.hoisted 持有可变 provider 引用，每个 it 换 twinStatusSequence。
// 注意：vi.hoisted 工厂在 import 求值前执行，不能在里面调 createMockProvider，
// 统一在 beforeEach / it 内赋值。
// 必须 importOriginal 展开真实导出——路由里的 instanceof AvatarProviderNotConfiguredError
// 需要拿到真实的错误类；整体替换会让它变成 undefined。
const { providerRef, factoryMode } = vi.hoisted(() => ({
  providerRef: { current: null as AvatarProvider | null },
  factoryMode: { value: "ok" as "ok" | "unconfigured" },
}));
vi.mock("@/lib/services/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/services/providers")>();
  return {
    ...actual,
    createProviderFromEnv: () => {
      if (factoryMode.value === "unconfigured") {
        throw new actual.AvatarProviderNotConfiguredError();
      }
      return providerRef.current;
    },
  };
});

import { GET } from "@/app/api/avatars/[id]/status/route";
import { POST as CONSENT_POST } from "@/app/api/avatars/[id]/consent/route";

const savedDbUrl = process.env.DATABASE_URL;

function seedAvatar(overrides: Partial<AvatarProfile> = {}): AvatarProfile {
  const now = nowIso();
  return {
    id: "avatar_1", ownerId: "demo_user", storeId: "store_1", name: "店主",
    provider: "mock-avatar", providerGroupId: "group_1",
    consentStatus: "awaiting_user", trainingStatus: "pending",
    trainingVideoAssetId: "asset_f1",
    consentAcceptedAt: now, fallbackMode: "tts_voiceover",
    createdAt: now, updatedAt: now, ...overrides,
  };
}

function getStatus(id: string) {
  return GET(new Request(`http://localhost/api/avatars/${id}/status`), {
    params: Promise.resolve({ id }),
  } as never);
}

function postConsent(id: string) {
  return CONSENT_POST(new Request(`http://localhost/api/avatars/${id}/consent`, { method: "POST" }), {
    params: Promise.resolve({ id }),
  } as never);
}

describe("GET /api/avatars/[id]/status", () => {
  beforeEach(() => {
    delete process.env.DATABASE_URL;
    resetRuntimeStateForTests();
    providerRef.current = createMockProvider();
    factoryMode.value = "ok";
  });
  afterEach(() => { if (savedDbUrl) process.env.DATABASE_URL = savedDbUrl; });

  it("returns 503 (not a fake status) when the provider is not configured", async () => {
    factoryMode.value = "unconfigured";
    await getAvatarRepository().create(seedAvatar());
    const res = await getStatus("avatar_1");
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toContain("数字人服务未配置");
    // 不得把 mock 的假 ready/假 providerAvatarId 写进库
    const persisted = await getAvatarRepository().findById("avatar_1");
    expect(persisted?.trainingStatus).toBe("pending");
    expect(persisted?.providerAvatarId).toBeUndefined();
  });

  it("awaiting_user + pending stays pending and returns the consent url", async () => {
    providerRef.current = createMockProvider({
      twinStatusSequence: [
        { consentStatus: "awaiting_user", trainingStatus: "pending", consentUrl: "https://consent.example.com/group_1" },
      ],
    });
    await getAvatarRepository().create(seedAvatar());
    const res = await getStatus("avatar_1");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.avatar).toMatchObject({ trainingStatus: "pending", consentStatus: "awaiting_user" });
    expect(json.consentUrl).toBe("https://consent.example.com/group_1");
  });

  it("approved + processing flips consent to approved and keeps training", async () => {
    providerRef.current = createMockProvider({
      twinStatusSequence: [{ consentStatus: "approved", trainingStatus: "processing" }],
    });
    await getAvatarRepository().create(seedAvatar());
    const res = await getStatus("avatar_1");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.avatar).toMatchObject({ trainingStatus: "processing", consentStatus: "approved" });
    // ready 前不得写入可合成 id
    expect(json.avatar.providerAvatarId).toBeUndefined();
  });

  it("approved + ready writes provider ids and flips trainingStatus to ready", async () => {
    providerRef.current = createMockProvider({
      twinStatusSequence: [
        { consentStatus: "approved", trainingStatus: "ready", providerAvatarId: "look_9", providerVoiceId: "voice_9" },
      ],
    });
    await getAvatarRepository().create(seedAvatar());
    const pollSpy = vi.spyOn(providerRef.current, "getDigitalTwinStatus");
    const res = await getStatus("avatar_1");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.avatar).toMatchObject({
      trainingStatus: "ready", consentStatus: "approved",
      providerAvatarId: "look_9", providerVoiceId: "voice_9",
    });
    // 终态缓存：再调不再触 provider
    const res2 = await getStatus("avatar_1");
    expect(res2.status).toBe(200);
    expect(pollSpy).toHaveBeenCalledTimes(1);
  });

  it("rejected consent marks the avatar failed with a reason", async () => {
    providerRef.current = createMockProvider({
      twinStatusSequence: [{ consentStatus: "rejected", trainingStatus: "failed", reason: "用户拒绝了授权" }],
    });
    await getAvatarRepository().create(seedAvatar());
    const res = await getStatus("avatar_1");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.avatar).toMatchObject({
      trainingStatus: "failed", consentStatus: "rejected", statusReason: "用户拒绝了授权",
    });
  });

  it("expired consent marks the avatar failed with an expiry reason", async () => {
    providerRef.current = createMockProvider({
      twinStatusSequence: [{ consentStatus: "expired", trainingStatus: "failed" }],
    });
    await getAvatarRepository().create(seedAvatar());
    const res = await getStatus("avatar_1");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.avatar.trainingStatus).toBe("failed");
    expect(json.avatar.consentStatus).toBe("expired");
    expect(json.avatar.statusReason).toContain("过期");
  });

  it("404s for an avatar owned by someone else", async () => {
    await getAvatarRepository().create(seedAvatar({ ownerId: "other" }));
    const res = await getStatus("avatar_1");
    expect(res.status).toBe(404);
  });
});

describe("POST /api/avatars/[id]/consent", () => {
  beforeEach(() => {
    delete process.env.DATABASE_URL;
    resetRuntimeStateForTests();
    providerRef.current = createMockProvider();
    factoryMode.value = "ok";
  });
  afterEach(() => { if (savedDbUrl) process.env.DATABASE_URL = savedDbUrl; });

  it("returns 503 when the provider is not configured", async () => {
    factoryMode.value = "unconfigured";
    await getAvatarRepository().create(seedAvatar({
      consentStatus: "expired", trainingStatus: "failed",
    }));
    const res = await postConsent("avatar_1");
    expect(res.status).toBe(503);
    // 状态机不被副作用改写
    const persisted = await getAvatarRepository().findById("avatar_1");
    expect(persisted).toMatchObject({ consentStatus: "expired", trainingStatus: "failed" });
  });

  it("re-issues consent for a failed (expired) avatar and resets the state machine", async () => {
    await getAvatarRepository().create(seedAvatar({
      consentStatus: "expired", trainingStatus: "failed", statusReason: "授权链接已过期",
    }));
    const res = await postConsent("avatar_1");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.consentUrl).toContain("http");
    expect(json.avatar).toMatchObject({ consentStatus: "awaiting_user", trainingStatus: "pending" });
    expect(json.avatar.statusReason).toBeUndefined();
    // 落库后的持久化状态同样被清空
    const persisted = await getAvatarRepository().findById("avatar_1");
    expect(persisted?.statusReason).toBeUndefined();
    expect(persisted?.trainingStatus).toBe("pending");
  });

  it("409s when the avatar is already ready", async () => {
    await getAvatarRepository().create(seedAvatar({
      consentStatus: "approved", trainingStatus: "ready", providerAvatarId: "look_9",
    }));
    const res = await postConsent("avatar_1");
    expect(res.status).toBe(409);
  });

  it("409s while training is in flight (approved + processing) — re-issue must not reset the state machine", async () => {
    await getAvatarRepository().create(seedAvatar({
      consentStatus: "approved", trainingStatus: "processing",
    }));
    const res = await postConsent("avatar_1");
    expect(res.status).toBe(409);
    // 本地状态不被重发副作用改写
    const persisted = await getAvatarRepository().findById("avatar_1");
    expect(persisted).toMatchObject({ consentStatus: "approved", trainingStatus: "processing" });
  });

  it("404s for an avatar owned by someone else", async () => {
    await getAvatarRepository().create(seedAvatar({ ownerId: "other" }));
    const res = await postConsent("avatar_1");
    expect(res.status).toBe(404);
  });
});
