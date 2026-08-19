/**
 * 找出 text 中所有标黄词命中区间：长词优先（避免“牛肉面”被“牛肉”截断）、
 * 跳过重叠、按起点升序。UI 预览与 ASS 包裹共用（DRY）。
 */
export function findHighlightRanges(text: string, words: string[]): Array<[number, number]> {
  const active = [...new Set(words.map((w) => w.trim()).filter(Boolean))]
    .filter((w) => text.includes(w))
    .sort((a, b) => b.length - a.length);

  const ranges: Array<[number, number]> = [];
  for (const word of active) {
    let from = 0;
    for (;;) {
      const start = text.indexOf(word, from);
      if (start === -1) break;
      const end = start + word.length;
      if (!ranges.some(([s, e]) => start < e && end > s)) {
        ranges.push([start, end]);
      }
      from = end;
    }
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}
