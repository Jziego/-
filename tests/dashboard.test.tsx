import { render, screen } from "@testing-library/react";
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

  it("explains which module work is local and which requires backend or third-party APIs", () => {
    render(<Dashboard />);

    expect(screen.getByText("本地草稿 + 服务端同步")).toBeInTheDocument();
    expect(screen.getByText("对象存储直传 + 自动标签队列")).toBeInTheDocument();
    expect(screen.getByText("第三方数字人 API + TTS 降级")).toBeInTheDocument();
    expect(screen.getByText("后端渲染 Worker + 字幕/BGM")).toBeInTheDocument();
  });
});
