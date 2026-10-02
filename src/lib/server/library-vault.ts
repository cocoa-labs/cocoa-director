import type { MediaAsset, MediaGeneration, MediaKind, VideoJob } from "@/lib/schemas";
import { getStore } from "@/lib/server/store";

export async function promoteMediaGenerationToLibrary(
  generation: MediaGeneration,
  assets: MediaAsset[] = [],
) {
  if (generation.status !== "success") return null;

  const store = getStore();
  const project = await store.getProject(generation.projectId);
  if (!project) return null;

  const media = assets.length > 0 ? { assets } : await store.listProjectMedia(generation.projectId);
  const asset = await resolvePromotableAsset(generation, media.assets);
  if (!asset) return null;

  const existing = await findExistingVaultAsset(project.userId, generation, asset);
  if (existing) {
    await store.createProjectAssetLink({
      projectId: generation.projectId,
      libraryAssetId: existing.id,
      mediaAssetId: asset.id,
    });
    return { libraryAsset: existing, mediaAsset: asset };
  }

  const libraryAsset = await store.createLibraryAsset({
    userId: project.userId,
    kind: asset.kind,
    name: generationLibraryName(generation, asset),
    role: generationLibraryRole(generation, asset),
    url: asset.url,
    mimeType: asset.mimeType,
    source: "generation",
    tags: generationLibraryTags(generation, asset),
    metadata: generationLibraryMetadata(project.name, generation, asset),
  });
  await store.createProjectAssetLink({
    projectId: generation.projectId,
    libraryAssetId: libraryAsset.id,
    mediaAssetId: asset.id,
  });
  return { libraryAsset, mediaAsset: asset };
}

export async function syncProjectMediaToLibrary(projectId: string) {
  const store = getStore();
  const [media, jobs] = await Promise.all([
    store.listProjectMedia(projectId),
    store.listProjectJobs(projectId),
  ]);
  await Promise.all(
    [
      ...media.generations
        .filter((generation) => generation.status === "success")
        .map((generation) => promoteMediaGenerationToLibrary(generation, media.assets)),
      ...jobs
        .filter((job) => Boolean(job.finalVideoUrl))
        .map((job) => promoteFinalRenderToLibrary(job)),
    ],
  );
}

export async function promoteFinalRenderToLibrary(job: VideoJob) {
  if (!job.finalVideoUrl) return null;

  const store = getStore();
  const project = await store.getProject(job.projectId);
  if (!project) return null;

  const media = await store.listProjectMedia(job.projectId);
  const mediaAsset = media.assets.find((asset) =>
    asset.kind === "render" &&
    asset.role === "final_music_video" &&
    asset.url === job.finalVideoUrl &&
    (
      asset.videoJobId === job.id ||
      stringMetadata(asset.metadata.videoJobId) === job.id
    )
  ) ?? await store.createMediaAsset({
    projectId: job.projectId,
    videoJobId: job.id,
    kind: "render",
    role: "final_music_video",
    url: job.finalVideoUrl,
    mimeType: "video/mp4",
    metadata: finalRenderMetadata(project.name, job),
  });

  const existing = await findExistingRenderVaultAsset(project.userId, job, mediaAsset);
  if (existing) {
    await store.createProjectAssetLink({
      projectId: job.projectId,
      libraryAssetId: existing.id,
      mediaAssetId: mediaAsset.id,
    });
    return { libraryAsset: existing, mediaAsset };
  }

  const libraryAsset = await store.createLibraryAsset({
    userId: project.userId,
    kind: "render",
    name: finalRenderLibraryName(job),
    role: "final_music_video",
    url: job.finalVideoUrl,
    mimeType: "video/mp4",
    source: "render",
    tags: finalRenderTags(job),
    metadata: {
      ...finalRenderMetadata(project.name, job),
      mediaAssetId: mediaAsset.id,
    },
  });
  await store.createProjectAssetLink({
    projectId: job.projectId,
    libraryAssetId: libraryAsset.id,
    mediaAssetId: mediaAsset.id,
  });
  return { libraryAsset, mediaAsset };
}

async function resolvePromotableAsset(generation: MediaGeneration, assets: MediaAsset[]) {
  const store = getStore();
  const assetId = stringMetadata(generation.metadata.assetId);
  const existing =
    (assetId ? assets.find((asset) => asset.id === assetId) : undefined) ??
    assets.find((asset) => asset.generationId === generation.id);
  if (existing) return existing;

  const output = Object.entries(generation.outputUrls)[0];
  if (!output) return null;
  const [role, url] = output;
  return store.createMediaAsset({
    projectId: generation.projectId,
    videoJobId: generation.videoJobId,
    generationId: generation.id,
    kind: generation.kind,
    role,
    url,
    mimeType: mimeTypeForKind(generation.kind),
    metadata: {
      generationId: generation.id,
      recoveredFromOutputUrls: true,
    },
  });
}

async function findExistingVaultAsset(userId: string, generation: MediaGeneration, asset: MediaAsset) {
  const libraryAssets = await getStore().listLibraryAssets(userId);
  return libraryAssets.find((candidate) => {
    if (candidate.source !== "generation") return false;
    return (
      stringMetadata(candidate.metadata.generationId) === generation.id ||
      stringMetadata(candidate.metadata.mediaAssetId) === asset.id
    );
  });
}

async function findExistingRenderVaultAsset(userId: string, job: VideoJob, asset: MediaAsset) {
  const libraryAssets = await getStore().listLibraryAssets(userId);
  return libraryAssets.find((candidate) => {
    if (candidate.source !== "render" || candidate.kind !== "render") return false;
    return (
      stringMetadata(candidate.metadata.videoJobId) === job.id &&
      candidate.url === job.finalVideoUrl
    ) || stringMetadata(candidate.metadata.mediaAssetId) === asset.id;
  });
}

function generationLibraryName(generation: MediaGeneration, asset: MediaAsset) {
  const label = stringMetadata(generation.metadata.label);
  if (label) return label;
  const assetName = stringMetadata(asset.metadata.name);
  if (assetName) return assetName;
  if (generation.kind === "image") return "Cocoa Director image";
  if (generation.kind === "video") return "Cocoa Director video";
  if (generation.kind === "music") return "Cocoa Director music";
  return "Cocoa Director render";
}

function finalRenderLibraryName(job: VideoJob) {
  const prompt = job.prompt.trim();
  if (!prompt) return "Cocoa Director music video";
  return `${prompt.slice(0, 96)}${prompt.length > 96 ? "..." : ""}`;
}

function generationLibraryRole(generation: MediaGeneration, asset: MediaAsset) {
  if (asset.role) return asset.role;
  if (generation.kind === "image") return "image_reference";
  if (generation.kind === "video") return "video_reference";
  if (generation.kind === "music") return "music_reference";
  return "render_output";
}

function finalRenderTags(job: VideoJob) {
  return Array.from(new Set([
    "finished",
    "music-video",
    "render",
    job.aspectRatio,
    job.visualMode,
  ].filter(Boolean)));
}

function generationLibraryTags(generation: MediaGeneration, asset: MediaAsset) {
  return Array.from(new Set(["generated", generation.kind, generation.provider, asset.role].filter(Boolean)));
}

function finalRenderMetadata(projectName: string, job: VideoJob) {
  return {
    sourceProjectName: projectName,
    projectId: job.projectId,
    videoJobId: job.id,
    prompt: job.prompt,
    provider: "vercel",
    model: "sandbox-ffmpeg",
    status: job.status,
    durationSeconds: job.durationSeconds,
    aspectRatio: job.aspectRatio,
    visualMode: job.visualMode,
    thumbnailUrl: job.thumbnailUrl,
    finalVideoUrl: job.finalVideoUrl,
    renderManifest: job.renderManifest,
    musicTrackUrl: job.musicTrack?.url,
    shotCount: job.generatedShots.length,
    actualCostCents: job.actualCostCents,
    estimatedCostCents: job.estimatedCostCents,
    renderedAt: job.updatedAt,
  };
}

function generationLibraryMetadata(projectName: string, generation: MediaGeneration, asset: MediaAsset) {
  return {
    ...asset.metadata,
    sourceProjectName: projectName,
    projectId: generation.projectId,
    videoJobId: generation.videoJobId,
    generationId: generation.id,
    mediaAssetId: asset.id,
    prompt: generation.prompt,
    provider: generation.provider,
    model: generation.model,
    status: generation.status,
    controls: generation.controls,
    costCents: generation.costCents,
    requestId: generation.requestId,
    outputUrls: generation.outputUrls,
    generatedAt: generation.updatedAt,
    durationSeconds: numberMetadata(asset.metadata.durationSeconds) ?? numberMetadata(generation.controls.durationSeconds),
    width: numberMetadata(asset.metadata.width),
    height: numberMetadata(asset.metadata.height),
    thumbnailUrl: stringMetadata(asset.metadata.thumbnailUrl),
  };
}

function mimeTypeForKind(kind: MediaKind) {
  if (kind === "image") return "image/png";
  if (kind === "music") return "audio/mpeg";
  if (kind === "video" || kind === "render") return "video/mp4";
  return "application/octet-stream";
}

function stringMetadata(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function numberMetadata(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
