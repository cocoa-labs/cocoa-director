import type {
  AnchorAsset,
  CreativeBrief,
  GeneratedShot,
  MusicPlan,
  MusicTrack,
  MusicProviderControls,
  AnchorProviderControls,
  Shot,
  ShotProviderControls,
} from "@/lib/schemas";

export type ProviderContext = {
  videoId: string;
  traceId: string;
  phaseNumber: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  idempotencyKey: string;
  /**
   * Generation-bound destination used by editorial and Media Lab work. When
   * omitted, providers retain the legacy music-video anchor/shot paths.
   */
  outputPathPrefix?: string;
  outputAttempt?: number;
};

export type ProviderResult<T> = {
  data: T;
  requestId: string;
  latencyMs: number;
  costUsd: number;
};

// Uploaded reference image(s) that condition anchor generation (image-to-image).
// Present only when a user has seeded the slot — a CHARACTER subject (stylized "you")
// or an AESTHETIC reference (look/motif). `allowLikeness` is true ONLY for a consented
// character seed, and is what permits relaxing the "no real-person likeness" prompt rule.
export type AnchorReferenceInput = {
  images: { url: string; mimeType: string }[];
  intent: "character" | "aesthetic";
  allowLikeness: boolean;
};

export type ImageProvider = {
  generateAnchorAsset(
    role: AnchorAsset["role"],
    prompt: string,
    context: ProviderContext,
    options?: AnchorProviderControls,
    references?: AnchorReferenceInput,
  ): Promise<ProviderResult<AnchorAsset>>;
};

export type MusicProvider = {
  compose(plan: MusicPlan, context: ProviderContext, options?: MusicProviderControls): Promise<ProviderResult<MusicTrack>>;
};

export type VideoProvider = {
  generateShot(
    shot: Shot,
    brief: CreativeBrief,
    context: ProviderContext,
    options?: ShotProviderControls,
  ): Promise<ProviderResult<GeneratedShot>>;
};

export type ModerationProvider = {
  checkText(input: string, stage: string, context?: Partial<ProviderContext>): Promise<{
    allowed: boolean;
    categories: string[];
  }>;
};

export type ProviderSuite = {
  images: ImageProvider;
  music: MusicProvider;
  video: VideoProvider;
  moderation: ModerationProvider;
};
