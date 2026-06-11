import { getRuntimeState } from "@/lib/runtime-store";
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

export class MemoryStoreRepository implements StoreRepository {
  async listByOwner(ownerId: string): Promise<StoreProfile[]> {
    return getRuntimeState().stores.filter((store) => store.ownerId === ownerId);
  }

  async upsert(profile: StoreProfile): Promise<StoreProfile> {
    const state = getRuntimeState();
    const index = state.stores.findIndex((store) => store.id === profile.id);
    if (index >= 0) {
      state.stores[index] = profile;
    } else {
      state.stores.push(profile);
    }
    return profile;
  }

  async findById(id: string): Promise<StoreProfile | null> {
    return getRuntimeState().stores.find((store) => store.id === id) ?? null;
  }
}

export class MemoryAssetRepository implements AssetRepository {
  async listByOwner(ownerId: string): Promise<Asset[]> {
    return getRuntimeState().assets.filter((asset) => asset.ownerId === ownerId);
  }

  async create(asset: Asset): Promise<Asset> {
    getRuntimeState().assets.push(asset);
    return asset;
  }

  async findById(id: string): Promise<Asset | null> {
    return getRuntimeState().assets.find((asset) => asset.id === id) ?? null;
  }
}

export class MemoryAssetAnalysisRepository implements AssetAnalysisRepository {
  async create(analysis: AssetAnalysis): Promise<AssetAnalysis> {
    getRuntimeState().analyses.push(analysis);
    return analysis;
  }

  async findByAssetId(assetId: string): Promise<AssetAnalysis | null> {
    return getRuntimeState().analyses.find((analysis) => analysis.assetId === assetId) ?? null;
  }

  async listByIds(ids: string[]): Promise<AssetAnalysis[]> {
    const idSet = new Set(ids);
    return getRuntimeState().analyses.filter((analysis) => idSet.has(analysis.id));
  }

  async listByOwner(ownerId: string): Promise<AssetAnalysis[]> {
    const assetIds = new Set(
      getRuntimeState()
        .assets.filter((asset) => asset.ownerId === ownerId)
        .map((asset) => asset.id)
    );
    return getRuntimeState().analyses.filter((analysis) => assetIds.has(analysis.assetId));
  }
}

export class MemoryAvatarRepository implements AvatarRepository {
  async listByOwner(ownerId: string): Promise<AvatarProfile[]> {
    return getRuntimeState().avatars.filter((avatar) => avatar.ownerId === ownerId);
  }

  async create(avatar: AvatarProfile): Promise<AvatarProfile> {
    getRuntimeState().avatars.push(avatar);
    return avatar;
  }

  async findById(id: string): Promise<AvatarProfile | null> {
    return getRuntimeState().avatars.find((avatar) => avatar.id === id) ?? null;
  }
}

export class MemoryScriptRepository implements ScriptRepository {
  async listByOwner(ownerId: string): Promise<ScriptDraft[]> {
    return getRuntimeState().scripts.filter((script) => script.ownerId === ownerId);
  }

  async create(script: ScriptDraft): Promise<ScriptDraft> {
    getRuntimeState().scripts.push(script);
    return script;
  }

  async findById(id: string): Promise<ScriptDraft | null> {
    return getRuntimeState().scripts.find((script) => script.id === id) ?? null;
  }
}

export class MemoryRenderRepository implements RenderRepository {
  async listProjectsByOwner(ownerId: string): Promise<RenderProject[]> {
    return getRuntimeState().renderProjects.filter((project) => project.ownerId === ownerId);
  }

  async createProject(project: RenderProject): Promise<RenderProject> {
    getRuntimeState().renderProjects.push(project);
    return project;
  }

  async findProjectById(id: string): Promise<RenderProject | null> {
    return getRuntimeState().renderProjects.find((project) => project.id === id) ?? null;
  }

  async createOutput(output: VideoOutput): Promise<VideoOutput> {
    getRuntimeState().outputs.push(output);
    return output;
  }

  async findOutputById(id: string): Promise<VideoOutput | null> {
    return getRuntimeState().outputs.find((output) => output.id === id) ?? null;
  }

  async listOutputsByOwner(ownerId: string): Promise<VideoOutput[]> {
    return getRuntimeState().outputs.filter((output) => output.ownerId === ownerId);
  }

  async updateProject(id: string, data: Partial<RenderProject>): Promise<RenderProject> {
    const state = getRuntimeState();
    const index = state.renderProjects.findIndex((p) => p.id === id);
    if (index < 0) throw new Error(`RenderProject not found: ${id}`);
    const updated = { ...state.renderProjects[index], ...data };
    state.renderProjects[index] = updated;
    return updated;
  }
}

export class MemoryJobRepository implements JobRepository {
  async listByOwner(ownerId: string): Promise<Job[]> {
    return getRuntimeState().jobs.filter((job) => job.ownerId === ownerId);
  }

  async createMany(jobs: Job[]): Promise<Job[]> {
    getRuntimeState().jobs.push(...jobs);
    return jobs;
  }

  async findById(id: string): Promise<Job | null> {
    return getRuntimeState().jobs.find((job) => job.id === id) ?? null;
  }

  async update(id: string, data: Partial<Job>): Promise<Job> {
    const state = getRuntimeState();
    const index = state.jobs.findIndex((job) => job.id === id);
    if (index < 0) throw new Error(`Job not found: ${id}`);
    const updated = { ...state.jobs[index], ...data };
    state.jobs[index] = updated;
    return updated;
  }

  async listByStatus(status: Job["status"]): Promise<Job[]> {
    return getRuntimeState().jobs.filter((job) => job.status === status);
  }
}
