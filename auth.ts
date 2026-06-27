import NextAuth from "next-auth";
import EmailProvider from "next-auth/providers/email";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { Resend } from "resend";
import type { AdapterUser } from "@auth/core/adapters";
import { getPrisma } from "@/lib/prisma";
import { getResendApiKey, getEmailFrom, hasWechatProvider, getWechatAppId, getWechatAppSecret } from "@/lib/env";
import { WeChatProvider } from "@/lib/auth/wechat-provider";

let _resend: Resend | null = null;
function getResend(): Resend {
  if (!_resend) _resend = new Resend(getResendApiKey());
  return _resend;
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: {
    ...PrismaAdapter(getPrisma()!),
    createUser: async (data) => {
      return getPrisma()!.user.create({
        data: { ...data, plan: "free", quotaRemaining: 10 },
      }) as unknown as AdapterUser;
    },
  },
  providers: [
    EmailProvider({
      server: {},
      from: getEmailFrom(),
      sendVerificationRequest: async ({ identifier: email, url }) => {
        if (!getResendApiKey()) {
          // Dev fallback: log the verification URL when Resend is not configured.
          // In production, set RESEND_API_KEY to send real magic-link emails.
          console.log(`[auth] magic-link dev fallback (no RESEND_API_KEY): ${email} → ${url}`);
          return;
        }
        await getResend().emails.send({
          from: getEmailFrom(),
          to: email,
          subject: "登录 AI 短视频助手",
          html: `<p>点击下方链接登录：</p><p><a href="${url}">${url}</a></p><p>链接 24 小时内有效。</p>`,
        });
      },
    }),
    // Conditionally register WeChat provider
    ...(hasWechatProvider()
      ? [
          WeChatProvider({
            clientId: getWechatAppId()!,
            clientSecret: getWechatAppSecret()!,
          }),
        ]
      : []),
  ],
  session: { strategy: "jwt" },
  pages: {
    signIn: "/login",
    verifyRequest: "/login/verify",
  },
  callbacks: {
    jwt({ token, user, trigger }) {
      if (user) {
        token.sub = user.id;
      }
      // Inject jti on sign-in or if missing (e.g., token refresh)
      if (trigger === "signIn" || !token.jti) {
        token.jti = crypto.randomUUID();
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = token.sub!;
        session.user.jti = token.jti;
      }
      return session;
    },
  },
});
