import NextAuth from "next-auth";
import EmailProvider from "next-auth/providers/email";
import { PrismaAdapter } from "@auth/prisma-adapter";
import type { AdapterUser } from "@auth/core/adapters";
import { getPrisma } from "@/lib/prisma";
import { getResendApiKey, getEmailFrom } from "@/lib/env";
import { generateOtpCode } from "@/lib/auth/otp";
import { sendOtpViaResend } from "@/lib/auth/resend-send";

/**
 * JWT session lifetime. NextAuth v5 defaults maxAge to 30 days; we pin it
 * explicitly so session-blacklist revocation (revokeSession) can reference the
 * same value and stay aligned. If this changes, update app/login/actions.ts too.
 */
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

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
      // OTP 10 分钟有效（默认 24h 对验证码过长）；verify 页文案与此保持一致。
      maxAge: 10 * 60,
      // 6 位数字验证码替代 32 位随机串；哈希存储/一次性消费/自动建用户均为
      // NextAuth 内置流程，不变。爆破防护：middleware 对 callback/email 限流。
      generateVerificationToken: async () => generateOtpCode(),
      sendVerificationRequest: async ({ identifier: email, token, url }) => {
        if (!getResendApiKey()) {
          // Dev fallback: log the OTP code when Resend is not configured.
          console.log(`[auth] otp dev fallback (no RESEND_API_KEY): ${email} → ${token} | url: ${url}`);
          return;
        }
        await sendOtpViaResend(email, token, url);
      },
    }),
  ],
  session: { strategy: "jwt", maxAge: SESSION_MAX_AGE_SECONDS },
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
