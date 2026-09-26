import { describe, expect, it } from "vitest";
import type { StoreProfile } from "@/lib/types";
import { createId, nowIso } from "@/lib/ids";

// 通过模块级 mock 拦 AI 调用，验证 prompt 组装与解析处理
import { vi } from "vitest";
vi.mock("@/lib/services/ai-client", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/services/ai-client")>();
  // 注：测试环境无 OPENAI_API_KEY（hasAI()=false），强制走 AI 路径才能验证 prompt 组装。
  return { ...mod, chatCompletionJSON: vi.fn(), hasAI: () => true };
});

import { chatCompletionJSON } from "@/lib/services/ai-client";
import { createScriptDraft } from "@/lib/services/script-engine";

const chatMock = vi.mocked(chatCompletionJSON);

function makeStore(): StoreProfile {
  return {
    id: createId("store"), ownerId: "demo", name: "华荧慧", industry: "商业服务",
    location: "广东省深圳市龙岗区", nickname: "君姐", ownerAge: 48, yearsInBusiness: 15,
    mainProducts: ["短视频代运营"], targetCustomers: ["门店老板"],
    sellingPoints: ["15年行业深耕经验"], promotions: [], brandTone: "亲切接地气",
    forbiddenWords: [], createdAt: nowIso(), updatedAt: nowIso(),
  };
}

const aiPayload = {
  title: "龙岗君姐15年", hook: "深圳创业老板注意啦",
  voiceover: "深圳创业老板注意啦。以前靠等客的日子现在该换个打法了。",
  highlights: ["深圳创业老板"], onCameraSentences: ["深圳创业老板注意啦。"], cta: "私信君姐",
  analysis: { overview: "概述文本", principles: "原则解析文本", structure: "结构解析文本" },
};

describe("规则注入与角度", () => {
  it("system prompt 含三大原则；user prompt 含人设句与切入角度", async () => {
    chatMock.mockResolvedValueOnce(aiPayload);
    await createScriptDraft({ store: makeStore(), assetAnalyses: [], purpose: "store_traffic", angle: "痛点暴击" });
    const [system, user] = chatMock.mock.calls[0] as unknown as [string, string];
    expect(system).toContain("锁同城原则");
    expect(system).toContain("反幻觉");
    expect(user).toContain("君姐");
    expect(user).toContain("48");
    expect(user).toContain("15");
    expect(user).toContain("痛点暴击");
  });

  it("draft 落 angle 与 analysis", async () => {
    chatMock.mockResolvedValueOnce(aiPayload);
    const draft = await createScriptDraft({ store: makeStore(), assetAnalyses: [], purpose: "store_traffic", angle: "场景代入" });
    expect(draft.angle).toBe("场景代入");
    expect(draft.analysis?.overview).toBe("概述文本");
  });

  it("analysis 缺失容忍：AI 不返回该字段时文案照常出", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- rest 解构剔除 analysis 字段
    const { analysis: _omit, ...noAnalysis } = aiPayload;
    chatMock.mockResolvedValueOnce(noAnalysis);
    const draft = await createScriptDraft({ store: makeStore(), assetAnalyses: [], purpose: "store_traffic" });
    expect(draft.voiceover).toContain("深圳创业老板");
    expect(draft.analysis).toBeUndefined();
  });

  it("forcedRawCopy 路径无 angle/analysis", async () => {
    const draft = await createScriptDraft({ store: makeStore(), assetAnalyses: [], purpose: "store_traffic", forcedRawCopy: "手动文案。" });
    expect(draft.angle).toBeUndefined();
    expect(draft.analysis).toBeUndefined();
  });
});

describe("sanitizeCopy 补强", () => {
  it("剥离 markdown 符号与 emoji", async () => {
    chatMock.mockResolvedValueOnce({
      ...aiPayload,
      voiceover: "**龙岗老板**注意啦🔥。## 先说结论。",
    });
    const draft = await createScriptDraft({ store: makeStore(), assetAnalyses: [], purpose: "store_traffic" });
    expect(draft.voiceover).not.toContain("*");
    expect(draft.voiceover).not.toContain("#");
    expect(draft.voiceover).not.toContain("🔥");
    expect(draft.voiceover).toContain("龙岗老板注意啦");
  });
});
