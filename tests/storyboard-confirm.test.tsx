import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { StoryboardConfirm } from "@/components/storyboard-confirm";
import type { Asset, ScriptDraft } from "@/lib/types";

const draft: ScriptDraft = {
  id: "script_1", ownerId: "u", storeId: "s", purpose: "store_traffic", platform: "douyin",
  title: "t", hook: "h",
  scenes: [
    { order: 1, text: "镜1原文", durationSeconds: 4, assetHints: ["招牌"], role: "presenter", matchedAssetId: "asset_a", matchTag: "招牌" },
    { order: 2, text: "镜2原文", durationSeconds: 5, assetHints: ["产品"], role: "broll", matchedAssetId: null },
  ],
  voiceover: "v", captions: [], cta: "c", generationMode: "ai", complianceWarnings: [],
  createdAt: "2026-07-23T00:00:00.000Z",
};

const assets: Asset[] = [
  { id: "asset_a", ownerId: "u", storeId: "s", type: "image", originalFilename: "a.jpg", storageKey: "k", mimeType: "image/jpeg", sizeBytes: 1, tags: [], businessTags: [], status: "ready", createdAt: "2026-07-23T00:00:00.000Z" },
  { id: "asset_b", ownerId: "u", storeId: "s", type: "image", originalFilename: "b.jpg", storageKey: "k", mimeType: "image/jpeg", sizeBytes: 1, tags: [], businessTags: [], status: "ready", createdAt: "2026-07-23T00:00:00.000Z" },
];

const bgmTracks = [
  { id: "bgm_upbeat_01", name: "欢快01", category: "general", durationSeconds: 30 },
];

function renderConfirm(overrides: Partial<Parameters<typeof StoryboardConfirm>[0]> = {}) {
  const onPatch = vi.fn(async () => {});
  const onConfirm = vi.fn(async () => {});
  render(
    <StoryboardConfirm
      draft={draft}
      assets={assets}
      bgmTracks={bgmTracks}
      onPatch={onPatch}
      onConfirm={onConfirm}
      pending={false}
      {...overrides}
    />,
  );
  return { onPatch, onConfirm };
}

describe("StoryboardConfirm", () => {
  it("renders all scenes with matched/待匹配 state", () => {
    renderConfirm();
    expect(screen.getByText("镜1原文")).toBeInTheDocument();
    expect(screen.getByText("镜2原文")).toBeInTheDocument();
    expect(screen.getByText(/待匹配/)).toBeInTheDocument();
  });

  it("patches text on blur", async () => {
    const user = userEvent.setup();
    const { onPatch } = renderConfirm();
    const input = screen.getByDisplayValue("镜1原文");
    await user.clear(input);
    await user.type(input, "改后文案");
    await user.tab(); // blur → PATCH
    await waitFor(() => {
      expect(onPatch).toHaveBeenCalledWith([
        expect.objectContaining({ order: 1, text: "改后文案" }),
      ]);
    });
  });

  it("confirms render with selected asset ids derived from scenes", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderConfirm();
    await user.click(screen.getByRole("button", { name: /确认渲染/ }));
    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith(
        expect.objectContaining({ selectedAssetIds: expect.arrayContaining(["asset_a"]) }),
      );
    });
  });

  it("swaps asset via picker, patches matchedAssetId, and shows 已选 after swap", async () => {
    const user = userEvent.setup();
    const { onPatch } = renderConfirm();
    // scene 1 initially matched asset_a with matchTag 招牌
    expect(screen.getByText(/招牌/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "换素材" }));
    await user.click(screen.getByRole("button", { name: "b.jpg" }));
    await waitFor(() => {
      expect(onPatch).toHaveBeenCalledWith([expect.objectContaining({ order: 1, matchedAssetId: "asset_b" })]);
    });
    // swapped → shows 已选 instead of stale 招牌
    expect(screen.getByText(/已选/)).toBeInTheDocument();
  });

  it("clearing a match sets matchedAssetId null and shows 待匹配", async () => {
    const user = userEvent.setup();
    const { onPatch } = renderConfirm();
    await user.click(screen.getByRole("button", { name: "换素材" }));
    await user.click(screen.getByRole("button", { name: "清除" }));
    await waitFor(() => {
      expect(onPatch).toHaveBeenCalledWith([expect.objectContaining({ order: 1, matchedAssetId: null })]);
    });
    // scene 1 cleared → now two rows 待匹配 (scene 2 was always 待匹配)
    expect(screen.getAllByText(/待匹配/)).toHaveLength(2);
  });
});
