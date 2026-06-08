import {
  MemoryAssetAnalysisRepository,
  MemoryAssetRepository,
  MemoryAvatarRepository,
  MemoryJobRepository,
  MemoryRenderRepository,
  MemoryScriptRepository,
  MemoryStoreRepository
} from "@/lib/repositories/memory";
import {
  PrismaAssetAnalysisRepository,
  PrismaAssetRepository,
  PrismaAvatarRepository,
  PrismaJobRepository,
  PrismaRenderRepository,
  PrismaScriptRepository,
  PrismaStoreRepository
} from "@/lib/repositories/prisma";
import type {
  AssetRepository,
  AssetAnalysisRepository,
  AvatarRepository,
  JobRepository,
  RenderRepository,
  ScriptRepository,
  StoreRepository
} from "@/lib/repositories/types";
import { getPrisma } from "@/lib/prisma";

export type {
  AssetRepository,
  AssetAnalysisRepository,
  AvatarRepository,
  JobRepository,
  RenderRepository,
  ScriptRepository,
  StoreRepository
} from "@/lib/repositories/types";

export function getStoreRepository(): StoreRepository {
  const prisma = getPrisma();
  return prisma ? new PrismaStoreRepository(prisma) : new MemoryStoreRepository();
}

export function getAssetRepository(): AssetRepository {
  const prisma = getPrisma();
  return prisma ? new PrismaAssetRepository(prisma) : new MemoryAssetRepository();
}

export function getAssetAnalysisRepository(): AssetAnalysisRepository {
  const prisma = getPrisma();
  return prisma ? new PrismaAssetAnalysisRepository(prisma) : new MemoryAssetAnalysisRepository();
}

export function getAvatarRepository(): AvatarRepository {
  const prisma = getPrisma();
  return prisma ? new PrismaAvatarRepository(prisma) : new MemoryAvatarRepository();
}

export function getScriptRepository(): ScriptRepository {
  const prisma = getPrisma();
  return prisma ? new PrismaScriptRepository(prisma) : new MemoryScriptRepository();
}

export function getRenderRepository(): RenderRepository {
  const prisma = getPrisma();
  return prisma ? new PrismaRenderRepository(prisma) : new MemoryRenderRepository();
}

export function getJobRepository(): JobRepository {
  const prisma = getPrisma();
  return prisma ? new PrismaJobRepository(prisma) : new MemoryJobRepository();
}
