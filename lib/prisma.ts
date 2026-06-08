import { PrismaClient } from "@prisma/client";
import { hasDatabase } from "@/lib/env";

const globalForPrisma = globalThis as typeof globalThis & {
  __prisma?: PrismaClient;
};

export function getPrisma(): PrismaClient | null {
  if (!hasDatabase()) return null;
  if (!globalForPrisma.__prisma) {
    globalForPrisma.__prisma = new PrismaClient();
  }
  return globalForPrisma.__prisma;
}
