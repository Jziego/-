import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getWorkerConcurrency } from "@/lib/env";
import { sweepStaleTmpDirs } from "@/lib/tmp-sweep";

describe("getWorkerConcurrency", () => {
  const original = process.env.WORKER_CONCURRENCY;
  afterEach(() => {
    if (original === undefined) delete process.env.WORKER_CONCURRENCY;
    else process.env.WORKER_CONCURRENCY = original;
  });

  it("重队列默认 1，其余默认 2", () => {
    delete process.env.WORKER_CONCURRENCY;
    expect(getWorkerConcurrency("video_render")).toBe(1);
    expect(getWorkerConcurrency("subtitle_generation")).toBe(1);
    expect(getWorkerConcurrency("talking_head")).toBe(2);
    expect(getWorkerConcurrency("asset_analysis")).toBe(2);
  });

  it("WORKER_CONCURRENCY 全局覆盖（含非法值回退默认）", () => {
    process.env.WORKER_CONCURRENCY = "3";
    expect(getWorkerConcurrency("video_render")).toBe(3);
    process.env.WORKER_CONCURRENCY = "abc";
    expect(getWorkerConcurrency("video_render")).toBe(1);
    delete process.env.WORKER_CONCURRENCY;
  });
});

describe("sweepStaleTmpDirs", () => {
  it("删除超时匹配前缀目录，保留新近目录与其他目录", () => {
    const dir = mkdtempSync(join(tmpdir(), "sweep-test-"));
    const now = Date.now();
    const old = join(dir, "render-old");
    const fresh = join(dir, "render-fresh");
    const foreign = join(dir, "other-old");
    mkdirSync(old);
    mkdirSync(fresh);
    mkdirSync(foreign);
    writeFileSync(join(old, "a.mp4"), "x");
    // 回拨 mtime：旧目录 7 小时前（超 6h 阈值），外来目录同样 7 小时前
    const hoursAgo = (h: number) => new Date(now - h * 3600_000);
    utimesSync(old, hoursAgo(7), hoursAgo(7));
    utimesSync(foreign, hoursAgo(7), hoursAgo(7));

    const result = sweepStaleTmpDirs({ maxAgeMs: 6 * 3600_000, now, dir });
    expect(result.count).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(foreign)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
