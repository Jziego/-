/** 构造 NextAuth Email provider 的 OTP 校验回跳 URL（整页跳转，cookie 随 302 落盘）。 */
export function buildOtpCallbackUrl(email: string, code: string): string {
  const params = new URLSearchParams({ email, token: code, callbackUrl: "/" });
  return `/api/auth/callback/email?${params.toString()}`;
}
