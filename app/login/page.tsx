import { Suspense } from "react";
import { isAltchaEnabled } from "@/lib/altcha";
import { LoginForm } from "./login-form";

// isAltchaEnabled() 读 process.env.ALTCHA_SECRET，但纯 process.env 读取不会让
// Next 把页面标记为动态——没有 force-dynamic 时 build 阶段静态预渲染会把开关值
// 烘焙进 HTML，生产环境即使配了 ALTCHA_SECRET 也永远拿到 false（captcha 不渲染）。
export const dynamic = "force-dynamic";

export default function LoginPage() {
  const captchaEnabled = isAltchaEnabled();
  return (
    <Suspense fallback={<div className="authPage" />}>
      <LoginForm captchaEnabled={captchaEnabled} />
    </Suspense>
  );
}
