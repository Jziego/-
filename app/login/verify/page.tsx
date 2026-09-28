"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { sendMagicLink } from "../actions";

function VerifyContent() {
  const searchParams = useSearchParams();
  const email = searchParams.get("email") ?? "";
  const [code, setCode] = useState("");
  const [resendCooldown, setResendCooldown] = useState(0);
  const [resendError, setResendError] = useState(false);

  function submit() {
    // 整页跳转交给浏览器：NextAuth 校验成功 302 到 callbackUrl（/），失败回
    // /login?error=Verification（pages.signIn）——session cookie 随响应落盘，
    // 无需 fetch 处理重定向。
    const params = new URLSearchParams({ email, token: code, callbackUrl: "/" });
    window.location.assign(`/api/auth/callback/email?${params.toString()}`);
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
    const timer = setInterval(() => {
      setResendCooldown((s) => {
        if (s <= 1) {
          clearInterval(timer);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-[#0a0a0a] px-4">
      <div className="w-full max-w-md bg-neutral-900 border border-neutral-800 rounded-2xl shadow-lg p-8 space-y-6">
        <div className="text-center">
          <div className="text-4xl">📧</div>
          <h1 className="mt-2 text-2xl font-bold text-neutral-50">输入登录验证码</h1>
          <p className="mt-2 text-sm text-neutral-400">
            若邮箱 <span className="font-medium text-neutral-200">{email || "已注册"}</span> 存在，验证码已发送（10 分钟内有效）
          </p>
        </div>

        {email ? (
          <>
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              aria-label="登录验证码"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              placeholder="6 位验证码"
              className="w-full px-4 py-3 text-center text-2xl tracking-[0.5em] bg-neutral-950 border border-neutral-700 rounded-lg text-neutral-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />

            <button
              type="button"
              onClick={submit}
              disabled={code.length !== 6}
              className="w-full py-3 px-4 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              登录
            </button>

            {resendError && (
              <div className="bg-red-950 border border-red-800 text-red-300 rounded-lg p-3 text-sm">
                发送失败，请稍后重试
              </div>
            )}

            <div className="flex items-center justify-between text-sm">
              <button
                type="button"
                onClick={() => void resend()}
                disabled={resendCooldown > 0}
                className="text-blue-400 hover:underline disabled:text-neutral-600 disabled:no-underline"
              >
                {resendCooldown > 0 ? `重新发送（${resendCooldown}s）` : "重新发送"}
              </button>
              <a href="/login" className="text-neutral-400 hover:underline">
                更换邮箱
              </a>
            </div>
          </>
        ) : (
          <div className="text-center">
            <p className="text-sm text-neutral-400">缺少邮箱参数，请重新发起登录。</p>
            <a href="/login" className="inline-block mt-2 text-blue-400 hover:underline text-sm">
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
    <Suspense fallback={<div className="min-h-screen bg-[#0a0a0a]" />}>
      <VerifyContent />
    </Suspense>
  );
}
