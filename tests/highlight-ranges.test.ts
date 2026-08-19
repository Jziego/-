import { describe, expect, it } from "vitest";
import { findHighlightRanges } from "@/lib/highlight-ranges";

describe("findHighlightRanges", () => {
  it("finds a single word occurrence", () => {
    expect(findHighlightRanges("牛肉面今天半价", ["牛肉面"])).toEqual([[0, 3]]);
  });

  it("finds every occurrence of a word", () => {
    expect(findHighlightRanges("牛肉面配牛肉汤", ["牛肉"])).toEqual([
      [0, 2],
      [4, 6],
    ]);
  });

  it("prefers longer words on overlap", () => {
    // “牛肉面” 命中 [0,3] 后，“牛肉” 的 [0,2] 重叠跳过，只保留 [4,6]
    expect(findHighlightRanges("牛肉面配牛肉汤", ["牛肉", "牛肉面"])).toEqual([
      [0, 3],
      [4, 6],
    ]);
  });

  it("returns ranges sorted by start regardless of input order", () => {
    expect(findHighlightRanges("先汤后面", ["面", "汤"])).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("drops words not present, trims blanks, dedupes", () => {
    expect(findHighlightRanges("今天半价", ["不存在", "  ", "半价", "半价"])).toEqual([[2, 4]]);
  });

  it("no hits → empty array", () => {
    expect(findHighlightRanges("普通一句话", ["xyz"])).toEqual([]);
  });
});
