"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { sendMagicLink } from "./actions";

/**
 * 运行时收窄 altcha statechange 事件的 detail——custom element 的事件载荷
 * 跨不出 any/unknown，不信任外部类型，只认 string 形态的 state / payload。
 */
function readAltchaStateChange(
  event: unknown,
): { state: string; payload?: string } | null {
  if (typeof event !== "object" || event === null || !("detail" in event)) {
    return null;
  }
  const detail = (event as { detail?: unknown }).detail;
  if (typeof detail !== "object" || detail === null) return null;
  const { state, payload } = detail as { state?: unknown; payload?: unknown };
  if (typeof state !== "string") return null;
  return { state, payload: typeof payload === "string" ? payload : undefined };
}

export function LoginForm({ captchaEnabled }: { captchaEnabled: boolean }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // OTP 校验失败时 NextAuth 回跳 /login?error=Verification
  const verifyFailed = searchParams.get("error") === "Verification";
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [altchaPayload, setAltchaPayload] = useState<string | null>(null);
  // 校验失败需重试时 +1 强制 remount widget，重新领取挑战（挑战一次性消费）
  const [widgetKey, setWidgetKey] = useState(0);

  // 动态加载 altcha 包注册 <altcha-widget> custom element（样式随 shadow DOM 自注入），
  // 仅 captcha 启用时才加载，避免给未启用环境增加无谓 JS 体积。
  useEffect(() => {
    if (captchaEnabled) void import("altcha");
  }, [captchaEnabled]);

  function handleAltchaStateChange(event: unknown) {
    const detail = readAltchaStateChange(event);
    if (!detail) return;
    setAltchaPayload(
      detail.state === "verified" && detail.payload ? detail.payload : null,
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // 清掉上一次的错误文案（如人机验证失败重试），避免 loading 期间残留旧提示
    setMessage("");
    // 未 verified 的隐式提交（如回车）直接挡在客户端，省一次 server action 往返
    if (captchaEnabled && !altchaPayload) return;
    setLoading(true);
    let result: Awaited<ReturnType<typeof sendMagicLink>>;
    try {
      result = await sendMagicLink(email, altchaPayload ?? undefined);
    } catch {
      setMessage("发送失败，请稍后重试");
      setLoading(false);
      return;
    }
    if (result?.success === false) {
      // 人机验证未通过：payload 已被服务端一次性消费，重置 widget 让用户重新验证
      setMessage(result.message);
      setAltchaPayload(null);
      setWidgetKey((k) => k + 1);
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

        {captchaEnabled && (
          <altcha-widget
            key={widgetKey}
            challenge="/api/altcha/challenge"
            onstatechange={handleAltchaStateChange}
          />
        )}

        <button
          type="submit"
          disabled={loading || !email || (captchaEnabled && !altchaPayload)}
          className="primaryButton"
        >
          {loading ? "发送中..." : "发送验证码"}
        </button>
      </form>
    </main>
  );
}
