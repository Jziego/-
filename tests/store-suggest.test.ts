import { describe, it, expect, beforeEach, vi } from "vitest";
import * as aiClient from "@/lib/services/ai-client";
import { suggestStoreProfile, suggestFieldCandidates, StoreSuggestionError } from "@/lib/services/store-suggest";
import { storeSuggestionV2InputSchema } from "@/lib/schemas";

describe("suggestStoreProfile", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("parses and normalizes the AI suggestion into 5 fields", async () => {
    const spy = vi.spyOn(aiClient, "chatCompletionJSON").mockResolvedValue({
      mainProducts: ["牛肉面", "葱油拌面", "牛肉面"],
      sellingPoints: ["现熬牛骨汤"],
      targetCustomers: ["上班族", "社区居民"],
      promotions: ["工作日午餐第二份半价"],
      brandTone: "亲切接地气"
    });
    const result = await suggestStoreProfile({ name: "阿姨面馆", industry: "餐饮", location: "上海徐汇" });
    expect(result.mainProducts).toEqual(["牛肉面", "葱油拌面"]);
    expect(result.sellingPoints).toEqual(["现熬牛骨汤"]);
    expect(result.targetCustomers).toEqual(["上班族", "社区居民"]);
    expect(result.promotions).toEqual(["工作日午餐第二份半价"]);
    expect(result.brandTone).toBe("亲切接地气");
    const [, userPrompt] = spy.mock.calls[0]!;
    expect(userPrompt).toContain("阿姨面馆");
  });

  it("coerces malformed AI output to safe defaults", async () => {
    vi.spyOn(aiClient, "chatCompletionJSON").mockResolvedValue({
      mainProducts: "不是数组",
      sellingPoints: null,
      targetCustomers: ["", "  "],
      promotions: [],
      brandTone: 123
    });
    const result = await suggestStoreProfile({ name: "x", industry: "零售" });
    expect(result.mainProducts).toEqual([]);
    expect(result.sellingPoints).toEqual([]);
    expect(result.targetCustomers).toEqual([]);
    expect(result.brandTone).toBe("亲切接地气");
  });

  it("throws StoreSuggestionError when AI returns null", async () => {
    vi.spyOn(aiClient, "chatCompletionJSON").mockResolvedValue(null);
    await expect(suggestStoreProfile({ name: "x", industry: "零售" })).rejects.toBeInstanceOf(StoreSuggestionError);
  });
});

const fakeChat = (payload: unknown) => async () => payload;

describe("suggestFieldCandidates 候选池模式", () => {
  it("mainProducts 候选池：返回至多 8 条、去重去空", async () => {
    const chatJson = fakeChat({
      candidates: ["短视频代运营", "短视频代运营", "  ", "团购套餐设计", "同城引流", "直播带货辅助", "同城霸屏", "矩阵搭建", "数字化转型", "第九超出条"],
    });
    const out = await suggestFieldCandidates(
      { name: "华荧慧", industry: "商业服务", field: "mainProducts" },
      { chatJsonFn: chatJson as never },
    );
    expect(out).toHaveLength(8);
    expect(new Set(out).size).toBe(out.length);
    expect(out).not.toContain("");
  });

  it("exclude 条目进入 prompt", async () => {
    let seenUser = "";
    const chatJson = async (_sys: string, user: string) => {
      seenUser = user;
      return { candidates: ["a"] };
    };
    await suggestFieldCandidates(
      { name: "华荧慧", industry: "商业服务", field: "sellingPoints", exclude: ["15年经验", "AI 批量出片"] },
      { chatJsonFn: chatJson as never },
    );
    expect(seenUser).toContain("15年经验");
    expect(seenUser).toContain("AI 批量出片");
    expect(seenUser).toContain("不要重复");
  });

  it("人设字段进入 prompt", async () => {
    let seenUser = "";
    const chatJson = async (_sys: string, user: string) => {
      seenUser = user;
      return { candidates: ["a"] };
    };
    await suggestFieldCandidates(
      { name: "华荧慧", industry: "商业服务", location: "深圳龙岗", field: "mainProducts", nickname: "君姐", ownerAge: 48, yearsInBusiness: 15 },
      { chatJsonFn: chatJson as never },
    );
    expect(seenUser).toContain("君姐");
    expect(seenUser).toContain("48");
    expect(seenUser).toContain("15");
  });

  it("AI 返回 null → StoreSuggestionError", async () => {
    await expect(
      suggestFieldCandidates(
        { name: "x", industry: "y", field: "mainProducts" },
        { chatJsonFn: (async () => null) as never },
      ),
    ).rejects.toThrow(StoreSuggestionError);
  });
});

describe("storeSuggestionV2InputSchema", () => {
  it("兼容旧调用（无 field）", () => {
    const r = storeSuggestionV2InputSchema.safeParse({ name: "华荧慧", industry: "商业服务" });
    expect(r.success).toBe(true);
  });

  it("候选池调用通过；非法 field 拒绝", () => {
    expect(
      storeSuggestionV2InputSchema.safeParse({ name: "a", industry: "b", field: "mainProducts", exclude: ["x"] }).success,
    ).toBe(true);
    expect(
      storeSuggestionV2InputSchema.safeParse({ name: "a", industry: "b", field: "brandTone" }).success,
    ).toBe(false);
  });

  it("exclude 超 40 条拒绝", () => {
    const r = storeSuggestionV2InputSchema.safeParse({
      name: "a", industry: "b", field: "mainProducts",
      exclude: Array.from({ length: 41 }, (_, i) => `条目${i}`),
    });
    expect(r.success).toBe(false);
  });
});
