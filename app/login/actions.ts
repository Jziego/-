"use server";

import { rateLimitLogin, getClientIp } from "@/lib/rate-limit";
import { auth, signIn, signOut, SESSION_MAX_AGE_SECONDS } from "@/auth";
import { revokeSession } from "@/lib/session-blacklist";
import { headers } from "next/headers";

export async function sendMagicLink(email: string) {
  // Basic server-side format check — always same message to prevent enumeration
  if (!email || !email.includes("@")) {
    return { success: true, message: "若邮箱存在，我们会发送邮件" };
  }

  const headersList = await headers();
  const ip = getClientIp(headersList);

  // L1 rate limit check — always return same message to avoid email enumeration
  if (!(await rateLimitLogin(ip, email))) {
    return { success: true, message: "若邮箱存在，我们会发送邮件" };
  }

  // redirectTo becomes the magic-link's callbackUrl, so the user lands on the
  // dashboard (/) after clicking the link. The post-send "check your email"
  // screen is governed independently by pages.verifyRequest in auth.ts.
  await signIn("email", { email, redirectTo: "/" });
  return { success: true, message: "若邮箱存在，我们会发送邮件" };
}

export async function signInWithWeChat() {
  await signIn("wechat", { redirectTo: "/" });
}

/**
 * Sign out the current user and revoke their JWT session.
 * Uses the jti (JWT ID) embedded in the session token.
 */
export async function signOutWithRevocation() {
  const session = await auth();
  if (session?.user?.jti) {
    // Revoke the current JWT for the full session lifetime so the blacklist
    // entry outlives the cookie (NextAuth v5 default maxAge = 30 days, pinned
    // via SESSION_MAX_AGE_SECONDS in auth.ts).
    await revokeSession(session.user.jti, SESSION_MAX_AGE_SECONDS);
  }
  await signOut({ redirectTo: "/login" });
}
