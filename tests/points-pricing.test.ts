import { describe, expect, it } from "vitest";
import {
  AVATAR_CREATE_POINTS,
  POINTS_PER_YUAN,
  RENDER_VIDEO_POINTS,
  SCRIPT_DRAFT_POINTS,
} from "@/lib/points-pricing";

describe("points pricing", () => {
  it("10 积分 = 1 元", () => {
    expect(POINTS_PER_YUAN).toBe(10);
  });

  it("定价表（2026-10-13 与需求方确认）：写稿 10 / 建形象 10 / 渲染一口价 50", () => {
    expect(SCRIPT_DRAFT_POINTS).toBe(10);
    expect(AVATAR_CREATE_POINTS).toBe(10);
    expect(RENDER_VIDEO_POINTS).toBe(50);
  });

  it("渲染为一串口价：带不带数字人同价，防回归旧的 30+250×N 分级计价", async () => {
    // 50 积分 = ¥5；60s 带数字人成本 ≈¥1.3 → 毛利 ~74%。
    // 旧的按数量加价（renderPointsCost / AVATAR_APPEARANCE_POINTS / RENDER_BASE_POINTS）必须保持移除。
    const mod = await import("@/lib/points-pricing");
    expect("renderPointsCost" in mod).toBe(false);
    expect("AVATAR_APPEARANCE_POINTS" in mod).toBe(false);
    expect("RENDER_BASE_POINTS" in mod).toBe(false);
    // 唯一渲染出口
    expect(typeof mod.RENDER_VIDEO_POINTS).toBe("number");
  });
});
