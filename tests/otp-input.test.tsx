import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { OtpInput, OTP_LENGTH } from "@/app/login/verify/otp-input";

describe("OtpInput", () => {
  it("renders 6 cells and an accessible hidden input", () => {
    render(<OtpInput value="" onChange={() => {}} />);
    expect(screen.getByLabelText("登录验证码")).toBeInTheDocument();
    expect(document.querySelectorAll(".otpCell")).toHaveLength(OTP_LENGTH);
  });

  it("filters non-digits and truncates to 6", () => {
    const onChange = vi.fn();
    render(<OtpInput value="" onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("登录验证码"), { target: { value: "12ab3456789" } });
    expect(onChange).toHaveBeenCalledWith("123456");
  });

  it("fires onComplete exactly when reaching 6 digits", () => {
    const onComplete = vi.fn();
    const { rerender } = render(
      <OtpInput value="12345" onChange={() => {}} onComplete={onComplete} />,
    );
    fireEvent.change(screen.getByLabelText("登录验证码"), { target: { value: "123456" } });
    expect(onComplete).toHaveBeenCalledWith("123456");
    rerender(<OtpInput value="123456" onChange={() => {}} onComplete={onComplete} />);
    fireEvent.change(screen.getByLabelText("登录验证码"), { target: { value: "123456" } });
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("renders filled cells from value (paste path)", () => {
    render(<OtpInput value="123456" onChange={() => {}} />);
    const cells = document.querySelectorAll(".otpCell");
    expect(cells[0].textContent).toBe("1");
    expect(cells[5].textContent).toBe("6");
  });
});
