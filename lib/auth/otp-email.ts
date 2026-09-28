/**
 * Render the OTP sign-in email body.
 *
 * Email clients vary widely: some block `<a>` clicks, some strip the href
 * attribute entirely. We render the 6-digit code as large prominent text AND
 * keep the same-token magic link as a clickable fallback, so the user can
 * always sign in.
 */
export function renderOtpEmail(code: string, url: string): string {
  return [
    `<p>你的登录验证码：</p>`,
    `<p style="font-size:32px;font-weight:bold;letter-spacing:8px;margin:16px 0;">${code}</p>`,
    `<p>验证码 10 分钟内有效，请勿告知他人。</p>`,
    `<p>也可以<a href="${url}">点击此处直接登录</a>（与输入验证码等效）。</p>`,
    `<p>若非本人操作，请忽略本邮件。</p>`,
  ].join("");
}
