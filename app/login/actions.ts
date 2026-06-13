"use server";

import { rateLimitLogin, getClientIp } from "@/lib/rate-limit";
import { signIn } from "@/auth";
import { headers } from "next/headers";

export async function sendMagicLink(email: string) {
  const headersList = await headers();
  const ip = getClientIp(headersList);

  // L1 rate limit check — always return same message to avoid email enumeration
  if (!(await rateLimitLogin(ip, email))) {
    return { success: true, message: "若邮箱存在，我们会发送邮件" };
  }

  await signIn("email", { email, redirectTo: "/login/verify" });
  return { success: true, message: "若邮箱存在，我们会发送邮件" };
}
