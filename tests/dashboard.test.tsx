import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { Dashboard } from "@/components/dashboard";

describe("AI video assistant dashboard", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("shows the four production modules in one SPA workspace", () => {
    render(<Dashboard />);

    expect(screen.getByRole("heading", { name: "门店建档" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "素材上传" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "数字人克隆" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "一键成片" })).toBeInTheDocument();
  });

  it("uses customer-friendly copy and the global stepper", () => {
    render(<Dashboard />);

    const stepper = screen.getByRole("navigation", { name: "全局步骤导航" });
    expect(within(stepper).getByText("门店建档")).toBeInTheDocument();
    expect(within(stepper).getByText("素材上传")).toBeInTheDocument();
    expect(within(stepper).getByText("数字人克隆")).toBeInTheDocument();
    expect(within(stepper).getByText("一键成片")).toBeInTheDocument();
    expect(screen.getByText("AI 自动写脚本、配音乐、加字幕，帮你生成门店引流短视频")).toBeInTheDocument();
    expect(screen.getByText("上传视频、图片或音频，AI 自动识别内容并打标签")).toBeInTheDocument();
    expect(screen.getByText("我已确认上传的视频为本人或已获得肖像/声音授权，同意生成数字人")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "请先完成门店建档" })).toBeDisabled();
  });

  it("keeps save and continue out of native form submission", () => {
    render(<Dashboard />);

    const saveAndContinue = screen.getByRole("button", { name: "保存并继续" });
    expect(saveAndContinue).toHaveAttribute("type", "button");
    expect(saveAndContinue.closest("form")).toHaveAttribute("novalidate");
  });

  it("prevents native form submit navigation", async () => {
    render(<Dashboard />);

    const form = screen.getByRole("button", { name: "保存并继续" }).closest("form");
    expect(form).not.toBeNull();

    const submitEvent = new Event("submit", { bubbles: true, cancelable: true });
    const submitWasNotCancelled = fireEvent(form as HTMLFormElement, submitEvent);

    expect(submitWasNotCancelled).toBe(false);
    expect(submitEvent.defaultPrevented).toBe(true);
    expect(await screen.findByText("2/3")).toBeInTheDocument();
  });

  it("persists the store profile step and draft values after continuing", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Dashboard />);

    await user.clear(screen.getByLabelText(/门店名称/));
    await user.type(screen.getByLabelText(/门店名称/), "测试小店");
    await user.click(screen.getByRole("button", { name: "保存并继续" }));

    expect(screen.getByText("2/3")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "产品与人设" })).toBeInTheDocument();

    unmount();
    render(<Dashboard />);

    expect(screen.getByText("2/3")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "产品与人设" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "上一步" }));
    expect(screen.getByLabelText(/门店名称/)).toHaveValue("测试小店");
  });

  it("shows a clear validation message when a required field is missing", async () => {
    const user = userEvent.setup();
    render(<Dashboard />);

    await user.clear(screen.getByLabelText(/门店名称/));
    await user.click(screen.getByRole("button", { name: "保存并继续" }));

    expect(screen.getByText("请填写门店名称")).toBeInTheDocument();
    expect(within(screen.getByRole("status")).getByText("请先填写门店名称。")).toBeInTheDocument();
    expect(screen.getByText("1/3")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "基础信息" })).toBeInTheDocument();
  });

  it("validates only the current step when continuing", async () => {
    const user = userEvent.setup();
    render(<Dashboard />);

    await user.click(screen.getByRole("button", { name: "保存并继续" }));
    expect(screen.getByText("2/3")).toBeInTheDocument();

    await user.clear(screen.getByLabelText(/主营产品/));
    await user.click(screen.getByRole("button", { name: "保存并继续" }));

    expect(screen.getByText("请填写主营产品")).toBeInTheDocument();
    expect(within(screen.getByRole("status")).getByText("请先填写主营产品。")).toBeInTheDocument();
    expect(screen.getByText("2/3")).toBeInTheDocument();
  });
});
