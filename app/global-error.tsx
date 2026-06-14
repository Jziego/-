"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";

interface GlobalErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function GlobalError({ error, reset }: GlobalErrorProps) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html>
      <body>
        <main className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
          <div className="text-center space-y-4">
            <h1 className="text-2xl font-bold text-gray-900">出错了</h1>
            <p className="text-gray-600">
              应用遇到了意外错误，请刷新页面重试。
            </p>
            <button
              onClick={reset}
              className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
            >
              刷新页面
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
