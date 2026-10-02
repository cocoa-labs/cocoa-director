import type { HybridVisualPlanV2, MediaAsset, MediaGeneration, VideoJob, VisualBeat, VisualBeatAsset } from "@/lib/schemas";
import { attachVisualPlanToStoryboard } from "@/lib/hybrid-visuals";
import { getProviderMode } from "@/lib/server/config";
import { createProjectMediaGeneration, pollProjectMediaGenerations } from "@/lib/server/media";
import { probeMediaUrl } from "@/lib/server/media-probe";
import { getStore } from "@/lib/server/store";

const GENERATED_KINDS = new Set(["editorial_image", "cinematic_broll", "synthetic_reenactment", "composite"]);
const VIDEO_KINDS = new Set(["cinematic_broll", "synthetic_reenactment", "composite"]);

export type HybridAssetState = {
  complete: boolean;
  pending: number;
  failed: Array<{ beatId: string; generationId?: string; errorCode?: string; retryable: boolean; attempt: number; error: string }>;
};

export async function prepareHybridVisualAssets(videoId: string): Promise<HybridAssetState> {
  const job = await requireHybridJob(videoId);
  if (!job.visualPlan || getProviderMode() !== "live") {
    const plan = job.visualPlan ? withMockProxyAssets(job.visualPlan) : undefined;
    if (plan) await persistPlan(job, plan);
    return { complete: true, pending: 0, failed: [] };
  }

  const beatIds = job.visualPlan.beats.filter((candidate) => GENERATED_KINDS.has(candidate.kind)).map((beat) => beat.id);
  for (let index = 0; index < beatIds.length; index += 4) {
    await Promise.all(beatIds.slice(index, index + 4).map((beatId) => prepareHybridVisualBeat(videoId, beatId)));
  }
  await prepareEditorialMusic(job);
  return syncHybridVisualAssets(videoId);
}

export function hybridGeneratedBeatIds(job: VideoJob) {
  return job.visualPlan?.beats.filter((candidate) => GENERATED_KINDS.has(candidate.kind)).map((beat) => beat.id) ?? [];
}

export async function prepareHybridVisualBeat(
  videoId: string,
  beatId: string,
  options: { identitySafe?: boolean; retryFailed?: boolean; forceRegenerate?: boolean; recoveryOfGenerationId?: string; recoveryReason?: string; attempt?: number } = {},
) {
  const store = getStore();
  const job = await requireHybridJob(videoId);
  const beat = job.visualPlan?.beats.find((candidate) => candidate.id === beatId);
  if (!beat || !GENERATED_KINDS.has(beat.kind)) return;
  const attempt = Math.max(1, options.attempt ?? 1);
  let media = await store.listJobMedia(videoId);
  const latestDesired = latestBeatGeneration(media.generations, videoId, beat.id, job.qualityTier !== "draft" && VIDEO_KINDS.has(beat.kind) ? "video" : "image");
  if (latestDesired?.status === "success" && !options.forceRegenerate) return latestDesired;
  if (latestDesired?.status === "failed" && !options.identitySafe && !options.retryFailed) return latestDesired;

  const imageSuffix = options.forceRegenerate ? `:polish:r${attempt}` : options.identitySafe ? `:safe:r${attempt}` : "";
  const videoSuffix = options.forceRegenerate ? `:polish:r${attempt}` : options.identitySafe ? `:safe:r${attempt}` : options.retryFailed ? `:retry:r${attempt}` : "";
  const imageKey = `${generationKey(videoId, beat.id, "image")}${imageSuffix}`;
  let imageGeneration = findGeneration(media.generations, imageKey);
  if (!imageGeneration) {
    const result = await createProjectMediaGeneration(job.projectId, {
      videoJobId: videoId,
      kind: "image",
      prompt: options.identitySafe ? identitySafePrompt(beat, job) : beat.generationPrompt ?? beat.intent,
      controls: {
        model: beat.providerRoute.image ?? "gpt-image-2",
        size: imageSize(job.aspectRatio, job.qualityTier),
        quality: job.qualityTier === "premium" ? "high" : "medium",
        outputFormat: "png",
        role: "style",
        visualBeatId: beat.id,
        visualBeatKind: options.identitySafe ? "editorial_image" : beat.kind,
        disclosure: options.identitySafe ? { required: false, persistent: false, publicFigures: [], currentEvent: false } : beat.disclosure,
        identitySafe: options.identitySafe === true,
        generationAttempt: attempt,
        recoveryReason: options.recoveryReason,
      },
      inputAssetIds: [],
      execute: true,
      idempotencyKey: imageKey,
      label: `${beat.id}${options.identitySafe ? " identity-safe recovery" : " editorial plate"}`,
    });
    imageGeneration = await annotateRecovery(result.generation, options, attempt);
  }
  if (imageGeneration.status === "failed" || job.qualityTier === "draft" || !VIDEO_KINDS.has(beat.kind) || imageGeneration.status !== "success") return imageGeneration;

  media = await store.listJobMedia(videoId);
  const imageAsset = media.assets.find((asset) => asset.generationId === imageGeneration?.id && asset.kind === "image");
  if (!imageAsset) return imageGeneration;
  const videoKey = `${generationKey(videoId, beat.id, "video")}${videoSuffix}`;
  const existingVideo = findGeneration(media.generations, videoKey);
  if (existingVideo) return existingVideo;
  const result = await createProjectMediaGeneration(job.projectId, {
    videoJobId: videoId,
    kind: "video",
    prompt: `${options.identitySafe ? identitySafePrompt(beat, job) : beat.generationPrompt ?? beat.intent} Motion direction: ${beat.motionDirection}`,
    controls: {
      seedanceMode: "image-to-video",
      seedanceTier: beat.providerRoute.tier ?? "fast",
      durationSeconds: providerDuration(beat),
      aspectRatio: job.aspectRatio,
      resolution: beat.providerRoute.resolution ?? "720p",
      referenceImageLimit: 2,
      generateAudio: false,
      visualBeatId: beat.id,
      visualBeatKind: options.identitySafe ? "editorial_image" : beat.kind,
      visualMotif: job.visualPlan?.continuityKit.motifs.join(", ") ?? "",
      motionDirection: beat.motionDirection,
      disclosure: options.identitySafe ? { required: false, persistent: false, publicFigures: [], currentEvent: false } : beat.disclosure,
      identitySafe: options.identitySafe === true,
      generationAttempt: attempt,
      recoveryReason: options.recoveryReason,
    },
    inputAssetIds: [imageAsset.id],
    execute: true,
    idempotencyKey: videoKey,
    label: `${beat.id}${options.identitySafe ? " identity-safe cinematic recovery" : " cinematic motion"}`,
  });
  return annotateRecovery(result.generation, options, attempt);
}

export async function pollHybridVisualAssets(videoId: string, beatIds?: string[]): Promise<HybridAssetState> {
  const job = await requireHybridJob(videoId);
  if (getProviderMode() === "live") await pollProjectMediaGenerations(job.projectId);
  return syncHybridVisualAssets(videoId, beatIds);
}

export async function syncHybridVisualAssets(videoId: string, beatIds?: string[]): Promise<HybridAssetState> {
  const store = getStore();
  const job = await requireHybridJob(videoId);
  if (!job.visualPlan) return { complete: true, pending: 0, failed: [] };
  const media = await store.listProjectMedia(job.projectId);
  const failed: HybridAssetState["failed"] = [];
  let pending = 0;
  const pendingBeatIds: string[] = [];
  const beats = await Promise.all(job.visualPlan.beats.map(async (beat) => {
    if (!GENERATED_KINDS.has(beat.kind)) return beat;
    const desiredLane = job.qualityTier !== "draft" && VIDEO_KINDS.has(beat.kind) ? "video" : "image";
    const imageGeneration = latestBeatGeneration(media.generations, videoId, beat.id, "image");
    const videoGeneration = latestBeatGeneration(media.generations, videoId, beat.id, "video");
    const generations = [imageGeneration, videoGeneration].filter((value): value is MediaGeneration => Boolean(value));
    const assets = (await Promise.all(generations.map((generation) => visualAssetsForBeat(beat, generation, media.assets)))).flat();
    const desired = desiredLane === "video" ? videoGeneration : imageGeneration;
    if (desired?.status === "failed") failed.push({
      beatId: beat.id,
      generationId: desired.id,
      errorCode: typeof desired.metadata.errorCode === "string"
        ? desired.metadata.errorCode
        : desired.metadata.providerError && typeof desired.metadata.providerError === "object" && typeof (desired.metadata.providerError as Record<string, unknown>).code === "string"
          ? String((desired.metadata.providerError as Record<string, unknown>).code)
          : undefined,
      retryable: desired.metadata.retryable === true,
      attempt: typeof desired.metadata.attempt === "number" ? Math.max(1, Math.floor(desired.metadata.attempt)) : 1,
      error: desired.error ?? "Visual provider generation failed.",
    });
    else if (!desired || desired.status !== "success") { pending += 1; pendingBeatIds.push(beat.id); }
    return { ...beat, assets };
  }));
  const score = findGeneration(media.generations, `${job.id}:editorial-score:v1`);
  if (job.qualityTier !== "draft") {
    if (score?.status === "failed") failed.push({ beatId: "editorial-score", generationId: score.id, retryable: score.metadata.retryable === true, attempt: typeof score.metadata.attempt === "number" ? Math.max(1, Math.floor(score.metadata.attempt)) : 1, error: score.error ?? "Editorial score generation failed." });
    else if (!score || score.status !== "success") pending += 1;
  }
  const plan = { ...job.visualPlan, beats };
  await persistPlan(job, plan);
  if (beatIds?.length) {
    const selected = new Set(beatIds);
    const selectedFailed = failed.filter((failure) => selected.has(failure.beatId));
    const selectedPending = pendingBeatIds.filter((beatId) => selected.has(beatId)).length;
    return { complete: selectedPending === 0 && selectedFailed.length === 0, pending: selectedPending, failed: selectedFailed };
  }
  return { complete: pending === 0 && failed.length === 0, pending, failed };
}

export async function regenerateHybridBeat(videoId: string, beatId: string) {
  const job = await requireHybridJob(videoId);
  const beat = job.visualPlan?.beats.find((candidate) => candidate.id === beatId);
  if (!beat) throw new Error("Visual beat not found.");
  if (beat.locked) throw new Error("Unlock this visual beat before regenerating it.");
  const store = getStore();
  const media = await store.listProjectMedia(job.projectId);
  const version = media.generations.filter((generation) => generation.videoJobId === videoId && generation.controls.visualBeatId === beatId).length + 1;
  const result = await createProjectMediaGeneration(job.projectId, {
    videoJobId: videoId,
    kind: VIDEO_KINDS.has(beat.kind) ? "video" : "image",
    prompt: beat.generationPrompt ?? beat.intent,
    controls: {
      seedanceMode: "text-to-video",
      seedanceTier: beat.providerRoute.tier ?? "fast",
      durationSeconds: providerDuration(beat),
      aspectRatio: job.aspectRatio,
      resolution: beat.providerRoute.resolution ?? "720p",
      generateAudio: false,
      visualBeatId: beat.id,
      visualBeatKind: beat.kind,
      motionDirection: beat.motionDirection,
      quality: job.qualityTier === "premium" ? "high" : "medium",
      size: imageSize(job.aspectRatio, job.qualityTier),
      outputFormat: "png",
      role: "style",
    },
    inputAssetIds: [],
    execute: true,
    idempotencyKey: `${generationKey(videoId, beat.id, VIDEO_KINDS.has(beat.kind) ? "video" : "image")}:r${version}`,
    label: `${beat.id} regeneration ${version}`,
  });
  await getStore().updateJob(videoId, {
    status: "running",
    error: undefined,
    workflowSteps: (job.workflowSteps ?? []).map((step) => {
      if (step.id === "generation") return { ...step, state: "running" as const, startedAt: new Date().toISOString(), completedAt: undefined, error: undefined };
      if (["timeline", "qa", "review", "render"].includes(step.id)) return { ...step, state: "pending" as const, startedAt: undefined, completedAt: undefined, error: undefined };
      return step;
    }),
  });
  return result;
}

async function visualAssetsForBeat(beat: VisualBeat, generation: MediaGeneration, assets: MediaAsset[]): Promise<VisualBeatAsset[]> {
  const status = generation.status === "success"
    ? "ready" as const
    : generation.status === "draft"
      ? "planned" as const
      : generation.status;
  const generatedAssets = assets
    .filter((asset) => asset.generationId === generation.id)
    .sort((left, right) => Number(typeof right.metadata.storageKey === "string") - Number(typeof left.metadata.storageKey === "string") || right.createdAt.localeCompare(left.createdAt));
  if (generatedAssets.length === 0) {
    return [{
      beatId: beat.id,
      generationId: generation.id,
      kind: generation.kind === "video" ? "video" : "image",
      provider: generation.provider,
      model: generation.model,
      status,
      costCents: generation.costCents,
      error: generation.error,
    }];
  }
  // A generation can retain historical assets after collision recovery. The
  // active visual plan must expose one canonical output per generation/lane;
  // immutable recovery assets sort first while the older record remains in
  // the media library for provenance and rollback.
  return Promise.all(generatedAssets.slice(0, 1).map(async (asset) => {
    const previous = beat.assets.find((candidate) => candidate.assetId === asset.id);
    const probe = previous?.probe ?? (asset.kind === "video" && generation.provider !== "mock" && status === "ready"
      ? await probeMediaUrl(asset.url)
      : undefined);
    return {
      beatId: beat.id,
      generationId: generation.id,
      assetId: asset.id,
      kind: asset.kind === "video" ? "video" as const : "image" as const,
      url: asset.url,
      provider: generation.provider,
      model: generation.model,
      status,
      costCents: generation.costCents,
      error: generation.error,
      probe,
      immutableStorageKey: typeof asset.metadata.storageKey === "string" ? asset.metadata.storageKey : undefined,
      contentSha256: typeof asset.metadata.contentSha256 === "string" ? asset.metadata.contentSha256 : undefined,
      fingerprint: typeof asset.metadata.contentSha256 === "string" ? {
        contentSha256: asset.metadata.contentSha256,
        perceptualHashes: [],
        motionSignature: [],
        sampledAt: [],
      } : undefined,
      recoveryOfGenerationId: typeof generation.metadata.recoveryOfGenerationId === "string" ? generation.metadata.recoveryOfGenerationId : undefined,
      recoveryReason: typeof generation.metadata.recoveryReason === "string" ? generation.metadata.recoveryReason : undefined,
      provenance: {
        origin: "generated" as const,
        creator: generation.provider,
        permittedUse: "Generated editorial visual for this production; never documentary source evidence.",
        acquiredAt: generation.updatedAt,
        transformations: asset.kind === "video" ? ["GPT Image editorial plate", "Seedance image-to-video animation"] : ["GPT Image editorial generation"],
        c2paManifestUrl: typeof asset.metadata.c2paClaim === "string" && /^https:\/\//.test(asset.metadata.c2paClaim) ? asset.metadata.c2paClaim : undefined,
        c2paValidated: false,
      },
    };
  }));
}

async function prepareEditorialMusic(job: VideoJob) {
  if (job.qualityTier === "draft") return;
  const store = getStore();
  const key = `${job.id}:editorial-score:v1`;
  const media = await store.listProjectMedia(job.projectId);
  if (findGeneration(media.generations, key)) return;
  await createProjectMediaGeneration(job.projectId, {
    videoJobId: job.id,
    kind: "music",
    prompt: `Understated instrumental editorial score for ${job.contentType === "news_digest" ? "a cited news documentary" : "a premium educational explainer"}. ${job.visualPlan?.resolvedPreset.replaceAll("_", " ") ?? "prestige documentary"}; no vocals, no dialogue, clear pulse, restrained transitions, supports narration without competing with it.`,
    controls: {
      durationSeconds: Math.min(120, Math.max(12, job.durationSeconds)),
      musicControls: { vocals: "instrumental", genre: "orchestral", tempo: "mid", intensity: "medium" },
      globalStyle: "instrumental editorial underscore, modern cinematic restraint, sparse percussion, evolving atmosphere",
      negativeStyle: "vocals, spoken words, aggressive lead melody, comedy, trailer bombast",
    },
    inputAssetIds: [],
    execute: true,
    idempotencyKey: key,
    label: "Editorial score",
  });
}

export async function prepareEditorialScore(videoId: string) {
  const job = await requireHybridJob(videoId);
  await prepareEditorialMusic(job);
  return syncHybridVisualAssets(videoId);
}

function withMockProxyAssets(plan: HybridVisualPlanV2): HybridVisualPlanV2 {
  return {
    ...plan,
    beats: plan.beats.map((beat) => GENERATED_KINDS.has(beat.kind) ? {
      ...beat,
      assets: [{ beatId: beat.id, kind: "graphic", provider: "mock", model: "deterministic-hybrid-proxy", status: "ready", costCents: 0 }],
    } : beat),
  };
}

async function persistPlan(job: VideoJob, visualPlan: HybridVisualPlanV2) {
  return getStore().mutateJob(job.id, (current) => ({
    visualPlan,
    storyboard: current.storyboard ? attachVisualPlanToStoryboard(current.storyboard, visualPlan) : undefined,
  }));
}

async function annotateRecovery(
  generation: MediaGeneration,
  options: { identitySafe?: boolean; retryFailed?: boolean; forceRegenerate?: boolean; recoveryOfGenerationId?: string; recoveryReason?: string },
  attempt: number,
) {
  if (!options.identitySafe && !options.retryFailed && !options.recoveryOfGenerationId && attempt === 1) return generation;
  return getStore().updateMediaGeneration(generation.id, {
    metadata: {
      ...generation.metadata,
      attempt,
      recoveryOfGenerationId: options.recoveryOfGenerationId,
      recoveryReason: options.recoveryReason ?? (options.identitySafe ? "fal_likeness_policy" : options.forceRegenerate ? "visual_rough_cut_autopolish" : options.retryFailed ? "transient_provider_failure" : undefined),
      fallbackPolicy: options.identitySafe ? "identity_safe_editorial_visualization" : options.forceRegenerate ? "regenerate_failed_quality_unit" : options.retryFailed ? "retry_same_visual" : "manual_regeneration",
      heartbeatAt: new Date().toISOString(),
    },
  });
}

function identitySafePrompt(beat: VisualBeat, job: VideoJob) {
  const palette = job.visualPlan?.continuityKit.palette.join(", ") ?? "deep editorial green, charcoal, restrained warm highlights";
  return [
    `Premium ${job.visualPlan?.resolvedPreset.replaceAll("_", " ") ?? "prestige documentary"} editorial visualization.`,
    `Preserve the exact approved subject and meaning: ${beat.shotSpec?.subject ?? beat.intent}.`,
    `Preserve the approved setting and material details: ${beat.shotSpec?.setting ?? beat.intent}.`,
    `Show the supported mechanism or action through objects only: ${beat.shotSpec?.action ?? beat.intent}.`,
    `Narrative function: ${beat.shotSpec?.narrativeFunction ?? beat.intent}. Composition: ${beat.shotSpec?.composition ?? "clear authored editorial depth"}.`,
    `Camera language: ${beat.shotSpec?.size ?? "medium"}, ${beat.shotSpec?.angle ?? "eye_level"}, ${beat.shotSpec?.focalLength ?? "natural perspective"}, ${beat.shotSpec?.cameraMovement ?? "dolly"}.`,
    `Palette: ${palette}.`,
    "Depict the idea only through environments, objects, architecture, documents, machines, data light, maps, or abstract physical metaphors.",
    "ABSOLUTELY NO people, faces, heads, bodies, hands, portraits, performers, crowds, human silhouettes, biometric likenesses, names, logos, quotations, captions, or interface text.",
    "Cinematic depth, motivated practical lighting, coherent lens language, no unsupported event or action. This is illustrative atmosphere, never documentary evidence.",
  ].join(" ");
}

function generationKey(videoId: string, beatId: string, lane: "image" | "video") {
  return `${videoId}:visual:${beatId}:${lane}:v1`;
}

function findGeneration(generations: MediaGeneration[], idempotencyKey: string) {
  return generations.find((generation) => generation.metadata.idempotencyKey === idempotencyKey);
}

function latestBeatGeneration(generations: MediaGeneration[], videoId: string, beatId: string, kind: "image" | "video") {
  return generations
    .filter((generation) => generation.videoJobId === videoId && generation.kind === kind && generation.controls.visualBeatId === beatId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

function providerDuration(beat: VisualBeat) {
  return Math.max(4, Math.min(15, Math.ceil((beat.endMs - beat.startMs) / 1_000)));
}

function imageSize(aspectRatio: VideoJob["aspectRatio"], qualityTier: VideoJob["qualityTier"]) {
  if (qualityTier === "premium") {
    if (aspectRatio === "9:16") return "2160x3840";
    if (aspectRatio === "1:1") return "2048x2048";
    return "3840x2160";
  }
  if (aspectRatio === "9:16") return "1024x1536";
  if (aspectRatio === "1:1") return "1024x1024";
  return "1536x1024";
}

async function requireHybridJob(videoId: string) {
  const job = await getStore().getJob(videoId);
  if (!job || (job.contentType !== "news_digest" && job.contentType !== "explainer")) throw new Error("Hybrid editorial production not found.");
  return job;
}
