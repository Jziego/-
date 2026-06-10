import type { PrismaClient } from "@prisma/client";
import { ensureDemoUser } from "@/lib/demo-user";
import {
  toAsset,
  toAssetAnalysis,
  toAssetAnalysisInput,
  toAssetInput,
  toAvatarProfile,
  toAvatarProfileInput,
  toJob,
  toJobInput,
  toRenderProject,
  toRenderProjectInput,
  toScriptDraft,
  toScriptDraftInput,
  toStoreProfile,
  toStoreProfileInput,
  toVideoOutput
} from "@/lib/repositories/mappers";
import type {
  AssetRepository,
  AssetAnalysisRepository,
  AvatarRepository,
  JobRepository,
  RenderRepository,
  ScriptRepository,
  StoreRepository
} from "@/lib/repositories/types";
import type {
  Asset,
  AssetAnalysis,
  AvatarProfile,
  Job,
  RenderProject,
  ScriptDraft,
  StoreProfile,
  VideoOutput
} from "@/lib/types";

export class PrismaStoreRepository implements StoreRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listByOwner(ownerId: string): Promise<StoreProfile[]> {
    const rows = await this.prisma.storeProfile.findMany({ where: { ownerId } });
    return rows.map(toStoreProfile);
  }

  async upsert(profile: StoreProfile): Promise<StoreProfile> {
    await ensureDemoUser(this.prisma, profile.ownerId);
    const data = toStoreProfileInput(profile);
    const row = await this.prisma.storeProfile.upsert({
      where: { id: profile.id },
      create: data,
      update: {
        name: data.name,
        industry: data.industry,
        location: data.location,
        mainProducts: data.mainProducts,
        averageOrderValue: data.averageOrderValue,
        targetCustomers: data.targetCustomers,
        sellingPoints: data.sellingPoints,
        promotions: data.promotions,
        brandTone: data.brandTone,
        forbiddenWords: data.forbiddenWords,
        contactPhone: data.contactPhone,
        logoAssetId: data.logoAssetId,
        storefrontAssetId: data.storefrontAssetId,
        updatedAt: data.updatedAt
      }
    });
    return toStoreProfile(row);
  }

  async findById(id: string): Promise<StoreProfile | null> {
    const row = await this.prisma.storeProfile.findUnique({ where: { id } });
    return row ? toStoreProfile(row) : null;
  }
}

export class PrismaAssetRepository implements AssetRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listByOwner(ownerId: string): Promise<Asset[]> {
    const rows = await this.prisma.asset.findMany({ where: { ownerId } });
    return rows.map(toAsset);
  }

  async create(asset: Asset): Promise<Asset> {
    const row = await this.prisma.asset.create({ data: toAssetInput(asset) });
    return toAsset(row);
  }

  async findById(id: string): Promise<Asset | null> {
    const row = await this.prisma.asset.findUnique({ where: { id } });
    return row ? toAsset(row) : null;
  }
}

export class PrismaAssetAnalysisRepository implements AssetAnalysisRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(analysis: AssetAnalysis): Promise<AssetAnalysis> {
    const row = await this.prisma.assetAnalysis.create({ data: toAssetAnalysisInput(analysis) });
    return toAssetAnalysis(row);
  }

  async findByAssetId(assetId: string): Promise<AssetAnalysis | null> {
    const row = await this.prisma.assetAnalysis.findUnique({ where: { assetId } });
    return row ? toAssetAnalysis(row) : null;
  }

  async listByIds(ids: string[]): Promise<AssetAnalysis[]> {
    const rows = await this.prisma.assetAnalysis.findMany({ where: { id: { in: ids } } });
    return rows.map(toAssetAnalysis);
  }

  async listByOwner(ownerId: string): Promise<AssetAnalysis[]> {
    const rows = await this.prisma.assetAnalysis.findMany({
      where: { asset: { ownerId } }
    });
    return rows.map(toAssetAnalysis);
  }
}

export class PrismaAvatarRepository implements AvatarRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listByOwner(ownerId: string): Promise<AvatarProfile[]> {
    const rows = await this.prisma.avatarProfile.findMany({ where: { ownerId } });
    return rows.map(toAvatarProfile);
  }

  async create(avatar: AvatarProfile): Promise<AvatarProfile> {
    const row = await this.prisma.avatarProfile.create({ data: toAvatarProfileInput(avatar) });
    return toAvatarProfile(row);
  }

  async findById(id: string): Promise<AvatarProfile | null> {
    const row = await this.prisma.avatarProfile.findUnique({ where: { id } });
    return row ? toAvatarProfile(row) : null;
  }
}

export class PrismaScriptRepository implements ScriptRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listByOwner(ownerId: string): Promise<ScriptDraft[]> {
    const rows = await this.prisma.scriptDraft.findMany({ where: { ownerId } });
    return rows.map(toScriptDraft);
  }

  async create(script: ScriptDraft): Promise<ScriptDraft> {
    const row = await this.prisma.scriptDraft.create({ data: toScriptDraftInput(script) });
    return toScriptDraft(row);
  }

  async findById(id: string): Promise<ScriptDraft | null> {
    const row = await this.prisma.scriptDraft.findUnique({ where: { id } });
    return row ? toScriptDraft(row) : null;
  }
}

export class PrismaRenderRepository implements RenderRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listProjectsByOwner(ownerId: string): Promise<RenderProject[]> {
    const rows = await this.prisma.renderProject.findMany({ where: { ownerId } });
    return rows.map(toRenderProject);
  }

  async createProject(project: RenderProject): Promise<RenderProject> {
    const row = await this.prisma.renderProject.create({ data: toRenderProjectInput(project) });
    return toRenderProject(row);
  }

  async findProjectById(id: string): Promise<RenderProject | null> {
    const row = await this.prisma.renderProject.findUnique({ where: { id } });
    return row ? toRenderProject(row) : null;
  }

  async listOutputsByOwner(ownerId: string): Promise<VideoOutput[]> {
    const rows = await this.prisma.videoOutput.findMany({ where: { ownerId } });
    return rows.map(toVideoOutput);
  }
}

export class PrismaJobRepository implements JobRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listByOwner(ownerId: string): Promise<Job[]> {
    const rows = await this.prisma.job.findMany({ where: { ownerId } });
    return rows.map(toJob);
  }

  async createMany(jobs: Job[]): Promise<Job[]> {
    await this.prisma.job.createMany({ data: jobs.map(toJobInput) });
    return jobs;
  }

  async findById(id: string): Promise<Job | null> {
    const row = await this.prisma.job.findUnique({ where: { id } });
    return row ? toJob(row) : null;
  }

  async update(id: string, data: Partial<Job>): Promise<Job> {
    const prismaData: Record<string, unknown> = {};
    if (data.status !== undefined) prismaData.status = data.status;
    if (data.progress !== undefined) prismaData.progress = data.progress;
    if (data.error !== undefined) prismaData.error = data.error ?? null;
    if (data.payload !== undefined) prismaData.payload = data.payload as object;
    if (data.dependsOnJobIds !== undefined) prismaData.dependsOnJobIds = data.dependsOnJobIds;
    if (data.updatedAt !== undefined) prismaData.updatedAt = new Date(data.updatedAt);

    const row = await this.prisma.job.update({
      where: { id },
      data: prismaData
    });
    return toJob(row);
  }

  async listByStatus(status: Job["status"]): Promise<Job[]> {
    const rows = await this.prisma.job.findMany({ where: { status } });
    return rows.map(toJob);
  }
}
