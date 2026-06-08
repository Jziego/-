import type { PrismaClient } from "@prisma/client";
import { demoOwnerId } from "@/lib/runtime-store";

const demoUserEmails: Record<string, string> = {
  [demoOwnerId]: "demo@example.com"
};

export async function ensureDemoUser(prisma: PrismaClient, ownerId: string = demoOwnerId): Promise<void> {
  await prisma.user.upsert({
    where: { id: ownerId },
    update: {},
    create: {
      id: ownerId,
      email: demoUserEmails[ownerId] ?? `${ownerId}@demo.local`,
      plan: "free",
      quotaRemaining: 10
    }
  });
}
