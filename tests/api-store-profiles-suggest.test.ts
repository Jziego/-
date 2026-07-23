import { describe, it, expect, beforeEach, vi } from "vitest";
import * as authHelpers from "@/lib/auth-helpers";
import * as rateLimit from "@/lib/rate-limit";
import * as aiClient from "@/lib/services/ai-client";
import * as storeSuggest from "@/lib/services/store-suggest";
import { POST } from "@/app/api/store-profiles/suggest/route";

function newRequest(body: unknown) {
  return new Request("http://localhost/api/store-profiles/suggest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("POST /api/store-profiles/suggest", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(authHelpers, "getOwnerId").mockResolvedValue("demo_user");
    vi.spyOn(rateLimit, "applyRateLimit").mockResolvedValue(null);
  });

  it("returns 400 when name/industry missing", async () => {
    const res = await POST(newRequest({ name: "" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 on invalid JSON body", async () => {
    const req = new Request("http://localhost/api/store-profiles/suggest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json"
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 503 when AI is not configured", async () => {
    vi.spyOn(aiClient, "hasAI").mockReturnValue(false);
    const res = await POST(newRequest({ name: "阿姨面馆", industry: "餐饮" }));
    expect(res.status).toBe(503);
  });

  it("returns 200 with a suggestion on success", async () => {
    vi.spyOn(aiClient, "hasAI").mockReturnValue(true);
    vi.spyOn(storeSuggest, "suggestStoreProfile").mockResolvedValue({
      mainProducts: ["牛肉面"],
      sellingPoints: ["现熬"],
      targetCustomers: ["上班族"],
      promotions: ["午餐半价"],
      brandTone: "亲切接地气"
    });
    const res = await POST(newRequest({ name: "阿姨面馆", industry: "餐饮", location: "上海" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.suggestion.mainProducts).toEqual(["牛肉面"]);
    expect(body.suggestion.brandTone).toBe("亲切接地气");
  });

  it("returns 502 when the AI service throws", async () => {
    vi.spyOn(aiClient, "hasAI").mockReturnValue(true);
    vi.spyOn(storeSuggest, "suggestStoreProfile").mockRejectedValue(new storeSuggest.StoreSuggestionError("empty"));
    const res = await POST(newRequest({ name: "x", industry: "零售" }));
    expect(res.status).toBe(502);
  });
});
