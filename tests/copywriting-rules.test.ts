import { describe, expect, it } from "vitest";
import { COPYWRITING_RULES, COPY_ANGLES, DEFAULT_ANGLE, angleGuidance, nextAngle } from "@/lib/copywriting-rules";

describe("文案规则文件", () => {
  it("规则全文包含三大原则与四大结构", () => {
    for (const kw of ["锁同城", "锁行业目标客户", "兴趣点种草", "黄金开头", "高密度信息", "场景化种草", "行动号召"]) {
      expect(COPYWRITING_RULES).toContain(kw);
    }
  });

  it("包含反幻觉与负面约束章节", () => {
    expect(COPYWRITING_RULES).toContain("反幻觉");
    expect(COPYWRITING_RULES).toContain("不擅自编造");
    expect(COPYWRITING_RULES).toContain("不客套开场");
  });

  it("五个切入角度且每个有引导语", () => {
    expect(COPY_ANGLES).toHaveLength(5);
    for (const angle of COPY_ANGLES) {
      expect(angleGuidance(angle).length).toBeGreaterThan(10);
    }
  });

  it("nextAngle 按序列轮换、到尾回首项、未知角度从首项开始", () => {
    expect(nextAngle("痛点暴击")).toBe("场景代入");
    expect(nextAngle("反差悬念")).toBe("痛点暴击");
    expect(nextAngle(undefined)).toBe("痛点暴击");
    expect(nextAngle("不存在的角度")).toBe("痛点暴击");
  });

  it("DEFAULT_ANGLE 为序列首项，且与 nextAngle(undefined) 缺省起点一致", () => {
    expect(DEFAULT_ANGLE).toBe(COPY_ANGLES[0]);
    expect(nextAngle(undefined)).toBe(DEFAULT_ANGLE);
  });
});
