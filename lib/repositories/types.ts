import type {
  Asset,
  AssetAnalysis,
  AvatarProfile,
  BgmTrack,
  Job,
  RenderProject,
  ScriptDraft,
  StoreProfile,
  VideoOutput
} from "@/lib/types";

export interface StoreRepository {
  listByOwner(ownerId: string): Promise<StoreProfile[]>;
  upsert(profile: StoreProfile): Promise<StoreProfile>;
  findById(id: string): Promise<StoreProfile | null>;
}

export interface AssetRepository {
  listByOwner(ownerId: string): Promise<Asset[]>;
  create(asset: Asset): Promise<Asset>;
  findById(id: string): Promise<Asset | null>;
}

export interface AssetAnalysisRepository {
  create(analysis: AssetAnalysis): Promise<AssetAnalysis>;
  findByAssetId(assetId: string): Promise<AssetAnalysis | null>;
  listByIds(ids: string[]): Promise<AssetAnalysis[]>;
  listByOwner(ownerId: string): Promise<AssetAnalysis[]>;
}

export interface AvatarRepository {
  listByOwner(ownerId: string): Promise<AvatarProfile[]>;
  create(avatar: AvatarProfile): Promise<AvatarProfile>;
  findById(id: string): Promise<AvatarProfile | null>;
}

export interface ScriptRepository {
  listByOwner(ownerId: string): Promise<ScriptDraft[]>;
  create(script: ScriptDraft): Promise<ScriptDraft>;
  findById(id: string): Promise<ScriptDraft | null>;
}

export interface RenderRepository {
  listProjectsByOwner(ownerId: string): Promise<RenderProject[]>;
  createProject(project: RenderProject): Promise<RenderProject>;
  findProjectById(id: string): Promise<RenderProject | null>;
  createOutput(output: VideoOutput): Promise<VideoOutput>;
  findOutputById(id: string): Promise<VideoOutput | null>;
  findTalkingHeadOutputByProject(projectId: string): Promise<VideoOutput | null>;
  listOutputsByOwner(ownerId: string, limit?: number): Promise<VideoOutput[]>;
  updateProject(id: string, data: Partial<RenderProject>): Promise<RenderProject>;
}

export interface JobRepository {
  listByOwner(ownerId: string, limit?: number): Promise<Job[]>;
  createMany(jobs: Job[]): Promise<Job[]>;
  findById(id: string): Promise<Job | null>;
  update(id: string, data: Partial<Job>): Promise<Job>;
  listByStatus(status: Job["status"]): Promise<Job[]>;
  /** Delete this owner's terminal (completed/failed) jobs. Returns count deleted. */
  deleteTerminalByOwner(ownerId: string): Promise<number>;
}

export interface BgmTrackRepository {
  findById(id: string): Promise<BgmTrack | null>;
  list(): Promise<BgmTrack[]>;
  create(track: BgmTrack): Promise<BgmTrack>;
}
