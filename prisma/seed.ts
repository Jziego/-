import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  await prisma.user.upsert({
    where: { id: "demo_user" },
    update: {},
    create: {
      id: "demo_user",
      email: "demo@example.com",
      plan: "free",
      quotaRemaining: 10
    }
  });
}

main().finally(() => prisma.$disconnect());
