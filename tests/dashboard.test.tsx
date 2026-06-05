import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Dashboard } from "@/components/dashboard";

describe("AI video assistant dashboard", () => {
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
});
