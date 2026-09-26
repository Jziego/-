import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { StoreFieldCandidates } from "@/components/store-field-candidates";

const baseProps = {
  label: "门店的主营业务",
  items: ["短视频代运营"],
  max: 10,
  candidates: ["同城引流", "团购套餐设计"],
  loading: false,
  onAdd: vi.fn(),
  onRemove: vi.fn(),
  onRefreshCandidates: vi.fn(),
};

describe("StoreFieldCandidates", () => {
  it("渲染已填条目（带计数）与候选池", () => {
    render(<StoreFieldCandidates {...baseProps} />);
    expect(screen.getByText("短视频代运营")).toBeTruthy();
    expect(screen.getByText(/1\/10/)).toBeTruthy();
    expect(screen.getByText("同城引流")).toBeTruthy();
    expect(screen.getByText("团购套餐设计")).toBeTruthy();
  });

  it("点「填入」回调 onAdd；点删除回调 onRemove", () => {
    const onAdd = vi.fn();
    const onRemove = vi.fn();
    render(<StoreFieldCandidates {...baseProps} onAdd={onAdd} onRemove={onRemove} />);
    fireEvent.click(screen.getByRole("button", { name: "填入 同城引流" }));
    expect(onAdd).toHaveBeenCalledWith("同城引流");
    fireEvent.click(screen.getByRole("button", { name: "删除 短视频代运营" }));
    expect(onRemove).toHaveBeenCalledWith(0);
  });

  it("手动输入添加", () => {
    const onAdd = vi.fn();
    render(<StoreFieldCandidates {...baseProps} onAdd={onAdd} />);
    fireEvent.change(screen.getByPlaceholderText("手动输入后回车添加"), { target: { value: "新条目" } });
    fireEvent.keyDown(screen.getByPlaceholderText("手动输入后回车添加"), { key: "Enter" });
    expect(onAdd).toHaveBeenCalledWith("新条目");
  });

  it("达上限时填入与添加禁用并提示", () => {
    render(
      <StoreFieldCandidates
        {...baseProps}
        items={Array.from({ length: 10 }, (_, i) => `条目${i}`)}
      />,
    );
    expect(screen.getByText(/已达上限/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "填入 同城引流" })).toHaveProperty("disabled", true);
    expect(screen.getByPlaceholderText("手动输入后回车添加")).toHaveProperty("disabled", true);
  });

  it("已在列表中的候选不重复展示填入", () => {
    render(<StoreFieldCandidates {...baseProps} candidates={["短视频代运营", "同城引流"]} />);
    expect(screen.queryByRole("button", { name: "填入 短视频代运营" })).toBeNull();
    expect(screen.getByRole("button", { name: "填入 同城引流" })).toBeTruthy();
  });

  it("重新生成一批回调", () => {
    const onRefresh = vi.fn();
    render(<StoreFieldCandidates {...baseProps} onRefreshCandidates={onRefresh} />);
    fireEvent.click(screen.getByRole("button", { name: /重新生成一批/ }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
