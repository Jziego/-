import { describe, expect, it } from "vitest";
import {
  AVATAR_APPEARANCE_POINTS,
  AVATAR_CREATE_POINTS,
  POINTS_PER_YUAN,
  RENDER_BASE_POINTS,
  SCRIPT_DRAFT_POINTS,
  renderPointsCost,
} from "@/lib/points-pricing";

describe("points pricing", () => {
  it("10 积分 = 1 元", () => {
    expect(POINTS_PER_YUAN).toBe(10);
  });

  it("定价与确认表一致：写稿 10 / 渲染基础 30 / 数字人 250", () => {
    expect(SCRIPT_DRAFT_POINTS).toBe(10);
    expect(RENDER_BASE_POINTS).toBe(30);
    expect(AVATAR_APPEARANCE_POINTS).toBe(250);
  });

  it("生成数字人形象：名义防滥用费 10 积分（后端成本为 0，纯拦截反复上传）", () => {
    expect(AVATAR_CREATE_POINTS).toBe(10);
  });

  it("renderPointsCost：无数字人 = 基础价；负数形象按 0 计", () => {
    expect(renderPointsCost(0)).toBe(30);
    expect(renderPointsCost(-2)).toBe(30);
  });

  it("renderPointsCost：1~3 个形象", () => {
    expect(renderPointsCost(1)).toBe(280);
    expect(renderPointsCost(2)).toBe(530);
    expect(renderPointsCost(3)).toBe(780);
  });
});
