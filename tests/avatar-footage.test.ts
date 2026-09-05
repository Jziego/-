import { describe, expect, it } from "vitest";
import {
  MAX_FOOTAGE_BYTES,
  MAX_FOOTAGE_DURATION_SEC,
  MIN_FOOTAGE_DURATION_SEC,
  validateFootageDuration,
  validateFootageSize,
} from "@/lib/avatar-footage";

// HeyGen 数字人训练素材约束（2026-09-05 生产事故后确立）：
// 时长 30s–5min 是 HeyGen 训练要求；文件 ≤30MB 是应用侧上限
// （HeyGen /v3/assets 直传硬上限 32MB，89.3MB 素材被 400 拒）。
describe("avatar footage constraints", () => {
  it("constants: 30s–5min duration window, 30MiB size cap under HeyGen's 32MiB hard limit", () => {
    expect(MIN_FOOTAGE_DURATION_SEC).toBe(30);
    expect(MAX_FOOTAGE_DURATION_SEC).toBe(300);
    expect(MAX_FOOTAGE_BYTES).toBeLessThan(32 * 1024 * 1024);
  });

  it("size at the cap passes; over the cap fails with a user-facing Chinese message", () => {
    expect(validateFootageSize(MAX_FOOTAGE_BYTES)).toBeNull();
    expect(validateFootageSize(MAX_FOOTAGE_BYTES + 1)).toContain("30MB");
  });

  it("duration within 30s–5min passes; shorter or longer fails", () => {
    expect(validateFootageDuration(MIN_FOOTAGE_DURATION_SEC)).toBeNull();
    expect(validateFootageDuration(MAX_FOOTAGE_DURATION_SEC)).toBeNull();
    expect(validateFootageDuration(29)).toContain("太短");
    expect(validateFootageDuration(301)).toContain("太长");
  });

  it("unreadable duration (<=0) passes — HeyGen validates authoritatively at creation", () => {
    expect(validateFootageDuration(0)).toBeNull();
  });
});
