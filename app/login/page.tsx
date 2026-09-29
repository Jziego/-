"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { sendMagicLink } from "./actions";

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
