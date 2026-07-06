import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted lets the mock factory reference signOutMock safely.
const { signOutMock } = vi.hoisted(() => ({ signOutMock: vi.fn() }));
vi.mock("@/app/login/actions", () => ({
  signOutWithRevocation: signOutMock,
}));

import { Header } from "@/components/header";

describe("Header", () => {
  beforeEach(() => {
    signOutMock.mockReset();
    signOutMock.mockResolvedValue(undefined);
  });

  it("shows the signed-in user's email", () => {
    render(<Header email="owner@example.com" />);
    expect(screen.getByText("owner@example.com")).toBeInTheDocument();
  });

  it("calls signOutWithRevocation when the logout button is clicked", async () => {
    const user = userEvent.setup();
    render(<Header email="owner@example.com" />);

    await user.click(screen.getByRole("button", { name: /退出登录|退出/ }));

    expect(signOutMock).toHaveBeenCalledTimes(1);
  });

  it("disables the button and shows a pending state while signing out", async () => {
    const user = userEvent.setup();
    let resolveSignOut: () => void = () => {};
    signOutMock.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveSignOut = resolve; })
    );

    render(<Header email="owner@example.com" />);
    const button = screen.getByRole("button", { name: /退出登录|退出/ });
    await user.click(button);

    expect(button).toBeDisabled();
    resolveSignOut();
  });
});
