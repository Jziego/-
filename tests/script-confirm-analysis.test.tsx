import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ScriptConfirm } from "@/components/script-confirm";
import type { ScriptDraft } from "@/lib/types";
import { nowIso } from "@/lib/ids";

function makeDraft(overrides: Partial<ScriptDraft> = {}): ScriptDraft {
  return {
    id: "script_1", ownerId: "demo", storeId: "store_1",
    purpose: "store_traffic", platform: "douyin",
    title: "标题", hook: "钩子", scenes: [],
    voiceover: "口播稿第一句。口播稿第二句。",
    captions: [], cta: "到店", generationMode: "ai", complianceWarnings: [],
    createdAt: nowIso(),
    ...overrides,
  };
}

const baseProps = {
  avatars: [], bgmTracks: [], librarySelectedAssetIds: [],
  onConfirm: async () => {}, pending: false,
};

describe("文案解析折叠区", () => {
  it("draft.analysis 存在时渲染折叠区，含三段文本", () => {
    render(
      <ScriptConfirm
        {...baseProps}
        draft={makeDraft({
          angle: "痛点暴击",
          analysis: { overview: "这是概述", principles: "这是原则解析", structure: "这是结构解析" },
        })}
      />,
    );
    expect(screen.getByText("查看创作解析")).toBeTruthy();
    expect(screen.getByText("这是概述")).toBeTruthy();
    expect(screen.getByText("这是原则解析")).toBeTruthy();
    expect(screen.getByText("这是结构解析")).toBeTruthy();
  });

  it("analysis 缺失时不渲染折叠区", () => {
    render(<ScriptConfirm {...baseProps} draft={makeDraft()} />);
    expect(screen.queryByText("查看创作解析")).toBeNull();
  });
});

describe("换个表达方向", () => {
  it("点击触发 onChangeAngle，按钮显示当前角度", () => {
    const onChangeAngle = vi.fn();
    render(
      <ScriptConfirm {...baseProps} draft={makeDraft({ angle: "痛点暴击" })} onChangeAngle={onChangeAngle} />,
    );
    const btn = screen.getByRole("button", { name: /换个表达方向/ });
    expect(btn.textContent).toContain("痛点暴击");
    fireEvent.click(btn);
    expect(onChangeAngle).toHaveBeenCalledTimes(1);
  });

  it("未提供 onChangeAngle 时不渲染按钮（模板兜底稿等场景）", () => {
    render(<ScriptConfirm {...baseProps} draft={makeDraft()} />);
    expect(screen.queryByRole("button", { name: /换个表达方向/ })).toBeNull();
  });
});
