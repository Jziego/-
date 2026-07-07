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

interface RuntimeState {
  stores: StoreProfile[];
  assets: Asset[];
  analyses: AssetAnalysis[];
  avatars: AvatarProfile[];
  scripts: ScriptDraft[];
  renderProjects: RenderProject[];
  jobs: Job[];
  outputs: VideoOutput[];
  bgmTracks: BgmTrack[];
}

const globalStore = globalThis as typeof globalThis & {
  __aiVideoAssistantState?: RuntimeState;
};

export function getRuntimeState(): RuntimeState {
  if (!globalStore.__aiVideoAssistantState) {
    globalStore.__aiVideoAssistantState = {
      stores: [],
      assets: [],
      analyses: [],
      avatars: [],
      scripts: [],
      renderProjects: [],
      jobs: [],
      outputs: [],
      bgmTracks: []
    };
  }

  return globalStore.__aiVideoAssistantState;
}

export const demoOwnerId = "demo_user";

export function resetRuntimeStateForTests(): void {
  globalStore.__aiVideoAssistantState = undefined;
}
