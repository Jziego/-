import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

const makeAvatar = (
  id: string,
  name: string,
  trainingStatus: AvatarProfile["trainingStatus"] = "ready",
): AvatarProfile => ({
  id, ownerId: "u", storeId: "s", name, provider: "heygen",
  providerAvatarId: "x", consentStatus: "approved", consentAcceptedAt: "2026-08-01T00:00:00.000Z",
  trainingStatus, fallbackMode: "tts_voiceover",
  createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
});

const avatars: AvatarProfile[] = [
  makeAvatar("avatar_ready", "店长形象"),
  makeAvatar("avatar_training", "新形象", "processing"),
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

  it("defaults to the first ready avatar checked; confirms with it", async () => {
    const user = userEvent.setup();
    const twoReady = [makeAvatar("avatar_a", "形象甲"), makeAvatar("avatar_b", "形象乙")];
    const { onConfirm } = renderConfirm({ avatars: twoReady });
    expect(screen.getByLabelText(/形象甲/)).toBeChecked();
    expect(screen.getByLabelText(/形象乙/)).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: /确认生成/ }));
    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith({
        voiceover: draft.voiceover,
        selectedAssetIds: ["asset_a", "asset_b"],
        avatarProfileIds: ["avatar_a"],
        subtitleStyle: "bold_bottom",
        bgmTrackId: "bgm_upbeat_01",
      });
    });
  });

  it("multiple avatars can be checked up to 3; the 4th checkbox stays disabled", async () => {
    const user = userEvent.setup();
    const four = [
      makeAvatar("avatar_1", "形象一"),
      makeAvatar("avatar_2", "形象二"),
      makeAvatar("avatar_3", "形象三"),
      makeAvatar("avatar_4", "形象四"),
    ];
    renderConfirm({ avatars: four });
    // 默认已勾选第一个 ready 形象
    expect(screen.getByLabelText(/形象一/)).toBeChecked();
    await user.click(screen.getByLabelText(/形象二/));
    await user.click(screen.getByLabelText(/形象三/));
    expect(screen.getByLabelText(/形象一/)).toBeChecked();
    expect(screen.getByLabelText(/形象二/)).toBeChecked();
    expect(screen.getByLabelText(/形象三/)).toBeChecked();
    // 已达上限 3 → 第 4 个不可再勾
    expect(screen.getByLabelText(/形象四/)).toBeDisabled();
  });

  it("unchecking all avatars confirms with empty avatarProfileIds (asset_only)", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderConfirm();
    await user.click(screen.getByLabelText(/店长形象/));
    expect(screen.getByLabelText(/店长形象/)).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: /确认生成/ }));
    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith(
        expect.objectContaining({ avatarProfileIds: [] }),
      );
    });
  });

  it("shows the estimated cost line when at least one avatar is checked", async () => {
    const user = userEvent.setup();
    renderConfirm();
    // 草稿两段出镜：19 字 → 4s、14 字 → 3s（4.5 字/s，下限 3s），共 7s × $0.0667 ≈ $0.47
    const costLine = screen.getByLabelText("成本预估");
    expect(costLine).toHaveTextContent(/预计数字人成本约 \$0\.47（出镜 7s \+ 画外音 0s/);
    // 取消全部勾选 → 纯素材成片，无数字人成本，成本行消失
    await user.click(screen.getByLabelText(/店长形象/));
    expect(screen.queryByText(/预计数字人成本/)).not.toBeInTheDocument();
  });

  it("re-estimates the cost from the live edited voiceover, not the stale draft segments", async () => {
    const user = userEvent.setup();
    renderConfirm();
    expect(screen.getByLabelText("成本预估")).toHaveTextContent(/\$0\.47/);
    const editor = screen.getByLabelText("口播稿编辑");
    await user.clear(editor);
    // 45 字单句（无 AI 出镜选择时首/末句默认出镜）→ 10s × $0.0667 ≈ $0.67
    fireEvent.change(editor, { target: { value: "一".repeat(45) } });
    const costLine = screen.getByLabelText("成本预估");
    expect(costLine).toHaveTextContent(/\$0\.67/);
    expect(costLine).toHaveTextContent(/出镜 10s/);
  });

  it("platform avatar label renders its name once, without a duplicated suffix", () => {
    renderConfirm({ avatars: [makeAvatar("avatar_platform", "平台公共形象")] });
    const checkbox = screen.getByLabelText("平台公共形象");
    expect(checkbox.closest("label")).toHaveTextContent(/^平台公共形象$/);
  });

  it("non-ready avatars are disabled and labeled 不可用", () => {
    renderConfirm();
    const checkbox = screen.getByLabelText(/新形象/);
    expect(checkbox).toBeDisabled();
    expect(checkbox.closest("label")).toHaveTextContent("不可用");
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

  it("caps the voiceover editor at 2000 chars and shows the cap in the meta line", () => {
    renderConfirm();
    expect(screen.getByLabelText("口播稿编辑")).toHaveAttribute("maxLength", "2000");
    expect(screen.getByText(/约 \d+ \/ 2000 字 · 预计 \d+s/)).toBeInTheDocument();
  });
});
