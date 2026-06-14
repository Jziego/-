"use server";

import { rateLimitLogin, getClientIp } from "@/lib/rate-limit";
import { auth, signIn, signOut } from "@/auth";
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

  await signIn("email", { email, redirectTo: "/login/verify" });
  return { success: true, message: "若邮箱存在，我们会发送邮件" };
}

/**
 * Sign out the current user and revoke their JWT session.
 * Uses the jti (JWT ID) embedded in the session token.
 */
export async function signOutWithRevocation() {
  const session = await auth();
  if (session?.user?.jti) {
    // Revoke the current JWT. TTL: 7 days (NextAuth default max session).
    await revokeSession(session.user.jti, 7 * 86400);
  }
  await signOut({ redirectTo: "/login" });
}
