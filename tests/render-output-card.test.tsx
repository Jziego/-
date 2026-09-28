import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { VideoOutputCard } from "@/components/video-output-card";
import type { VideoOutput } from "@/lib/types";

vi.mock("@/lib/api-client", () => ({
  fetchVideoOutputUrl: vi.fn(async () => "https://cdn.example.com/out_1.mp4"),
  deleteVideoOutputApi: vi.fn(async () => {}),
}));

import { deleteVideoOutputApi } from "@/lib/api-client";

function sampleOutput(overrides: Partial<VideoOutput> = {}): VideoOutput {
  return {
    id: "out_1",
    ownerId: "demo_user",
    renderProjectId: null,
    storageKey: "outputs/out_1.mp4",
    aspectRatio: "9:16",
    durationSeconds: 45,
    kind: "talking_head",
    status: "ready",
    createdAt: "2026-09-27T06:32:00.000Z",
    ...overrides,
  };
}

function renderCard(output: VideoOutput) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <VideoOutputCard output={output} />
    </QueryClientProvider>,
  );
}

describe("VideoOutputCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows kind label, formatted date and duration", async () => {
    renderCard(sampleOutput());
    expect(await screen.findByText("口播成片")).toBeTruthy();
    expect(screen.getByText(/45s/)).toBeTruthy();
    expect(screen.getByText(/\d{2}-\d{2}/)).toBeTruthy(); // 放宽：不依赖本地时区的具体日期
  });

  it("deletes after confirm and calls the delete API", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderCard(sampleOutput());

    fireEvent.click(await screen.findByRole("button", { name: /删除成片 out_1/ }));

    await waitFor(() => expect(deleteVideoOutputApi).toHaveBeenCalledWith("out_1"));
  });

  it("does not delete when confirm is cancelled", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    renderCard(sampleOutput());

    fireEvent.click(await screen.findByRole("button", { name: /删除成片 out_1/ }));

    // Await a tick so a future async mutate would have fired before we assert.
    await waitFor(() => expect(deleteVideoOutputApi).not.toHaveBeenCalled());
  });
});
