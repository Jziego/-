import { getJobRepository } from "@/lib/repositories";
import { getOwnerId } from "@/lib/auth-helpers";

/**
 * GET /api/jobs/[id]/progress — SSE stream of job status changes.
 *
 * The client opens an EventSource connection. The server polls the job
 * repository every 1 second and pushes status changes as SSE events.
 * When the job reaches a terminal state (completed/failed), the stream closes.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params;
  const ownerId = await getOwnerId();

  const job = await getJobRepository().findById(id);
  // IDOR guard: must run before the stream is opened. Missing and foreign
  // both resolve to 404 so existence is not leaked.
  if (!job || job.ownerId !== ownerId) {
    return new Response(JSON.stringify({ error: "Job not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" }
    });
  }

  // If job is already in a terminal state, return immediately
  if (job.status === "completed" || job.status === "failed") {
    const body = formatSSE("status", {
      jobId: job.id,
      status: job.status,
      progress: job.progress,
      error: job.error
    });
    return new Response(body + "event: done\ndata: {}\n\n", {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive"
      }
    });
  }

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      let lastStatus = job.status;
      let lastProgress = job.progress;
      let pollCount = 0;
      const MAX_POLLS = 300; // 5 minutes max at 1s interval

      // Send initial state
      controller.enqueue(
        encoder.encode(
          formatSSE("status", {
            jobId: job.id,
            status: job.status,
            progress: job.progress,
            error: job.error
          })
        )
      );

      const interval = setInterval(async () => {
        pollCount++;
        try {
          const current = await getJobRepository().findById(id);

          if (!current) {
            controller.enqueue(
              encoder.encode(formatSSE("error", { message: "Job not found" }))
            );
            controller.enqueue(encoder.encode("event: done\ndata: {}\n\n"));
            clearInterval(interval);
            controller.close();
            return;
          }

          // Push status change
          if (current.status !== lastStatus) {
            lastStatus = current.status;
            controller.enqueue(
              encoder.encode(
                formatSSE("status", {
                  jobId: current.id,
                  status: current.status,
                  progress: current.progress,
                  error: current.error
                })
              )
            );
          }

          // Push progress updates (throttled — only when progress changes by >= 5%)
          if (current.progress - lastProgress >= 5) {
            lastProgress = current.progress;
            controller.enqueue(
              encoder.encode(
                formatSSE("progress", {
                  jobId: current.id,
                  progress: current.progress
                })
              )
            );
          }

          // Terminal state — close stream
          if (current.status === "completed" || current.status === "failed") {
            controller.enqueue(
              encoder.encode(
                formatSSE("status", {
                  jobId: current.id,
                  status: current.status,
                  progress: current.progress,
                  error: current.error
                })
              )
            );
            controller.enqueue(encoder.encode("event: done\ndata: {}\n\n"));
            clearInterval(interval);
            controller.close();
          }

          // Timeout — prevent hanging streams
          if (pollCount >= MAX_POLLS) {
            controller.enqueue(
              encoder.encode(
                formatSSE("timeout", {
                  jobId: id,
                  message: "Polling timeout reached"
                })
              )
            );
            controller.enqueue(encoder.encode("event: done\ndata: {}\n\n"));
            clearInterval(interval);
            controller.close();
          }
        } catch {
          controller.enqueue(
            encoder.encode(
              formatSSE("error", { message: "Failed to fetch job status" })
            )
          );
        }
      }, 1000);

      // Clean up on client disconnect
      _request.signal.addEventListener("abort", () => {
        clearInterval(interval);
        controller.close();
      });
    }
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    }
  });
}

function formatSSE(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
