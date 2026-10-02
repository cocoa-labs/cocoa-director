import { criticalSection } from "@/lib/server/critical-section";
import { ApiRequestError } from "@/lib/server/api-error";
import { randomUUID } from "node:crypto";

import { cents } from "@/lib/cost";
import { createArtifactSnapshot } from "@/lib/editor";
import {
  AnchorProviderControls,
  MediaGeneration,
  MediaGenerationCreateRequest,
  MediaGenerationInjectRequest,
  MusicProviderControls,
  ShotProviderControls,
  type AnchorAsset,
  type CreativeBrief,
  type GeneratedShot,
  type MediaAsset,
  type MediaProbeMetadata,
  type MusicControls,
  type MusicPlan,
  type MusicTrack,
  type Shot,
  type VideoJob,
} from "@/lib/schemas";
import { contentSha256, copyRemoteFileToBlob, fingerprintBlobUrl } from "@/lib/server/blob";
import { assertMediaCoversSlot, probeMediaUrl } from "@/lib/server/media-probe";
import {
  getElevenLabsMusicModel,
  getOpenAiImageModel,
  getProviderMode,
  getSeedanceFastEndpoint,
  getSeedanceStandardEndpoint,
  isImmutableGenerationOutputsEnabled,
} from "@/lib/server/config";
import { normalizeProviderError } from "@/lib/server/provider-errors";
import { getStore } from "@/lib/server/store";
import { promoteMediaGenerationToLibrary } from "@/lib/server/library-vault";
import { bindCurrentMediaReservation } from "@/lib/server/budget-ledger";
import { createIdempotencyKey, createTraceId, nowIso } from "@/lib/trace";
import { getProviders } from "@/providers";
import { pollSeedanceShot, submitSeedanceShot } from "@/providers/seedance";
import { resolveCreativeStyleContract } from "@/workflow/creativeStyleContract";
import { createCompositionPlan } from "@/workflow/phases/compositionPlan";

export async function createProjectMediaGeneration(
  projectId: string,
  request: MediaGenerationCreateRequest,
) {
  const store = getStore();
  const claimed = await criticalSection(`media-generation:${projectId}:${request.idempotencyKey ?? randomUUID()}`, async () => {
    if (request.idempotencyKey) {
      const library = await store.listProjectMedia(projectId);
      const existing = library.generations.find((generation) => generation.metadata.idempotencyKey === request.idempotencyKey);
      if (existing) return { generation: existing, created: false };
    }
    const provider = request.provider ?? providerForKind(request.kind);
    const generation = await store.createMediaGeneration({
      projectId, videoJobId: request.videoJobId, kind: request.kind, provider,
      model: modelForRequest(request, provider), status: request.execute ? "running" : "draft",
      prompt: request.prompt, controls: request.controls, inputAssetIds: request.inputAssetIds, outputUrls: {},
      metadata: { idempotencyKey: request.idempotencyKey, label: request.label, source: "cocoa-director", execute: request.execute },
      costCents: 0,
    });
    return { generation, created: true };
  });
  const { generation } = claimed;
  const provider = generation.provider;
  if (!claimed.created) {
    const assets = (await store.listProjectMedia(projectId)).assets.filter((asset) => asset.generationId === generation.id);
    if (generation.status === "success") await promoteMediaGenerationToLibrary(generation, assets);
    return { generation, assets };
  }

  if (!request.execute) return { generation, assets: [] as MediaAsset[] };
  await bindCurrentMediaReservation(projectId, generation.id);

  try {
    const result = await executeMediaGeneration(generation);
    await promoteMediaGenerationToLibrary(result.generation, result.assets);
    return result;
  } catch (error) {
    const normalized = normalizeProviderError(error, provider);
    const message = normalized.userMessage;
    const failed = await store.updateMediaGeneration(generation.id, {
      status: "failed",
      error: message,
      metadata: { ...generation.metadata, providerError: normalized },
    });
    return { generation: failed, assets: [] as MediaAsset[] };
  }
}

export async function pollProjectMediaGenerations(projectId: string) {
  const media = await getStore().listProjectMedia(projectId);
  await Promise.all(
    media.generations
      .filter((generation) =>
        generation.kind === "video" &&
        generation.provider === "fal" &&
        (generation.status === "queued" || generation.status === "running"),
      )
      .map((generation) => pollQueuedVideoGeneration(generation).catch((error) => {
        console.warn(
          JSON.stringify({
            event: "queued_media_generation_poll_failed",
            generationId: generation.id,
            error: error instanceof Error ? error.message : "Unknown poll error",
          }),
        );
      })),
  );
}

export async function executeMediaGeneration(generation: MediaGeneration) {
  if (generation.kind === "image") return generateImage(generation);
  if (generation.kind === "video") return generateVideo(generation);
  if (generation.kind === "music") return generateMusic(generation);
  return generateRenderPlaceholder(generation);
}

export async function injectMediaGeneration(
  projectId: string,
  generationId: string,
  request: MediaGenerationInjectRequest,
) {
  const store = getStore();
  const generation = await store.getMediaGeneration(projectId, generationId);
  const job = await store.getJob(request.videoJobId);

  if (!generation) throw new Error("Media generation not found");
  if (!job || job.projectId !== projectId) throw new Error("Target video job not found");
  if (generation.status !== "success") throw new Error("Only successful media generations can be injected");

  const media = await primaryAssetForGeneration(projectId, generation);
  if (!media) throw new Error("Media generation has no output asset");
  const measured = media.kind === "video" || media.kind === "music" || media.kind === "render"
    ? await measuredMediaForGeneration(generation, media)
    : undefined;

  const snapshot = createArtifactSnapshot(job, snapshotTargetForInjection(request), `Before media injection`);
  const artifactVersions = snapshot ? [...job.artifactVersions, snapshot] : job.artifactVersions;

  if (request.action === "use_as_anchor") {
    const role = request.role ?? "style";
    const anchor: AnchorAsset = {
      role,
      url: media.url,
      promptUsed: generation.prompt,
      c2paClaim: stringMetadata(generation.metadata.c2paClaim),
    };
    const updatedAnchors = [
      ...job.anchorAssets.filter((asset) => asset.role !== role),
      anchor,
    ];
    const updated = await store.updateJob(job.id, {
      anchorAssets: updatedAnchors,
      artifactVersions,
      error: undefined,
    });
    return { job: updated, asset: media, generation };
  }

  if (request.action === "use_as_shot_reference") {
    if (request.shotIndex === undefined || !job.shotPlan) {
      throw new Error("Shot reference injection requires a target shot");
    }
    const updated = await store.updateJob(job.id, {
      shotPlan: {
        ...job.shotPlan,
        shots: job.shotPlan.shots.map((shot) =>
          shot.shotIndex === request.shotIndex
            ? { ...shot, referenceImages: unique([...shot.referenceImages, media.url]).slice(0, 9) }
            : shot,
        ),
      },
      artifactVersions,
      error: undefined,
    });
    return { job: updated, asset: media, generation };
  }

  if (request.action === "replace_selected_shot") {
    if (request.shotIndex === undefined) {
      throw new Error("Shot replacement requires a target shot");
    }
    const planned = job.shotPlan?.shots.find((shot) => shot.shotIndex === request.shotIndex);
    const requestedDurationSeconds = planned
      ? (planned.endMs - planned.startMs) / 1_000
      : numberMetadata(generation.controls.durationSeconds) ?? 8;
    if (!measured) throw new Error("Replacement video could not be measured.");
    assertMediaCoversSlot(measured.durationSeconds, requestedDurationSeconds);
    const generatedShot = generatedShotFromMedia(
      generation,
      media,
      request.shotIndex,
      measured,
      requestedDurationSeconds,
    );
    const updated = await store.updateJob(job.id, {
      generatedShots: [
        ...job.generatedShots.filter((shot) => shot.shotIndex !== request.shotIndex),
        generatedShot,
      ].sort((left, right) => left.shotIndex - right.shotIndex),
      artifactVersions,
      error: undefined,
    });
    return { job: updated, asset: media, generation };
  }

  if (request.action === "use_as_music_track") {
    if (!measured) throw new Error("Replacement soundtrack could not be measured.");
    const musicTrack = musicTrackFromMedia(job, generation, media, measured);
    const updated = await store.updateJob(job.id, {
      musicTrack,
      artifactVersions,
      error: undefined,
    });
    return { job: updated, asset: media, generation };
  }

  if (request.action === "use_in_render_manifest") {
    const renderPatch = renderPatchFromMedia(job, generation, media, request.shotIndex, measured);
    const updated = await store.updateJob(job.id, {
      ...renderPatch,
      artifactVersions,
      error: undefined,
    });
    return { job: updated, asset: media, generation };
  }

  throw new Error(`Unsupported injection action: ${request.action}`);
}

async function measuredMediaForGeneration(
  generation: MediaGeneration,
  media: MediaAsset,
): Promise<MediaProbeMetadata> {
  // Mock-provider URLs intentionally have no backing network asset. Keep that
  // test/dev path deterministic while requiring ffprobe truth for every real
  // provider or user-supplied asset.
  if (generation.provider !== "mock") return probeMediaUrl(media.url);
  const durationSeconds = numberMetadata(generation.controls.durationSeconds) ?? 8;
  const isVideo = media.kind === "video" || media.kind === "render";
  return {
    durationSeconds,
    startTimeSeconds: 0,
    frameRate: isVideo ? 30 : undefined,
    frameCount: isVideo ? Math.round(durationSeconds * 30) : undefined,
    width: isVideo ? 1280 : undefined,
    height: isVideo ? 720 : undefined,
    videoCodec: isVideo ? "mock-h264" : undefined,
    audioCodec: media.kind === "music" || media.kind === "render" ? "mock-aac" : undefined,
    hasAudio: media.kind === "music" || media.kind === "render",
    audioTrackCount: media.kind === "music" || media.kind === "render" ? 1 : 0,
    videoStartTimeSeconds: isVideo ? 0 : undefined,
    audioStartTimeSeconds: media.kind === "music" || media.kind === "render" ? 0 : undefined,
    avStartOffsetMs: media.kind === "render" ? 0 : undefined,
    probedAt: nowIso(),
  };
}

async function generateImage(generation: MediaGeneration) {
  const store = getStore();
  const options = AnchorProviderControls.safeParse(generation.controls).success
    ? AnchorProviderControls.parse(generation.controls)
    : {};
  const role = roleFromControls(generation.controls);
  const references = (await inputAssetsFor(generation)).filter((asset) => asset.kind === "image");
  const providerContext = providerContextForGeneration(generation, 5);
  const result = await getProviders().images.generateAnchorAsset(role, generation.prompt, {
    videoId: generation.videoJobId ?? generation.projectId,
    traceId: traceIdForGeneration(generation),
    phaseNumber: 5,
    idempotencyKey: createIdempotencyKey({ videoId: generation.projectId, phase: 5, nonce: generation.id }),
    outputPathPrefix: providerContext.outputPathPrefix,
    outputAttempt: providerContext.outputAttempt,
  }, options, references.length ? { images: references.map((asset) => ({ url: asset.url, mimeType: asset.mimeType })), intent: "aesthetic", allowLikeness: false } : undefined);
  const durableUrl = await durableMediaUrl(generation, result.data.url, "image", imageMimeType(options.outputFormat));
  const fingerprint = await mediaFingerprint(durableUrl);
  const asset = await store.createMediaAsset({
    projectId: generation.projectId,
    videoJobId: generation.videoJobId,
    generationId: generation.id,
    kind: "image",
    role,
    url: durableUrl,
    mimeType: imageMimeType(options.outputFormat),
    metadata: {
      promptUsed: result.data.promptUsed,
      c2paClaim: result.data.c2paClaim,
      providerRequestId: result.requestId,
      storageKey: immutableStorageKey(generation, "image", imageMimeType(options.outputFormat)),
      contentSha256: fingerprint.sha256,
      byteLength: fingerprint.byteLength,
      attempt: generationAttempt(generation),
    },
  });
  const updated = await store.updateMediaGeneration(generation.id, {
    status: "success",
    outputUrls: { image: asset.url },
    costCents: cents(result.costUsd),
    requestId: result.requestId,
    metadata: { ...generation.metadata, assetId: asset.id, providerData: result.data },
    error: undefined,
  });
  return { generation: updated, assets: [asset] };
}

async function generateVideo(generation: MediaGeneration) {
  const store = getStore();
  const job = generation.videoJobId ? await store.getJob(generation.videoJobId) : null;
  const controls = shotControlsFromGeneration(generation);
  const inputAssets = await inputAssetsFor(generation);
  const shot = syntheticShot(generation, controls, inputAssets);
  const brief = job?.creativeBrief ?? syntheticBrief(generation, job);
  if (getProviderMode() === "live") {
    const providerContext = providerContextForGeneration(generation, 7);
    const submission = await submitSeedanceShot(shot, brief, {
      videoId: generation.videoJobId ?? generation.projectId,
      traceId: job?.traceId ?? traceIdForGeneration(generation),
      phaseNumber: 7,
      idempotencyKey: createIdempotencyKey({ videoId: generation.projectId, phase: 7, nonce: generation.id }),
      outputPathPrefix: providerContext.outputPathPrefix,
      outputAttempt: providerContext.outputAttempt,
    });
    const updated = await store.updateMediaGeneration(generation.id, {
      status: submission.queueStatus === "IN_PROGRESS" ? "running" : "queued",
      requestId: submission.requestId,
      metadata: {
        ...generation.metadata,
        brief,
        seedanceSubmission: submission,
        shot,
        submittedAt: nowIso(),
      },
    });
    return { generation: updated, assets: [] as MediaAsset[] };
  }

  const providerContext = providerContextForGeneration(generation, 7);
  const result = await getProviders().video.generateShot(shot, brief, {
    videoId: generation.videoJobId ?? generation.projectId,
    traceId: job?.traceId ?? traceIdForGeneration(generation),
    phaseNumber: 7,
    idempotencyKey: createIdempotencyKey({ videoId: generation.projectId, phase: 7, nonce: generation.id }),
    outputPathPrefix: providerContext.outputPathPrefix,
    outputAttempt: providerContext.outputAttempt,
  }, controls);
  const durableVideoUrl = await durableMediaUrl(generation, result.data.videoUrl, "video", "video/mp4");
  const fingerprint = await mediaFingerprint(durableVideoUrl);
  const asset = await store.createMediaAsset({
    projectId: generation.projectId,
    videoJobId: generation.videoJobId,
    generationId: generation.id,
    kind: "video",
    role: "seedance_clip",
    url: durableVideoUrl,
    mimeType: "video/mp4",
    metadata: {
      durationSeconds: result.data.durationSeconds,
      seed: result.data.seed,
      shotIndex: result.data.shotIndex,
      providerRequestId: result.requestId,
      providerVideoUrl: result.data.sourceVideoUrl ?? result.data.videoUrl,
      providerResultVideoUrl: result.data.videoUrl,
      storageKey: immutableStorageKey(generation, "video", "video/mp4"),
      contentSha256: fingerprint.sha256,
      byteLength: fingerprint.byteLength,
      attempt: generationAttempt(generation),
    },
  });
  const updated = await store.updateMediaGeneration(generation.id, {
    status: "success",
    outputUrls: { video: asset.url },
    costCents: cents(result.costUsd),
    requestId: result.requestId,
    metadata: {
      ...generation.metadata,
      assetId: asset.id,
      providerData: {
        ...result.data,
        videoUrl: durableVideoUrl,
        providerVideoUrl: result.data.sourceVideoUrl ?? result.data.videoUrl,
        providerResultVideoUrl: result.data.videoUrl,
      },
    },
    error: undefined,
  });
  return { generation: updated, assets: [asset] };
}

export async function pollQueuedVideoGeneration(generation: MediaGeneration) {
  const store = getStore();
  const requestId = generation.requestId ?? stringMetadata(generation.metadata.requestId);
  const submittedAt = stringMetadata(generation.metadata.submittedAt) ?? generation.updatedAt;
  const shot = generation.metadata.shot as Shot | undefined;
  const brief = generation.metadata.brief as CreativeBrief | undefined;
  if (!requestId || !shot || !brief) return generation;

  let result: Awaited<ReturnType<typeof pollSeedanceShot>>;
  try {
    const providerContext = providerContextForGeneration(generation, 7);
    result = await pollSeedanceShot(shot, requestId, submittedAt, {
      videoId: generation.videoJobId ?? generation.projectId,
      traceId: traceIdForGeneration(generation),
      phaseNumber: 7,
      idempotencyKey: createIdempotencyKey({ videoId: generation.projectId, phase: 7, nonce: generation.id }),
      outputPathPrefix: providerContext.outputPathPrefix,
      outputAttempt: providerContext.outputAttempt,
    });
  } catch (error) {
    const normalized = normalizeProviderError(error, "fal");
    const message = normalized.userMessage;
    const failed = await store.updateMediaGeneration(generation.id, {
      status: "failed",
      error: message,
      metadata: {
        ...generation.metadata,
        queueStatus: "FAILED",
        providerError: normalized,
        errorCode: normalized.code,
        retryable: normalized.retryable,
        heartbeatAt: new Date().toISOString(),
      },
    });
    await recordQueuedVideoAuditEvent(failed, "failed", 0, message);
    return failed;
  }

  if (result.state === "queued" || result.state === "running") {
    return store.updateMediaGeneration(generation.id, {
      status: result.state,
      metadata: {
        ...generation.metadata,
        queueStatus: result.queueStatus,
        heartbeatAt: new Date().toISOString(),
      },
    });
  }

  if (result.state === "retryable_failed") {
    return store.updateMediaGeneration(generation.id, {
      status: "running",
      error: result.error,
      metadata: {
        ...generation.metadata,
        queueStatus: result.queueStatus,
        retryableError: result.error,
        heartbeatAt: new Date().toISOString(),
      },
    });
  }

  if (result.state !== "complete") return generation;

  const durableVideoUrl = await durableMediaUrl(generation, result.data.videoUrl, "video", "video/mp4");
  const fingerprint = await mediaFingerprint(durableVideoUrl);
  const asset = await store.createMediaAsset({
    projectId: generation.projectId,
    videoJobId: generation.videoJobId,
    generationId: generation.id,
    kind: "video",
    role: "seedance_clip",
    url: durableVideoUrl,
    mimeType: "video/mp4",
    metadata: {
      durationSeconds: result.data.durationSeconds,
      seed: result.data.seed,
      shotIndex: result.data.shotIndex,
      providerRequestId: result.requestId,
      providerVideoUrl: result.data.sourceVideoUrl ?? result.data.videoUrl,
      providerResultVideoUrl: result.data.videoUrl,
      storageKey: immutableStorageKey(generation, "video", "video/mp4"),
      contentSha256: fingerprint.sha256,
      byteLength: fingerprint.byteLength,
      attempt: generationAttempt(generation),
    },
  });
  const updated = await store.updateMediaGeneration(generation.id, {
    status: "success",
    outputUrls: { video: asset.url },
    costCents: cents(result.costUsd),
    requestId: result.requestId,
    metadata: {
      ...generation.metadata,
      assetId: asset.id,
      heartbeatAt: new Date().toISOString(),
      providerData: {
        ...result.data,
        videoUrl: durableVideoUrl,
        providerVideoUrl: result.data.sourceVideoUrl ?? result.data.videoUrl,
        providerResultVideoUrl: result.data.videoUrl,
      },
    },
    error: undefined,
  });
  await recordQueuedVideoAuditEvent(updated, "success", cents(result.costUsd));
  await maybeCreateSessionVersionForQueuedGeneration(updated, asset);
  await promoteMediaGenerationToLibrary(updated, [asset]);
  return updated;
}

async function recordQueuedVideoAuditEvent(
  generation: MediaGeneration,
  status: "success" | "failed",
  actualCostCents: number,
  error?: string,
) {
  const store = getStore();
  const project = await store.getProject(generation.projectId);
  if (!project) return;
  const existing = await store.listProviderAuditEvents(1000);
  if (existing.some((event) =>
    event.mediaGenerationId === generation.id &&
    event.status === status &&
    event.requestId === generation.requestId
  )) {
    return;
  }
  await store.createProviderAuditEvent({
    userId: project.userId,
    projectId: generation.projectId,
    videoJobId: generation.videoJobId,
    mediaGenerationId: generation.id,
    provider: generation.provider,
    model: generation.model,
    status,
    estimatedCostCents: 0,
    actualCostCents,
    requestId: generation.requestId,
    idempotencyKey: stringMetadata(generation.metadata.idempotencyKey),
    billingKey: status === "success" ? `media-generation:${generation.id}` : undefined,
    error,
    metadata: {
      kind: generation.kind,
      source: "queued_media_generation_poll",
      providerPausedAtCompletion: process.env.PROVIDER_CALLS_ENABLED === "false",
    },
  });
}

async function maybeCreateSessionVersionForQueuedGeneration(generation: MediaGeneration, asset: MediaAsset) {
  const store = getStore();
  const sessionId = stringMetadata(generation.metadata.mediaSessionId);
  if (!sessionId) return;
  const session = await store.getMediaSession(generation.projectId, sessionId);
  if (!session || session.versions.some((version) => version.generationId === generation.id)) return;
  const parentVersionId = stringMetadata(generation.metadata.parentVersionId);
  const version = await store.createMediaSessionVersion({
    sessionId,
    assetId: asset.id,
    generationId: generation.id,
    label: stringMetadata(generation.metadata.versionLabel) ?? `Version ${session.versions.length + 1}`,
    prompt: generation.prompt,
    controls: generation.controls,
    parentVersionId,
    notes: "Generated from queued Seedance media session.",
  });
  await store.updateMediaSession(sessionId, {
    currentAssetId: asset.id,
    status: "active",
    settings: rememberedMediaSessionSettings(session.settings, generation.prompt, generation.controls, generation.provider),
  });
  return version;
}

async function generateMusic(generation: MediaGeneration) {
  const store = getStore();
  const job = generation.videoJobId ? await store.getJob(generation.videoJobId) : null;
  const controls = MusicProviderControls.safeParse(generation.controls).success
    ? MusicProviderControls.parse(generation.controls)
    : {};
  const plan = await musicPlanForGeneration(generation, job, controls);
  const result = await getProviders().music.compose(plan, {
    videoId: generation.videoJobId ?? generation.projectId,
    traceId: job?.traceId ?? traceIdForGeneration(generation),
    phaseNumber: 3,
    idempotencyKey: createIdempotencyKey({ videoId: generation.projectId, phase: 3, nonce: generation.id }),
  }, controls);
  const asset = await store.createMediaAsset({
    projectId: generation.projectId,
    videoJobId: generation.videoJobId,
    generationId: generation.id,
    kind: "music",
    role: "music_track",
    url: await durableMediaUrl(generation, result.data.url, "music", "audio/mpeg"),
    mimeType: "audio/mpeg",
    metadata: {
      durationSeconds: result.data.durationSeconds,
      songId: result.data.songId,
      providerRequestId: result.requestId,
      title: result.data.title,
      genres: result.data.genres,
      languages: result.data.languages,
      isExplicit: result.data.isExplicit,
    },
  });
  const updated = await store.updateMediaGeneration(generation.id, {
    status: "success",
    outputUrls: { music: asset.url },
    costCents: cents(result.costUsd),
    requestId: result.requestId,
    metadata: { ...generation.metadata, assetId: asset.id, plan, providerData: result.data },
    error: undefined,
  });
  return { generation: updated, assets: [asset] };
}

async function generateRenderPlaceholder(generation: MediaGeneration) {
  const store = getStore();
  const updated = await store.updateMediaGeneration(generation.id, {
    status: "success",
    outputUrls: {},
    metadata: {
      ...generation.metadata,
      note: "Render generations use the canonical render pipeline; standalone render command recorded.",
    },
  });
  return { generation: updated, assets: [] as MediaAsset[] };
}

async function inputAssetsFor(generation: MediaGeneration) {
  const store = getStore();
  const assets = await Promise.all(
    [...new Set(generation.inputAssetIds)].map((assetId) => store.getMediaAsset(generation.projectId, assetId)),
  );
  if (assets.some((asset) => !asset)) throw new ApiRequestError("An input asset is unavailable in this project.", 404, "input_asset_not_found");
  return assets.filter((asset): asset is MediaAsset => Boolean(asset));
}

async function primaryAssetForGeneration(projectId: string, generation: MediaGeneration) {
  const store = getStore();
  const library = await store.listProjectMedia(projectId);
  const assetId = stringMetadata(generation.metadata.assetId);
  return (
    (assetId ? library.assets.find((asset) => asset.id === assetId) : undefined) ??
    library.assets.find((asset) => asset.generationId === generation.id) ??
    assetFromOutputUrls(generation)
  );
}

function assetFromOutputUrls(generation: MediaGeneration): MediaAsset | null {
  const entry = Object.entries(generation.outputUrls)[0];
  if (!entry) return null;
  return {
    id: randomUUID(),
    projectId: generation.projectId,
    videoJobId: generation.videoJobId,
    generationId: generation.id,
    kind: generation.kind,
    role: entry[0],
    url: entry[1],
    mimeType: mimeTypeForKind(generation.kind),
    metadata: {},
    createdAt: generation.updatedAt,
  };
}

async function durableMediaUrl(
  generation: MediaGeneration,
  url: string,
  lane: string,
  contentType: string,
) {
  const desiredPath = immutableStorageKey(generation, lane, contentType);
  if (url.includes(`/generations/${generation.id}/`) || url.includes(`/media/${generation.id}/`)) return url;
  if (getProviderMode() !== "live" || !/^https?:\/\//i.test(url)) return url;
  const extension = extensionForContentType(contentType);
  const blob = await copyRemoteFileToBlob({
    url,
    pathname: desiredPath || `projects/${generation.projectId}/media/${generation.id}/${lane}.${extension}`,
    contentType,
    immutable: true,
  });
  return blob.url;
}

function providerContextForGeneration(generation: MediaGeneration, phaseNumber: 5 | 7) {
  const editorial = isImmutableGenerationOutputsEnabled() && typeof generation.controls.visualBeatId === "string";
  return {
    outputPathPrefix: editorial ? immutableOutputPrefix(generation) : undefined,
    outputAttempt: editorial ? generationAttempt(generation) : undefined,
    phaseNumber,
  };
}

export function immutableOutputPrefix(generation: MediaGeneration) {
  const productionId = generation.videoJobId ?? generation.projectId;
  const beatId = sanitizeStoragePart(stringMetadata(generation.controls.visualBeatId) ?? "standalone");
  const lane = generation.kind === "video" ? "video" : generation.kind === "image" ? "image" : generation.kind;
  return `projects/${generation.projectId}/productions/${productionId}/generations/${generation.id}/${beatId}/${lane}/attempt-${generationAttempt(generation)}`;
}

export function immutableStorageKey(generation: MediaGeneration, lane: string, contentType: string) {
  const extension = extensionForContentType(contentType);
  return `${immutableOutputPrefix(generation)}/${sanitizeStoragePart(lane)}.${extension}`;
}

function generationAttempt(generation: MediaGeneration) {
  const value = numberMetadata(generation.metadata.attempt) ?? numberMetadata(generation.controls.generationAttempt);
  return Math.max(1, value ? Math.floor(value) : 1);
}

function sanitizeStoragePart(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "asset";
}

function providerForKind(kind: MediaGeneration["kind"]): MediaGeneration["provider"] {
  if (kind === "image") return getProviderMode() === "live" ? "openai" : "mock";
  if (kind === "video") return getProviderMode() === "live" ? "fal" : "mock";
  if (kind === "music") return getProviderMode() === "live" ? "elevenlabs" : "mock";
  return "vercel-render";
}

async function mediaFingerprint(url: string) {
  return getProviderMode() === "mock"
    ? { sha256: contentSha256(url), byteLength: 0 }
    : fingerprintBlobUrl(url);
}

function modelForRequest(
  request: MediaGenerationCreateRequest,
  provider: MediaGeneration["provider"],
) {
  if (provider === "openai") return stringMetadata(request.controls.model) ?? getOpenAiImageModel();
  if (provider === "fal") {
    return request.controls.seedanceTier === "fast" ? getSeedanceFastEndpoint() : getSeedanceStandardEndpoint();
  }
  if (provider === "elevenlabs") return getElevenLabsMusicModel();
  if (provider === "vercel-render") return "remotion-render";
  return `mock-${request.kind}`;
}

function roleFromControls(controls: Record<string, unknown>): AnchorAsset["role"] {
  const role = controls.role;
  if (role === "character" || role === "style" || role === "environment" || role === "palette" || role === "title") {
    return role;
  }
  return "style";
}

function shotControlsFromGeneration(generation: MediaGeneration): ShotProviderControls {
  const parsed = ShotProviderControls.safeParse(generation.controls);
  return parsed.success ? parsed.data : {};
}

function syntheticShot(
  generation: MediaGeneration,
  controls: ReturnType<typeof shotControlsFromGeneration>,
  inputAssets: MediaAsset[],
): Shot {
  const durationSeconds = clampNumber(numberMetadata(controls.durationSeconds) ?? 8, 4, 15);
  const referenceImages = inputAssets.filter((asset) => asset.kind === "image").map((asset) => asset.url).slice(0, 9);
  return {
    shotIndex: numberMetadata(generation.metadata.shotIndex) ?? 0,
    startMs: 0,
    endMs: durationSeconds * 1000,
    seedanceMode: controls.seedanceMode ?? (referenceImages.length > 0 ? "reference-to-video" : "text-to-video"),
    seedanceTier: controls.seedanceTier ?? "standard",
    resolution: controls.resolution ?? "720p",
    prompt: shotPrompt(generation.prompt),
    referenceImages,
    audioReferenceUrl: stringMetadata(controls.audioReferenceUrl),
    audioReferenceUrls: undefined,
    referenceVideos: inputAssets.filter((asset) => asset.kind === "video").map((asset) => asset.url).slice(0, 3),
    seedanceAspectRatio: controls.aspectRatio ?? "9:16",
    generateAudio: controls.generateAudio ?? false,
    sceneLane: stringMetadata(generation.controls.visualBeatId) ? `editorial_${stringMetadata(generation.controls.visualBeatKind) ?? "cinematic"}` : "cocoa_director_standalone",
    visualMotif: stringMetadata(generation.controls.visualMotif) ?? "user-directed media lab motif",
    cameraIntent: stringMetadata(generation.controls.motionDirection) ?? "standalone generation from Cocoa Director",
    referenceRoles: [],
    seed: controls.seedMode === "randomize" ? randomSeed() : controls.seed ?? randomSeed(),
    internalCuts: [],
  };
}

function syntheticBrief(generation: MediaGeneration, job: VideoJob | null): CreativeBrief {
  const videoId = generation.videoJobId ?? generation.projectId;
  return {
    videoId,
    durationSeconds: job?.durationSeconds ?? 75,
    aspectRatio: job?.aspectRatio ?? "9:16",
    visualMode: job?.visualMode ?? "conceptual",
    storySpine: `A standalone Cocoa Director generation explores: ${generation.prompt}`,
    visualWorld: generation.prompt,
    subject: { type: "abstract", description: "User-directed standalone media generation" },
    energyArc: ["build", "peak", "drop"],
    mood: "directed, cinematic, production-ready",
    genre: "AI media command post",
    safetyNotes: [],
  };
}

function hasActiveMusicControls(controls: MusicControls | undefined): controls is MusicControls {
  if (!controls) return false;
  return (
    (Boolean(controls.genre) && controls.genre !== "auto") ||
    controls.vocals !== "auto" ||
    controls.tempo !== "auto" ||
    Boolean(controls.bpm) ||
    controls.intensity !== "auto"
  );
}

function fitStandaloneMusicDuration(plan: MusicPlan, seconds: number): MusicPlan {
  const count = Math.min(plan.sections.length, Math.floor(seconds / 4));
  const sections = Array.from({ length: count }, (_, index) => plan.sections[Math.round(index * (plan.sections.length - 1) / (count - 1))]);
  const weight = sections.reduce((sum, section) => sum + section.durationSeconds, 0);
  const spare = seconds - count * 4;
  let allocated = 0;
  return { ...plan, sections: sections.map((section, index) => {
    const durationSeconds = index === count - 1 ? seconds - allocated : 4 + Math.floor(spare * section.durationSeconds / weight);
    allocated += durationSeconds;
    return { ...section, durationSeconds };
  }) };
}

async function musicPlanForGeneration(
  generation: MediaGeneration,
  job: VideoJob | null,
  controls: MusicProviderControls,
): Promise<MusicPlan> {
  if (job?.musicPlan) {
    return {
      ...job.musicPlan,
      videoId: generation.videoJobId ?? generation.projectId,
    };
  }

  const duration = clampNumber(
    numberMetadata(controls.durationSeconds ?? generation.controls.durationSeconds) ?? 36,
    12,
    120,
  );

  // When the Music Studio console is engaged, route standalone music through the same genre engine
  // the full pipeline uses, so genre/vocals/tempo/intensity (and lyrics) actually shape the audio
  // instead of the generic instrumental fallback below.
  if (hasActiveMusicControls(controls.musicControls)) {
    const musicControls = controls.musicControls;
    const styleContract = await resolveCreativeStyleContract({
      prompt: generation.prompt,
      visualMode: job?.visualMode ?? "conceptual",
      musicControls,
    } as VideoJob);
    const brief: CreativeBrief = {
      ...syntheticBrief(generation, job),
      durationSeconds: clampNumber(duration, 60, 120), // CreativeBrief requires 60..120
      styleContract,
      musicControls,
      genre: styleContract.musicIntent.primaryGenre,
    };
    return fitStandaloneMusicDuration(await createCompositionPlan(brief), duration);
  }

  const sectionLength = Math.max(4, Math.round(duration / 3));
  return {
    videoId: generation.videoJobId ?? generation.projectId,
    vocal: false,
    voiceFamily: "instrumental",
    bpm: clampNumber(numberMetadata(generation.controls.bpm) ?? 124, 60, 180),
    key: stringMetadata(generation.controls.key) ?? "A minor",
    sections: [
      {
        id: "intro",
        durationSeconds: sectionLength,
        energy: 0.32,
        instrumentation: controls.globalStyle ?? generation.prompt,
      },
      {
        id: "development",
        durationSeconds: sectionLength,
        energy: 0.62,
        instrumentation: `${generation.prompt}; evolving rhythm and wider arrangement`,
      },
      {
        id: "resolve",
        durationSeconds: Math.max(4, duration - sectionLength * 2),
        energy: 0.82,
        instrumentation: `${generation.prompt}; final lift and clean ending`,
      },
    ],
  };
}

function generatedShotFromMedia(
  generation: MediaGeneration,
  media: MediaAsset,
  shotIndex: number,
  probe: MediaProbeMetadata,
  requestedDurationSeconds: number,
): GeneratedShot {
  return {
    shotIndex,
    providerRequestId: generation.requestId ?? generation.id,
    videoUrl: media.url,
    requestedDurationSeconds,
    actualDurationSeconds: probe.durationSeconds,
    usableInSeconds: 0,
    usableOutSeconds: probe.durationSeconds,
    probe,
    durationSeconds: probe.durationSeconds,
    seed: numberMetadata(media.metadata.seed) ?? numberMetadata(generation.controls.seed) ?? 0,
    costUsd: generation.costCents / 100,
    latencyMs: numberMetadata(generation.metadata.latencyMs) ?? 0,
    attempts: 1,
  };
}

function musicTrackFromMedia(
  job: VideoJob,
  generation: MediaGeneration,
  media: MediaAsset,
  probe: MediaProbeMetadata,
): MusicTrack {
  return {
    videoId: job.id,
    url: media.url,
    durationSeconds: probe.durationSeconds,
    songId: stringMetadata(media.metadata.songId) ?? generation.id,
    lyrics: [],
    providerRequestId: generation.requestId ?? generation.id,
    title: stringMetadata(media.metadata.title),
    genres: stringArrayMetadata(media.metadata.genres),
    languages: stringArrayMetadata(media.metadata.languages),
    isExplicit: booleanMetadata(media.metadata.isExplicit),
  };
}

function renderPatchFromMedia(
  job: VideoJob,
  generation: MediaGeneration,
  media: MediaAsset,
  shotIndex?: number,
  probe?: MediaProbeMetadata,
): Partial<VideoJob> {
  if (!job.renderManifest) {
    if (media.kind === "video" || media.kind === "render") return { finalVideoUrl: media.url };
    return {};
  }

  if (media.kind === "music") {
    return {
      renderManifest: {
        ...job.renderManifest,
        music: {
          ...job.renderManifest.music,
          url: media.url,
          durationSeconds: probe?.durationSeconds ?? job.renderManifest.music.durationSeconds,
        },
      },
    };
  }

  if (media.kind === "video" && shotIndex !== undefined) {
    return {
      renderManifest: {
        ...job.renderManifest,
        shots: job.renderManifest.shots.map((shot) =>
          shot.shotIndex === shotIndex
            ? {
                ...shot,
                videoUrl: media.url,
                actualDurationSeconds: probe?.durationSeconds ?? shot.actualDurationSeconds,
                usableOutSeconds: probe?.durationSeconds ?? shot.usableOutSeconds,
                probe: probe ?? shot.probe,
                durationSeconds: probe?.durationSeconds ?? shot.durationSeconds,
              }
            : shot,
        ),
      },
    };
  }

  if (media.kind === "video" || generation.kind === "render") return { finalVideoUrl: media.url };
  return {};
}

function snapshotTargetForInjection(request: MediaGenerationInjectRequest) {
  if (request.action === "use_as_anchor") return { scope: "anchors" as const, phase: 5 as const };
  if (request.action === "use_as_music_track") return { scope: "music" as const, phase: 3 as const };
  if (request.action === "use_in_render_manifest") return { scope: "render" as const, phase: 9 as const };
  return { scope: "shots" as const, phase: 7 as const, targetId: request.shotIndex !== undefined ? String(request.shotIndex) : undefined };
}

function traceIdForGeneration(generation: MediaGeneration) {
  return stringMetadata(generation.metadata.traceId) ?? createTraceId();
}

function shotPrompt(prompt: string) {
  if (prompt.length >= 20) return prompt;
  return `${prompt} with cinematic motion, strong framing, and music-video timing.`;
}

function imageMimeType(format?: string) {
  if (format === "jpeg") return "image/jpeg";
  if (format === "webp") return "image/webp";
  return "image/png";
}

function mimeTypeForKind(kind: MediaGeneration["kind"]) {
  if (kind === "image") return "image/png";
  if (kind === "music") return "audio/mpeg";
  return "video/mp4";
}

function extensionForContentType(contentType: string) {
  if (contentType.includes("png")) return "png";
  if (contentType.includes("jpeg")) return "jpg";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("audio")) return "mp3";
  if (contentType.includes("video")) return "mp4";
  return "bin";
}

function numberMetadata(value: unknown) {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) ? number : undefined;
}

function stringMetadata(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function booleanMetadata(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function stringArrayMetadata(value: unknown) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? (value as string[])
    : undefined;
}

function rememberedMediaSessionSettings(
  settings: Record<string, unknown>,
  prompt: string,
  controls: Record<string, unknown>,
  provider: string,
) {
  return {
    ...settings,
    lastPrompt: prompt,
    lastControls: controls,
    lastProvider: provider,
    lastUpdatedAt: new Date().toISOString(),
  };
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function randomSeed() {
  return Math.floor(Math.random() * 2_147_483_647);
}

function unique(values: string[]) {
  return Array.from(new Set(values));
}
