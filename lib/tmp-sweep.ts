import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const STALE_PREFIXES = ["render-", "tts-", "voice-sample-"];

/**
 * 清扫残留临时目录（批次二资源治理）：只删 STALE_PREFIXES 开头且闲置超 maxAgeMs 的目录。
 * OOM SIGKILL 跳过 finally 时渲染目录会泄漏；重复 OOM 会静默填满小盘。
 */
export function sweepStaleTmpDirs(options: { maxAgeMs: number; now?: number; dir?: string }): { count: number; bytes: number } {
  const { maxAgeMs, now = Date.now(), dir = tmpdir() } = options;
  let count = 0;
  let bytes = 0;
  for (const name of readdirSync(dir)) {
    if (!STALE_PREFIXES.some((p) => name.startsWith(p))) continue;
    const full = join(dir, name);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue; // 清扫中途被并发删除等
    }
    if (!stat.isDirectory() || now - stat.mtimeMs < maxAgeMs) continue;
    try {
      rmSync(full, { recursive: true, force: true });
      count += 1;
      bytes += typeof stat.blocks === "number" ? stat.blocks * 512 : stat.size;
    } catch {
      // 删不掉留待下次（可能被占用）
    }
  }
  return { count, bytes };
}
