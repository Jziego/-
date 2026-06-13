import { auth } from "@/auth";
import { getAppMode } from "@/lib/env";
import { demoOwnerId } from "@/lib/runtime-store";

export class UnauthorizedError extends Error {
  constructor() {
    super("Unauthorized");
    this.name = "UnauthorizedError";
  }
}

/**
 * Require an authenticated user. Throws UnauthorizedError if no valid session.
 * Use in production API routes that must have a logged-in user.
 */
export async function requireAuth(): Promise<{ userId: string }> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) throw new UnauthorizedError();
  return { userId };
}

/**
 * Unified ownerId source for all routes.
 *
 * In demo mode: returns the session user ID if logged in, otherwise demoOwnerId.
 * In production: requires auth, throws UnauthorizedError if not logged in.
 */
export async function getOwnerId(): Promise<string> {
  if (getAppMode() === "demo") {
    const session = await auth();
    return session?.user?.id ?? demoOwnerId;
  }
  return (await requireAuth()).userId;
}
