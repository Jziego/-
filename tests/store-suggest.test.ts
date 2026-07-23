import { describe, it, expect, beforeEach, vi } from "vitest";
import * as aiClient from "@/lib/services/ai-client";
import { suggestStoreProfile, StoreSuggestionError } from "@/lib/services/store-suggest";

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
