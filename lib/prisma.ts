import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { getDatabaseUrl, hasDatabase } from "@/lib/env";

const globalForPrisma = globalThis as typeof globalThis & {
  __prisma?: PrismaClient;
  __pgPool?: Pool;
};

export function getPrisma(): PrismaClient | null {
  if (!hasDatabase()) return null;
  if (!globalForPrisma.__prisma) {
    const pool =
      globalForPrisma.__pgPool ??
      new Pool({
        connectionString: getDatabaseUrl(),
        connectionTimeoutMillis: 3000, // fail fast if PG is unreachable
        max: 5
      });
    globalForPrisma.__pgPool = pool;
    const adapter = new PrismaPg(pool);
    globalForPrisma.__prisma = new PrismaClient({ adapter });

    // Log connection status for debugging
    pool.on("error", (err) => {
      console.warn("[prisma] PG pool error:", err.message);
    });
  }
  return globalForPrisma.__prisma;
}
