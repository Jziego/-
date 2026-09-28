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
    <main className="min-h-screen flex items-center justify-center bg-[#0a0a0a] px-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md bg-neutral-900 border border-neutral-800 rounded-2xl shadow-lg p-8 space-y-6"
      >
        <div className="text-center">
          <h1 className="text-2xl font-bold text-neutral-50">AI 短视频助手</h1>
          <p className="mt-2 text-sm text-neutral-400">输入邮箱，获取 6 位登录验证码</p>
        </div>

        {verifyFailed && (
          <div className="bg-red-950 border border-red-800 text-red-300 rounded-lg p-3 text-sm">
            验证码错误或已过期，请重新获取
          </div>
        )}
        {message && (
          <div className="bg-red-950 border border-red-800 text-red-300 rounded-lg p-3 text-sm">
            {message}
          </div>
        )}

        <div>
          <label htmlFor="email" className="block text-sm font-medium text-neutral-300 mb-1">
            邮箱地址
          </label>
          <input
            id="email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className="w-full px-4 py-3 bg-neutral-950 border border-neutral-700 rounded-lg text-neutral-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            disabled={loading}
          />
        </div>

        <button
          type="submit"
          disabled={loading || !email}
          className="w-full py-3 px-4 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {loading ? "发送中..." : "发送验证码"}
        </button>

        <div className="relative my-6">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-neutral-700" />
          </div>
          <div className="relative flex justify-center text-sm">
            <span className="bg-neutral-900 px-2 text-neutral-500">其他登录方式</span>
          </div>
        </div>

        <button
          type="button"
          onClick={() => signInWithWeChat()}
          className="w-full py-3 px-4 bg-[#07C160] text-white font-medium rounded-lg hover:bg-[#06AD56] transition-colors flex items-center justify-center gap-2"
        >
          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
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
    <Suspense fallback={<div className="min-h-screen bg-[#0a0a0a]" />}>
      <LoginForm />
    </Suspense>
  );
}
