import { describe, expect, it } from "vitest";
import { getStoreRepository, getScriptRepository } from "@/lib/repositories";
import { createId, nowIso } from "@/lib/ids";
import type { ScriptDraft, StoreProfile } from "@/lib/types";

function makeStore(): StoreProfile {
  return {
    id: createId("store"),
    ownerId: "demo",
    name: "华荧慧",
    industry: "商业服务",
    location: "广东省深圳市龙岗区",
    nickname: "君姐",
    ownerAge: 48,
    yearsInBusiness: 15,
    mainProducts: ["线上运营赋能"],
    targetCustomers: ["门店老板"],
    sellingPoints: ["课程内容实用易懂"],
    promotions: [],
    brandTone: "亲切接地气",
    forbiddenWords: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

describe("门店人设字段与文案 angle/analysis 持久化", () => {
  it("store upsert + findById 回读 nickname/ownerAge/yearsInBusiness", async () => {
    const repo = getStoreRepository();
    const saved = await repo.upsert(makeStore());
    const loaded = await repo.findById(saved.id);
    expect(loaded?.nickname).toBe("君姐");
    expect(loaded?.ownerAge).toBe(48);
    expect(loaded?.yearsInBusiness).toBe(15);
  });

  it("store upsert 更新路径也写入新字段（prisma 白名单回归）", async () => {
    const repo = getStoreRepository();
    const store = makeStore();
    await repo.upsert(store);
    await repo.upsert({ ...store, nickname: "华姐", updatedAt: nowIso() });
    const loaded = await repo.findById(store.id);
    expect(loaded?.nickname).toBe("华姐");
  });

  it("script create 落库 angle 与 analysis", async () => {
    const store = await getStoreRepository().upsert(makeStore());
    const draft: ScriptDraft = {
      id: createId("script"),
      ownerId: "demo",
      storeId: store.id,
      purpose: "store_traffic",
      platform: "douyin",
      title: "测试",
      hook: "钩子",
      scenes: [],
      voiceover: "口播稿。",
      captions: ["口播稿。"],
      cta: "到店",
      generationMode: "ai",
      complianceWarnings: [],
      angle: "痛点暴击",
      analysis: { overview: "概述", principles: "原则解析", structure: "结构解析" },
      createdAt: nowIso(),
    };
    const saved = await getScriptRepository().create(draft);
    const loaded = await getScriptRepository().findById(saved.id);
    expect(loaded?.angle).toBe("痛点暴击");
    expect(loaded?.analysis?.overview).toBe("概述");
  });
});
