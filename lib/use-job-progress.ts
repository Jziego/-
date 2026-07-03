"use client";

import { useEffect, useRef, useState } from "react";
import type { Job, JobStatus } from "@/lib/types";

interface JobProgressState {
  status: JobStatus;
  progress: number;
  error?: string;
}

/**
 * Subscribe to SSE job progress updates for active (queued/processing) jobs.
 * Returns a map of jobId → { status, progress, error } updated in real-time.
 * Automatically closes connections when jobs reach terminal states.
 */
export function useJobProgressSSE(
  jobs: Pick<Job, "id" | "status" | "progress" | "error">[]
): Map<string, JobProgressState> {
  const [progressMap, setProgressMap] = useState<Map<string, JobProgressState>>(() => {
    // Seed local state from current job data on mount (lazy initializer avoids
    // a synchronous setState-in-effect that would trigger cascading renders).
    const next = new Map<string, JobProgressState>();
    for (const job of jobs) {
      if (
        job.status === "queued" ||
        job.status === "processing" ||
        job.status === "completed" ||
        job.status === "failed"
      ) {
        next.set(job.id, {
          status: job.status as JobStatus,
          progress: job.progress,
          error: job.error
        });
      }
    }
    return next;
  });
  const sourcesRef = useRef<Map<string, EventSource>>(new Map());
  const activeIds = jobs
    .filter((j) => j.status === "queued" || j.status === "processing")
    .map((j) => j.id);

  useEffect(() => {
    const currentSources = sourcesRef.current;
    const activeIdSet = new Set(activeIds);

    // Clean up sources for jobs that are no longer active
    for (const [id, source] of currentSources) {
      if (!activeIdSet.has(id)) {
        source.close();
        currentSources.delete(id);
      }
    }

    // Open new sources for active jobs that don't have one yet
    for (const id of activeIds) {
      if (currentSources.has(id)) continue;

      let source: EventSource | null = null;

      try {
        source = new EventSource(`/api/jobs/${encodeURIComponent(id)}/progress`);

        source.addEventListener("status", (event: MessageEvent) => {
          const data = JSON.parse(event.data) as {
            jobId: string;
            status: JobStatus;
            progress: number;
            error?: string;
          };
          setProgressMap((prev) => {
            const updated = new Map(prev);
            updated.set(data.jobId, {
              status: data.status,
              progress: data.progress,
              error: data.error
            });
            return updated;
          });

          // Auto-close on terminal status
          if (data.status === "completed" || data.status === "failed") {
            source?.close();
            currentSources.delete(id);
          }
        });

        source.addEventListener("progress", (event: MessageEvent) => {
          const data = JSON.parse(event.data) as { jobId: string; progress: number };
          setProgressMap((prev) => {
            const updated = new Map(prev);
            const existing = updated.get(data.jobId);
            if (existing) {
              updated.set(data.jobId, { ...existing, progress: data.progress });
            }
            return updated;
          });
        });

        source.addEventListener("done", () => {
          source?.close();
          currentSources.delete(id);
        });

        source.addEventListener("error", () => {
          // EventSource will auto-reconnect; if it keeps failing, clean up after a delay
          setTimeout(() => {
            if (source && source.readyState === EventSource.CLOSED) {
              currentSources.delete(id);
            }
          }, 10_000);
        });

        currentSources.set(id, source);
      } catch {
        // EventSource constructor failed — SSE not supported, polling will handle it
        if (source) {
          source.close();
        }
      }
    }

    return () => {
      // Cleanup all sources on unmount
      for (const [, s] of currentSources) {
        s.close();
      }
      currentSources.clear();
    };
  }, [activeIds.join(",")]);

  return progressMap;
}
