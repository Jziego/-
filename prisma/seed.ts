import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required for seeding");
}

const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

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

main().finally(async () => {
  await prisma.$disconnect();
  await pool.end();
});
