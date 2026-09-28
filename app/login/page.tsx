"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { sendMagicLink, signInWithWeChat } from "./actions";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // OTP 校验失败时 NextAuth 回跳 /login?error=Verification
  const verifyFailed = searchParams.get("error") === "Verification";
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await sendMagicLink(email);
    } catch {
      setMessage("发送失败，请稍后重试");
      setLoading(false);
      return;
    }
    // 仅发送成功后才跳验证码页；导航失败不再误报"发送失败"
    router.push(`/login/verify?email=${encodeURIComponent(email)}`);
  }

  return (
    <main className="authPage">
      <div className="ambientGlow" aria-hidden />
      <div className="authHero">
        <p className="eyebrow">AI 短视频助手</p>
        <h1>让每家店都有自己的数字人口播</h1>
        <span className="authHeroRule" aria-hidden />
      </div>

      <form onSubmit={handleSubmit} className="authCard authForm">
        {verifyFailed && (
          <div className="authError" role="alert">
            验证码错误或已过期，请重新获取
          </div>
        )}
        {message && (
          <div className="authError" role="alert">
            {message}
          </div>
        )}

        <label className="field">
          <span>邮箱地址</span>
          <input
            id="email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            disabled={loading}
          />
        </label>

        <button
          type="submit"
          disabled={loading || !email}
          className="primaryButton"
        >
          {loading ? "发送中..." : "发送验证码"}
        </button>

        <div className="authDivider">
          <span>其他登录方式</span>
        </div>

        <button
          type="button"
          onClick={() => signInWithWeChat()}
          className="secondaryButton authWechatButton"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="#07C160" aria-hidden>
            <path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 10.436 7.17c0-.651.52-1.18 1.162-1.18z" />
          </svg>
          微信登录
        </button>
      </form>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="authPage" />}>
      <LoginForm />
    </Suspense>
  );
}
