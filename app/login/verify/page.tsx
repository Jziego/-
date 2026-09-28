"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { sendMagicLink } from "../actions";
import { OtpInput } from "./otp-input";
import { buildOtpCallbackUrl } from "./otp-callback";

function VerifyContent() {
  const searchParams = useSearchParams();
  const email = searchParams.get("email") ?? "";
  const [code, setCode] = useState("");
  const [resendCooldown, setResendCooldown] = useState(0);
  const [resendError, setResendError] = useState(false);

  // useEffect 驱动倒计时（替代裸 setInterval）：组件卸载自动清理，无泄漏。
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = setTimeout(() => setResendCooldown((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendCooldown]);

  function submit(finalCode: string) {
    // 整页跳转交给浏览器：NextAuth 校验成功 302 到 callbackUrl（/），失败回
    // /login?error=Verification（pages.signIn）——session cookie 随响应落盘。
    window.location.assign(buildOtpCallbackUrl(email, finalCode));
  }

  async function resend() {
    if (resendCooldown > 0 || !email) return;
    setResendError(false);
    try {
      await sendMagicLink(email);
    } catch {
      // 发送失败：提示用户且不计冷却，允许立即重试
      setResendError(true);
      return;
    }
    setResendCooldown(60);
  }

  return (
    <main className="authPage">
      <div className="ambientGlow" aria-hidden />
      <div className="authCard">
        <div className="authCardHeader">
          <h1>输入登录验证码</h1>
          <p>
            若邮箱 <strong>{email || "已注册"}</strong> 存在，验证码已发送（10 分钟内有效）
          </p>
        </div>

        {email ? (
          <div className="authForm">
            <OtpInput value={code} onChange={setCode} onComplete={submit} />

            <button
              type="button"
              onClick={() => submit(code)}
              disabled={code.length !== 6}
              className="primaryButton"
            >
              登录
            </button>

            {resendError && (
              <div className="authError" role="alert">
                发送失败，请稍后重试
              </div>
            )}

            <div className="authLinks">
              <button
                type="button"
                onClick={() => void resend()}
                disabled={resendCooldown > 0}
                className="authLinkButton"
              >
                {resendCooldown > 0 ? `重新发送（${resendCooldown}s）` : "重新发送"}
              </button>
              <a href="/login" className="authLink">
                更换邮箱
              </a>
            </div>
          </div>
        ) : (
          <div className="authForm authFallback">
            <p>缺少邮箱参数，请重新发起登录。</p>
            <a href="/login" className="authLink">
              ← 返回登录
            </a>
          </div>
        )}
      </div>
    </main>
  );
}

export default function VerifyPage() {
  return (
    <Suspense fallback={<div className="authPage" />}>
      <VerifyContent />
    </Suspense>
  );
}
