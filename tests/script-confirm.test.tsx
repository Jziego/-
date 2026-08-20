import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ScriptConfirm } from "@/components/script-confirm";
import type { AvatarProfile, ScriptDraft } from "@/lib/types";

const draft: ScriptDraft = {
  id: "script_1", ownerId: "u", storeId: "s", purpose: "store_traffic", platform: "douyin",
  title: "t", hook: "h",
  scenes: [],
  voiceover: "阿姨手作面馆今天主推牛肉面，现熬牛骨汤。现在到店，直接报视频里的活动。",
  highlights: ["牛肉面", "现熬牛骨汤"],
  segments: [
    { index: 0, text: "阿姨手作面馆今天主推牛肉面，现熬牛骨汤。", speakerIndex: 0, onCamera: true },
    { index: 1, text: "现在到店，直接报视频里的活动。", speakerIndex: 0, onCamera: true },
  ],
  captions: [], cta: "c", generationMode: "ai", complianceWarnings: [],
  createdAt: "2026-08-19T00:00:00.000Z",
};

const avatars: AvatarProfile[] = [
  {
    id: "avatar_ready", ownerId: "u", storeId: "s", provider: "heygen",
    providerAvatarId: "x", consentAcceptedAt: "2026-08-01T00:00:00.000Z",
    trainingStatus: "ready", fallbackMode: "tts_voiceover",
    createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
  },
  {
    id: "avatar_training", ownerId: "u", storeId: "s", provider: "heygen",
    consentAcceptedAt: "2026-08-01T00:00:00.000Z",
    trainingStatus: "processing", fallbackMode: "tts_voiceover",
    createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
  },
];

const bgmTracks = [{ id: "bgm_upbeat_01", name: "欢快01", category: "general" }];

function renderConfirm(overrides: Partial<Parameters<typeof ScriptConfirm>[0]> = {}) {
  const onConfirm = vi.fn(async () => {});
  render(
    <ScriptConfirm
      draft={draft}
      avatars={avatars}
      bgmTracks={bgmTracks}
      librarySelectedAssetIds={["asset_a", "asset_b"]}
      onConfirm={onConfirm}
      pending={false}
      {...overrides}
    />,
  );
  return { onConfirm };
}

describe("ScriptConfirm", () => {
  it("renders the voiceover preview with active highlights marked yellow", () => {
    renderConfirm();
    expect(screen.getByText("牛肉面", { selector: "mark" })).toBeInTheDocument();
    expect(screen.getByText("现熬牛骨汤", { selector: "mark" })).toBeInTheDocument();
    // 编辑器里是完整口播稿
    expect(screen.getByLabelText("口播稿编辑")).toHaveValue(draft.voiceover);
  });

  it("defaults to the first ready avatar and confirms with the full library selection", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderConfirm();
    await user.click(screen.getByRole("button", { name: /确认生成/ }));
    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith({
        voiceover: draft.voiceover,
        selectedAssetIds: ["asset_a", "asset_b"],
        avatarProfileIds: ["avatar_ready"],
        subtitleStyle: "bold_bottom",
        bgmTrackId: "bgm_upbeat_01",
      });
    });
  });

  it("non-ready avatars are disabled; 不用数字人 confirms with empty avatarProfileIds", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderConfirm();
    expect(screen.getByLabelText(/AI 形象 2/)).toBeDisabled();
    await user.click(screen.getByLabelText(/不用数字人/));
    await user.click(screen.getByRole("button", { name: /确认生成/ }));
    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith(
        expect.objectContaining({ avatarProfileIds: [] }),
      );
    });
  });

  it("editing the voiceover drops stale highlight marks and confirms the edited text", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderConfirm();
    const editor = screen.getByLabelText("口播稿编辑");
    await user.clear(editor);
    await user.type(editor, "今天全场半价，欢迎光临。");
    // “牛肉面/现熬牛骨汤” 已不在稿中 → 预览无标黄
    expect(screen.queryByText("牛肉面", { selector: "mark" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /确认生成/ }));
    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith(
        expect.objectContaining({ voiceover: "今天全场半价，欢迎光临。" }),
      );
    });
  });

  it("offers a 无音乐 option that confirms with empty bgmTrackId", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderConfirm();
    await user.selectOptions(screen.getByLabelText(/背景音乐/), "");
    await user.click(screen.getByRole("button", { name: /确认生成/ }));
    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ bgmTrackId: "" }));
    });
  });

  it("disables confirm when the voiceover is empty", async () => {
    const user = userEvent.setup();
    renderConfirm();
    const editor = screen.getByLabelText("口播稿编辑");
    await user.clear(editor);
    expect(screen.getByRole("button", { name: /确认生成/ })).toBeDisabled();
  });
});
