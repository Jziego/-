import { Resend } from "resend";
import { getEmailFrom, getResendApiKey } from "@/lib/env";
import { renderOtpEmail } from "@/lib/auth/otp-email";

let _resend: Resend | null = null;
function getResend(): Resend {
  if (!_resend) _resend = new Resend(getResendApiKey());
  return _resend;
}

/**
 * 经 Resend 发送 OTP 登录邮件。
 *
 * 注意：Resend SDK 对 API 级错误（sandbox 域限发账号邮箱、from 未验证、配额
 * 超限等）resolve `{ error }` 而 **不 throw**。必须显式检查并抛错——否则
 * NextAuth 视发信成功，用户看到通用成功提示却永远收不到邮件（静默丢信 bug）。
 * 抛出后由 sendMagicLink 的 { ok:false } 路径转为"发送失败"提示。
 */
export async function sendOtpViaResend(email: string, token: string, url: string): Promise<void> {
  const { error } = await getResend().emails.send({
    from: getEmailFrom(),
    to: email,
    subject: `登录验证码：${token}`,
    html: renderOtpEmail(token, url),
  });
  if (error) {
    console.error(
      `[auth] resend send failed: ${error.statusCode} ${error.name} (${error.message}) → ${email}`,
    );
    throw new Error(`resend send failed: ${error.name}`);
  }
}
