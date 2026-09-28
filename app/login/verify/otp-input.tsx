"use client";

import { useRef, useState } from "react";

/**
 * OTP 6 格分格输入：单透明 input 覆盖 + 视觉格层。
 * 选此方案（而非 6 个独立 input）因为：粘贴拆分、iOS one-time-code 自动
 * 填充、移动端数字键盘、退格导航全部天然正确，无需自管 focus 跳转。
 */
export const OTP_LENGTH = 6;

export function OtpInput({
  value,
  onChange,
  onComplete,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  onComplete?: (value: string) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);

  function handleChange(raw: string) {
    const next = raw.replace(/\D/g, "").slice(0, OTP_LENGTH);
    onChange(next);
    if (next.length === OTP_LENGTH && next !== value) {
      onComplete?.(next);
    }
  }

  return (
    <div className="otpWrap" onClick={() => inputRef.current?.focus()}>
      <input
        ref={inputRef}
        className="otpHiddenInput"
        inputMode="numeric"
        autoComplete="one-time-code"
        aria-label="登录验证码"
        value={value}
        disabled={disabled}
        autoFocus
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) => handleChange(e.target.value)}
      />
      {Array.from({ length: OTP_LENGTH }, (_, i) => {
        const filled = i < value.length;
        const active =
          focused && !disabled && i === Math.min(value.length, OTP_LENGTH - 1);
        return (
          <div
            key={i}
            aria-hidden
            className={`otpCell${filled ? " otpCellFilled" : ""}${active ? " otpCellActive" : ""}`}
          >
            {filled ? value[i] : active ? <span className="otpCaret" /> : ""}
          </div>
        );
      })}
    </div>
  );
}
