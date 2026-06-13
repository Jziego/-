"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";

function VerifyContent() {
  const searchParams = useSearchParams();
  const email = searchParams.get("email") ?? "";

  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-lg p-8 text-center space-y-4">
        <div className="text-4xl">📧</div>
        <h1 className="text-2xl font-bold text-gray-900">请查收邮件</h1>
        <p className="text-gray-600">
          若邮箱 <span className="font-medium text-gray-900">{email || "已注册"}</span> 存在，我们会发送一封包含登录链接的邮件。
        </p>
        <p className="text-sm text-gray-500">
          请检查收件箱和垃圾邮件文件夹。链接 24 小时内有效。
        </p>
        <a href="/login" className="inline-block text-blue-600 hover:underline text-sm">
          ← 返回登录
        </a>
      </div>
    </main>
  );
}

export default function VerifyPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center">加载中...</div>}>
      <VerifyContent />
    </Suspense>
  );
}
