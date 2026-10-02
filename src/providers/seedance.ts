import { ApiRequestError } from "@/lib/server/api-error";
import { reserveProviderAttempt } from "@/lib/server/budget-ledger";
import { fingerprint } from "@/lib/server/action-request";
import { assertPublicUrl } from "@/lib/server/ssrf";
import { extname } from "node:path";

import { fal, type QueueStatus } from "@fal-ai/client";

import { DEV_BLOB_URL_PREFIX } from "@/lib/constants";
import type { CreativeBrief, GeneratedShot, Shot } from "@/lib/schemas";
import {
  getSeedanceFastEndpoint,
  getSeedanceStandardEndpoint,
  isLikenessVideoEnabled,
  requireEnv,
} from "@/lib/server/config";
import { copyRemoteFileToBlob, fetchBlobUrl } from "@/lib/server/blob";
import { seedanceRateForShot } from "@/lib/provider-pricing";
import type { ProviderContext, ProviderResult, VideoProvider } from "@/providers/types";

function contentTypeForUrl(url: string) {
  switch (extname(url).slice(1).toLowerCase()) {
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "webp": return "image/webp";
    case "mp3": return "audio/mpeg";
    case "wav": return "audio/wav";
    case "mp4": return "video/mp4";
    default: return "application/octet-stream";
  }
}

async function materializeLocalUrlForFal(url: string): Promise<string> {
  if (!url.startsWith(DEV_BLOB_URL_PREFIX)) { await assertPublicUrl(url); return url; }
  const response = await fetchBlobUrl(url);
  const buffer = await response.arrayBuffer();
  const blob = new Blob([buffer], { type: contentTypeForUrl(url) });
  return fal.storage.upload(blob);
}

async function materializeFalRefs<T extends {
  image_url?: string;
  end_image_url?: string;
  image_urls?: string[];
  audio_urls?: string[];
  video_urls?: string[];
}>(input: T): Promise<T> {
  return {
    ...input,
    image_url: input.image_url ? await materializeLocalUrlForFal(input.image_url) : undefined,
    end_image_url: input.end_image_url ? await materializeLocalUrlForFal(input.end_image_url) : undefined,
    image_urls: input.image_urls
      ? await Promise.all(input.image_urls.map(materializeLocalUrlForFal))
      : input.image_urls,
    audio_urls: input.audio_urls
      ? await Promise.all(input.audio_urls.map(materializeLocalUrlForFal))
      : input.audio_urls,
    video_urls: input.video_urls
      ? await Promise.all(input.video_urls.map(materializeLocalUrlForFal))
      : input.video_urls,
  };
}

type SeedanceReferencePolicy = "all" | "visual-only" | "stability-retry";
type SeedanceReferenceRequest = ReturnType<typeof buildSeedanceReferenceRequest>;
type SubmitSeedanceOptions = {
  referenceImages?: string[];
  referencePolicy?: SeedanceReferencePolicy;
};

export type SeedanceQueueSubmission = {
  requestId: string;
  endpoint: string;
  queueStatus: QueueStatus["status"];
  referencePolicy: SeedanceReferencePolicy;
};

export type SeedancePollResult =
  | {
      state: "queued" | "running";
      requestId: string;
      queueStatus: string;
    }
  | {
      state: "retryable_failed";
      requestId: string;
      queueStatus: string;
      error: string;
    }
  | {
      state: "complete";
      requestId: string;
      data: GeneratedShot;
      latencyMs: number;
      costUsd: number;
    };

export function buildSeedanceReferenceRequest(
  shot: Shot,
  brief: CreativeBrief,
  options: { referenceImages?: string[]; referencePolicy?: SeedanceReferencePolicy } = {},
) {
  const duration = providerDurationSecondsForShot(shot);
  const referenceImages = options.referenceImages ?? shot.referenceImages;
  const referencePolicy = options.referencePolicy ?? "all";
  const audioUrls = [
    ...(shot.audioReferenceUrl ? [shot.audioReferenceUrl] : []),
    ...(shot.audioReferenceUrls ?? []),
  ].slice(0, 3);
  const editorial = shot.sceneLane.startsWith("editorial_");
  const mode = shot.seedanceMode ?? "reference-to-video";
  if (mode === "image-to-video" && !referenceImages.length) {
    throw new ApiRequestError("Choose a starting image for image-to-video.", 400, "video_reference_required");
  }
  if (mode === "reference-to-video" && !referenceImages.length && !shot.referenceVideos?.length) {
    throw new ApiRequestError("Choose an image or video reference, or select text-to-video.", 400, "video_reference_required");
  }
  return {
    prompt: [
      `Shot direction: ${sanitizeSeedancePrompt(shot.prompt)}`,
      seedanceShotMetadata(shot, brief),
      mode === "text-to-video" ? "Create the scene from the supplied visual direction."
        : mode === "image-to-video" ? "Animate the supplied starting frame while preserving its visual identity."
        : seedanceReferenceInstruction(brief, referencePolicy, shot.seededCharacter ?? false),
      editorial
        ? "Create a premium cinematic editorial visualization. Preserve any referenced subject identity and wardrobe, but do not invent dialogue, quotations, logos, news chyrons, or documentary-camera claims. The final system will apply citations and synthetic-disclosure labels in post-production. Use coherent natural motion and finish on a clean composition."
        : brief.visualMode === "visible_performer"
        ? "Maintain fictional adult performers aged 25 or older with original, non-celebrity identities and generic wardrobe details. Performer movement stays cinematic, expressive, and music-driven."
        : "Use conceptual music-video language: silhouettes, prompt-derived objects, environments, reflections, rhythmic lighting, color shifts, atmospheric depth, and dance-like motion carry the vocal energy.",
      `Global art direction: ${seedanceVisualContinuity(brief)}`,
      shot.internalCuts.length > 0
        ? `Internal cuts at ${shot.internalCuts.map((cut) => `${cut}ms`).join(", ")}.`
        : "Use one fluid camera move with clear musical rhythm.",
    ].join(" "),
    image_url: mode === "image-to-video" ? referenceImages[0] : undefined,
    end_image_url: mode === "image-to-video" ? referenceImages[1] : undefined,
    image_urls: mode === "reference-to-video" ? referenceImages : undefined,
    video_urls: mode === "reference-to-video" ? shot.referenceVideos : undefined,
    audio_urls: mode === "reference-to-video" && audioUrls.length > 0 ? audioUrls : undefined,
    resolution: shot.resolution,
    duration: String(duration),
    aspect_ratio: shot.seedanceAspectRatio ?? brief.aspectRatio,
    generate_audio: shot.generateAudio ?? false,
    seed: shot.seed,
  };
}

export function seedanceReferenceInstruction(
  brief: CreativeBrief,
  referencePolicy: SeedanceReferencePolicy,
  seededCharacter = false,
) {
  const motifDirection = hasUserDerivedMotifs(brief) ? "user-derived motifs, " : "";
  if (brief.visualMode === "conceptual") {
    if (referencePolicy === "stability-retry") {
      return "Use the provided @Image references as loose visual guidance for style, lighting, palette, atmosphere, and cinematic texture. Prioritize stable motion, clean composition, and clear scene continuity around the prompt-derived visual vocabulary.";
    }
    return `Use the provided @Image references for visual style, lighting, palette, cinematic texture, ${motifDirection}and atmospheric depth. Treat any environment reference as a location atlas for varied chapters.`;
  }
  if (referencePolicy === "visual-only") {
    return seededCharacter
      ? "Use the provided @Image references for visual style, lighting, palette, environment continuity, and cinematic texture. Preserve the exact performer from the references as the visible performer — keep the same true-to-life face, hair, wardrobe, and silhouette; do not invent, substitute, or fictionalize a different person."
      : "Use the provided @Image references for visual style, lighting, palette, environment continuity, and cinematic texture. Create any visible performer as a newly invented fictional adult performer with an original face and generic wardrobe.";
  }
  return "Use @Image1 and @Image2 as locked performer/style references while maintaining strict wardrobe, lighting, palette, and silhouette consistency.";
}

// On a reference rejection we drop one reference image to loosen guidance. When the shot
// carries a user-seeded character (reference index 0), keep it and drop the LAST reference
// instead — so the performer is never swapped for an invented stranger.
export function fallbackReferenceImages(shot: Shot): string[] {
  return shot.seededCharacter ? shot.referenceImages.slice(0, -1) : shot.referenceImages.slice(1);
}

function seedanceShotMetadata(shot: Shot, brief: CreativeBrief) {
  const focusLabel = hasUserDerivedMotifs(brief) ? "visual motif" : "continuity focus";
  return `Shot metadata: scene lane ${shot.sceneLane}; ${focusLabel} ${shot.visualMotif}; camera intent ${shot.cameraIntent}.`;
}

function seedanceVisualContinuity(brief: CreativeBrief) {
  const signature = brief.visualSignature;
  if (!signature) return sanitizeSeedancePrompt(brief.visualWorld);
  const vocabulary = positiveVisualVocabulary(brief);
  const parts = [
    signature.medium,
    `palette ${signature.paletteFamily}`,
    `world grammar ${signature.worldGrammar}`,
    `texture ${signature.texture}`,
    signature.recurringMotifs.length > 0
      ? `user-derived motifs ${signature.recurringMotifs.slice(0, 4).join(", ")}`
      : "preserve palette, lighting, material logic, camera rhythm, and atmosphere",
    `positive visual vocabulary ${vocabulary.join(", ")}`,
  ];
  return sanitizeSeedancePrompt(parts.join("; "));
}

function positiveVisualVocabulary(brief: CreativeBrief) {
  const motifs = brief.visualSignature?.recurringMotifs ?? [];
  if (motifs.length > 0) return unique(motifs).slice(0, 5);
  const contractVocabulary = brief.styleContract?.visualIntent.positiveVocabulary ?? [];
  if (contractVocabulary.length > 0) return unique(contractVocabulary).slice(0, 5);
  if (brief.visualSignature?.id === "live_band_performance") {
    return ["stage light", "instrument texture", "amplifier grille cloth", "cable motion", "drum-riser energy"];
  }
  return ["palette shifts", "material texture", "lighting sources", "setting geometry", "camera rhythm"];
}

function hasUserDerivedMotifs(brief: CreativeBrief) {
  return Boolean(brief.visualSignature?.recurringMotifs.length);
}

export class SeedanceProvider implements VideoProvider {
  async generateShot(
    shot: Shot,
    brief: CreativeBrief,
    context: ProviderContext,
  ): Promise<ProviderResult<GeneratedShot>> {
    const started = Date.now();
    fal.config({ credentials: requireEnv("FAL_KEY") });
    const endpoint = endpointForShot(shot);
    let result: Awaited<ReturnType<typeof fal.subscribe>>;
    let attempts = 1;
    let appliedReferencePolicy: SeedanceReferencePolicy = "all";
    assertAuthorizedLikenessRouting(shot);
    try {
      result = await subscribeToSeedance(endpoint, buildSeedanceReferenceRequest(shot, brief), context);
    } catch (error) {
      if (shot.seededCharacter && isLikenessPolicyRejection(error)) {
        throw authorizedLikenessPolicyError(error);
      }
      const fallbackImages = fallbackReferenceImages(shot);
      if (isReferenceImageRejection(error) && fallbackImages.length > 0) {
        attempts = 2;
        appliedReferencePolicy = "visual-only";
        console.warn(
          JSON.stringify({
            traceId: context.traceId,
            provider: "fal",
            shotIndex: shot.shotIndex,
            fallback: "visual-only-reference-images",
            reason: formatFalError(error),
          }),
        );
        try {
          result = await subscribeToSeedance(
            endpoint,
            buildSeedanceReferenceRequest(shot, brief, {
              referenceImages: fallbackImages,
              referencePolicy: "visual-only",
            }),
            context,
          );
        } catch (fallbackError) {
          if (shot.seededCharacter && isLikenessPolicyRejection(fallbackError)) {
            throw authorizedLikenessPolicyError(fallbackError);
          }
          throw new Error(formatFalError(fallbackError));
        }
      } else {
        throw new Error(formatFalError(error));
      }
    }
    const durationSeconds = providerDurationSecondsForShot(shot);
    const videoUrl = (result.data as { video?: { url?: string } }).video?.url;
    const requestId = result.requestId ?? context.idempotencyKey;
    if (!videoUrl) {
      throw new Error("Seedance did not return a video URL");
    }
    const blob = await copyRemoteFileToBlob({
      url: videoUrl,
      pathname: context.outputPathPrefix
        ? `${context.outputPathPrefix}/video.mp4`
        : `videos/${context.videoId}/shots/shot-${shot.shotIndex}-${fingerprint(context.idempotencyKey).slice(0, 20)}.mp4`,
      contentType: "video/mp4",
      immutable: true,
    });
    const rate = seedanceRateForShot(shot);

    return {
      data: {
        shotIndex: shot.shotIndex,
        providerRequestId: requestId,
        videoUrl: blob.url,
        sourceVideoUrl: videoUrl,
        requestedDurationSeconds: durationSeconds,
        durationSeconds,
        seed: shot.seed,
        costUsd: Number((durationSeconds * rate).toFixed(2)),
        latencyMs: Date.now() - started,
        attempts,
        referencePolicy: appliedReferencePolicy,
        provenance: generatedShotProvenance(shot),
      },
      requestId,
      latencyMs: Date.now() - started,
      costUsd: Number((durationSeconds * rate).toFixed(2)),
    };
  }
}

export async function submitSeedanceShot(
  shot: Shot,
  brief: CreativeBrief,
  context: ProviderContext,
  options: SubmitSeedanceOptions = {},
): Promise<SeedanceQueueSubmission> {
  configureFal();
  assertAuthorizedLikenessRouting(shot);
  const endpoint = endpointForShot(shot);
  const initialPolicy = options.referencePolicy ?? "all";
  try {
    return await submitSeedanceRequest(
      endpoint,
      buildSeedanceReferenceRequest(shot, brief, options),
      context,
      initialPolicy,
    );
  } catch (error) {
    const originalError = formatFalError(error);
    if (shot.seededCharacter && isLikenessPolicyRejection(error)) {
      throw authorizedLikenessPolicyError(error);
    }
    const fallbackImages = fallbackReferenceImages(shot);
    if (initialPolicy === "all" && isReferenceImageRejection(error) && fallbackImages.length > 0) {
      console.warn(
        JSON.stringify({
          traceId: context.traceId,
          provider: "fal",
          shotIndex: shot.shotIndex,
          fallback: "visual-only-reference-images",
          reason: originalError,
        }),
      );
      try {
        return await submitSeedanceRequest(
          endpoint,
          buildSeedanceReferenceRequest(shot, brief, {
            referenceImages: fallbackImages,
            referencePolicy: "visual-only",
          }),
          context,
          "visual-only",
        );
      } catch (fallbackError) {
        if (shot.seededCharacter && isLikenessPolicyRejection(fallbackError)) {
          throw authorizedLikenessPolicyError(fallbackError);
        }
        throw new Error(formatFalError(fallbackError));
      }
    }

    if (initialPolicy !== "stability-retry" && isRetryableSeedanceError(error)) {
      console.warn(
        JSON.stringify({
          traceId: context.traceId,
          provider: "fal",
          shotIndex: shot.shotIndex,
          fallback: "stability-retry",
          reason: originalError,
        }),
      );
      try {
        return await submitSeedanceRequest(
          endpoint,
          buildSeedanceReferenceRequest(shot, brief, {
            referenceImages: stabilityRetryReferences(shot),
            referencePolicy: "stability-retry",
          }),
          context,
          "stability-retry",
        );
      } catch (fallbackError) {
        if (shot.seededCharacter && isLikenessPolicyRejection(fallbackError)) {
          throw authorizedLikenessPolicyError(fallbackError);
        }
        throw new Error(formatFalError(fallbackError));
      }
    }

    throw new Error(originalError);
  }
}

export async function pollSeedanceShot(
  shot: Shot,
  requestId: string,
  submittedAt: string,
  context: ProviderContext,
): Promise<SeedancePollResult> {
  configureFal();
  const endpoint = endpointForShot(shot);
  let queueStatus: QueueStatus;
  try {
    queueStatus = await fal.queue.status(endpoint, { requestId, logs: true });
  } catch (error) {
    if (isRetryableSeedanceError(error)) {
      console.warn(
        JSON.stringify({
          traceId: context.traceId,
          provider: "fal",
          requestId,
          status: "status_lookup_retryable_failed",
          reason: formatFalError(error),
        }),
      );
      return { state: "queued", requestId, queueStatus: "STATUS_LOOKUP_FAILED" };
    }
    throw new Error(`fal status lookup failed for ${requestId}: ${formatFalError(error)}`);
  }
  console.log(
    JSON.stringify({
      traceId: context.traceId,
      provider: "fal",
      requestId,
      status: queueStatus.status,
      logs: "logs" in queueStatus ? queueStatus.logs?.map((log) => log.message).slice(-3) : undefined,
    }),
  );

  if (isTerminalFalQueueFailure(queueStatus.status)) {
    const logs = "logs" in queueStatus ? queueStatus.logs?.map((log) => log.message).slice(-3).join(" | ") : "";
    throw new Error(`fal queue ended with ${queueStatus.status}${logs ? `: ${logs}` : ""}`);
  }

  if (queueStatus.status !== "COMPLETED") {
    return {
      state: queueStatus.status === "IN_PROGRESS" ? "running" : "queued",
      requestId,
      queueStatus: queueStatus.status,
    };
  }

  let result: { data: unknown };
  try {
    result = await fal.queue.result(endpoint, { requestId });
  } catch (error) {
    const message = `fal result lookup failed for ${requestId}: ${formatFalError(error)}`;
    if (isRetryableSeedanceError(error)) {
      console.warn(
        JSON.stringify({
          traceId: context.traceId,
          provider: "fal",
          requestId,
          status: "result_lookup_retryable_failed",
          reason: message,
        }),
      );
      return {
        state: "retryable_failed",
        requestId,
        queueStatus: "RESULT_LOOKUP_FAILED",
        error: message,
      };
    }
    throw new Error(message);
  }
  const latencyMs = latencySince(submittedAt);
  return {
    state: "complete",
    requestId,
    data: await generatedShotFromResult(shot, result, requestId, context, latencyMs),
    latencyMs,
    costUsd: costForShot(shot),
  };
}

async function submitSeedanceRequest(
  endpoint: string,
  input: SeedanceReferenceRequest,
  context: ProviderContext,
  referencePolicy: SeedanceReferencePolicy,
): Promise<SeedanceQueueSubmission> {
  await reserveSeedanceAttempt(endpoint, input, context, referencePolicy);
  const status = await fal.queue.submit(endpoint, {
    input: await materializeFalRefs(input),
    priority: "normal",
    startTimeout: 180,
  });
  console.log(
    JSON.stringify({
      traceId: context.traceId,
      provider: "fal",
      requestId: status.request_id,
      status: status.status,
    }),
  );
  return {
    requestId: status.request_id,
    endpoint,
    queueStatus: status.status,
    referencePolicy,
  };
}

async function subscribeToSeedance(
  endpoint: string,
  input: SeedanceReferenceRequest,
  context: ProviderContext,
) {
  await reserveSeedanceAttempt(endpoint, input, context, "subscribe");
  return fal.subscribe(endpoint, {
    input: await materializeFalRefs(input),
    logs: true,
    onEnqueue: (requestId) => {
      console.log(JSON.stringify({ traceId: context.traceId, provider: "fal", requestId }));
    },
    onQueueUpdate: (update) => {
      console.log(
        JSON.stringify({
          traceId: context.traceId,
          provider: "fal",
          requestId: update.request_id,
          status: update.status,
          logs: "logs" in update ? update.logs?.map((log) => log.message).slice(-3) : undefined,
        }),
      );
    },
  });
}

function configureFal() {
  fal.config({ credentials: requireEnv("FAL_KEY") });
}

export function endpointForShot(shot: Pick<Shot, "seedanceTier" | "seedanceMode">) {
  const configured = shot.seedanceTier === "fast" ? getSeedanceFastEndpoint() : getSeedanceStandardEndpoint();
  return configured.replace(/(?:reference|image|text)-to-video$/, shot.seedanceMode ?? "reference-to-video");
}

function durationSecondsForShot(shot: Shot) {
  return providerDurationSecondsForShot(shot);
}

export function providerDurationSecondsForShot(shot: Shot) {
  return Math.min(15, Math.max(4, Math.ceil((shot.endMs - shot.startMs) / 1000)));
}

function costForShot(shot: Shot) {
  const rate = seedanceRateForShot(shot);
  return Number((durationSecondsForShot(shot) * rate).toFixed(2));
}

async function generatedShotFromResult(
  shot: Shot,
  result: { data: unknown },
  requestId: string,
  context: ProviderContext,
  latencyMs: number,
) {
  const videoUrl = (result.data as { video?: { url?: string } }).video?.url;
  if (!videoUrl) {
    throw new Error("Seedance did not return a video URL");
  }
  const blob = await copyRemoteFileToBlob({
    url: videoUrl,
    pathname: context.outputPathPrefix
      ? `${context.outputPathPrefix}/video.mp4`
      : `videos/${context.videoId}/shots/shot-${shot.shotIndex}-${fingerprint(context.idempotencyKey).slice(0, 20)}.mp4`,
    contentType: "video/mp4",
    immutable: true,
  });

  return {
    shotIndex: shot.shotIndex,
    providerRequestId: requestId,
    videoUrl: blob.url,
    sourceVideoUrl: videoUrl,
    requestedDurationSeconds: durationSecondsForShot(shot),
    durationSeconds: durationSecondsForShot(shot),
    seed: shot.seed,
    costUsd: costForShot(shot),
    latencyMs,
    attempts: 1,
    provenance: generatedShotProvenance(shot),
  };
}

function latencySince(value: string) {
  const started = new Date(value).getTime();
  return Number.isFinite(started) ? Math.max(0, Date.now() - started) : 0;
}

function sanitizeSeedancePrompt(prompt: string) {
  return prompt
    .replace(/\blip[- ]?sync(?:ing)?\b/gi, "rhythm-led visual performance")
    .replace(/\bsinging into (?:the )?camera\b/gi, "moving with the soundtrack in a cinematic frame")
    .replace(/\bmouth close[- ]?ups?\b/gi, "expressive detail inserts")
    .replace(/\bfalling in love in high school\b/gi, "a nostalgic first-love story at a retro campus dance with adult performers")
    .replace(/\bhigh school\b/gi, "retro campus dance set")
    .replace(/\bteenagers?\b/gi, "young adult performers")
    .replace(/\bteens?\b/gi, "young adult performers")
    .replace(/\bminors?\b/gi, "adult performers")
    .replace(/\bunderage\b/gi, "adult");
}

export function formatFalError(error: unknown) {
  if (!(error instanceof Error)) return "Seedance request failed.";
  const details = falErrorDetails(error);
  return details ? `${error.message}: ${details}` : error.message;
}

function isReferenceImageRejection(error: unknown) {
  if (!(error instanceof Error)) return false;
  return /image_urls|reference|likeness|private information/i.test(formatFalError(error));
}

// Network/socket error codes (Node sets these as `error.code`, often on the `cause` of a
// `fetch failed`) that indicate a transient connectivity blip worth retrying.
const RETRYABLE_NETWORK_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ECONNABORTED",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

// Transient signals matched against an error's OWN message (and its cause chain). Crucially
// NOT matched against formatFalError's flattened text, which folds in echoed response bodies
// and field errors — a permanent 4xx whose body echoes user input containing "timeout" must
// not be retried as if it were transient.
const RETRYABLE_MESSAGE =
  /\b(?:status 5\d\d|50[0234]|429|internal server error|temporar|timeout|timed out|rate limit|fetch failed|network error|socket hang up|ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|getaddrinfo)\b/i;

function numericStatus(value: unknown): number | undefined {
  const status = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(status) ? status : undefined;
}

// Classify retryability from STRUCTURED error fields (HTTP status, network error code) plus the
// error's own message, walking the cause chain. This intentionally avoids formatFalError's
// flattened display string so echoed response bodies can't trigger a retry of a permanent failure.
export function isRetryableSeedanceError(error: unknown): boolean {
  if (isLikenessPolicyRejection(error)) return false;
  for (let current: unknown = error, depth = 0; current instanceof Error && depth < 8; depth++) {
    const candidate = current as Error & {
      status?: unknown;
      statusCode?: unknown;
      code?: unknown;
      response?: { status?: unknown };
      cause?: unknown;
    };
    const status =
      numericStatus(candidate.status) ??
      numericStatus(candidate.statusCode) ??
      numericStatus(candidate.response?.status);
    if (status === 429 || (status !== undefined && status >= 500 && status <= 599)) return true;
    if (typeof candidate.code === "string" && RETRYABLE_NETWORK_CODES.has(candidate.code.toUpperCase())) {
      return true;
    }
    if (RETRYABLE_MESSAGE.test(candidate.message)) return true;
    current = candidate.cause;
  }
  return false;
}

export function isLikenessPolicyRejection(error: unknown) {
  if (!(error instanceof Error)) return false;
  const candidate = error as Error & { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
  const status = numericStatus(candidate.status) ?? numericStatus(candidate.statusCode) ?? numericStatus(candidate.response?.status);
  if (status !== undefined && ![400, 403, 422].includes(status)) return false;
  return /likeness|face[- ]?swap|biometric|identity policy|private information|real[- ]?person|personality rights/i.test(formatFalError(error));
}

function assertAuthorizedLikenessRouting(shot: Shot) {
  if (shot.seededCharacter && !isLikenessVideoEnabled()) {
    throw new Error(
      "Consented likeness video generation is currently paused. The performer reference was retained and no substitute identity was generated.",
    );
  }
}

function authorizedLikenessPolicyError(error: unknown) {
  const detail = formatFalError(error);
  return new Error(
    `The video provider declined this authorized-likeness request. The face reference was retained and Cocoa did not generate a conceptual or substitute performer. Provider detail: ${detail}`,
  );
}

function generatedShotProvenance(shot: Shot) {
  return {
    origin: "generated" as const,
    permittedUse: shot.seededCharacter
      ? "Generated from a user-provided reference with recorded affirmative consent."
      : "Generated for use in this Cocoa production.",
    acquiredAt: new Date().toISOString(),
    transformations: shot.seededCharacter
      ? ["consented likeness reference retained during video generation"]
      : ["text/reference-to-video generation"],
    c2paValidated: false,
  };
}

function isTerminalFalQueueFailure(status: QueueStatus["status"]) {
  return /fail|error|cancel/i.test(String(status));
}

function stabilityRetryReferences(shot: Shot) {
  if (shot.referenceImages.length <= 2) return shot.referenceImages;
  return shot.referenceImages.slice(0, 2);
}

function falErrorDetails(error: Error) {
  const candidate = error as Error & {
    status?: number;
    statusCode?: number;
    code?: string;
    requestId?: string;
    request_id?: string;
    body?: { detail?: unknown; message?: unknown; error?: unknown };
    data?: { detail?: unknown; message?: unknown; error?: unknown };
    response?: {
      status?: number;
      statusText?: string;
      data?: unknown;
      body?: unknown;
    };
    cause?: unknown;
    fieldErrors?: Array<{ loc?: Array<string | number>; msg?: string; type?: string }>;
  };
  const parts: string[] = [];
  if (candidate.status ?? candidate.statusCode) parts.push(`status ${candidate.status ?? candidate.statusCode}`);
  if (candidate.code) parts.push(`code ${candidate.code}`);
  if (candidate.requestId ?? candidate.request_id) parts.push(`request ${candidate.requestId ?? candidate.request_id}`);
  if (candidate.fieldErrors?.length) {
    parts.push(
      candidate.fieldErrors
        .map((fieldError) => {
          const field = fieldError.loc?.join(".") ?? "input";
          return `${field}: ${fieldError.msg ?? fieldError.type ?? "invalid"}`;
        })
        .join("; "),
    );
  } else if (candidate.body?.detail) {
    parts.push(formatUnknownDetail(candidate.body.detail));
  } else if (candidate.body?.message || candidate.body?.error) {
    parts.push(formatUnknownDetail(candidate.body.message ?? candidate.body.error));
  }
  if (candidate.data?.detail) {
    parts.push(formatUnknownDetail(candidate.data.detail));
  } else if (candidate.data?.message || candidate.data?.error) {
    parts.push(formatUnknownDetail(candidate.data.message ?? candidate.data.error));
  }
  if (candidate.response?.status) {
    parts.push(`response ${candidate.response.status}${candidate.response.statusText ? ` ${candidate.response.statusText}` : ""}`);
  }
  if (candidate.response?.data) parts.push(formatUnknownDetail(candidate.response.data));
  if (candidate.response?.body) parts.push(formatUnknownDetail(candidate.response.body));
  const ownDetails = serializableErrorProperties(candidate);
  if (ownDetails) parts.push(ownDetails);
  if (candidate.cause instanceof Error) {
    const causeDetails = falErrorDetails(candidate.cause);
    parts.push(causeDetails ? `cause ${candidate.cause.message}: ${causeDetails}` : `cause ${candidate.cause.message}`);
  } else if (candidate.cause) {
    parts.push(`cause ${formatUnknownDetail(candidate.cause)}`);
  }
  return unique(parts.filter(Boolean)).join(" | ");
}

function formatUnknownDetail(value: unknown) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, redactSensitiveValue);
  } catch {
    return String(value);
  }
}

function serializableErrorProperties(value: object) {
  const omitted = new Set([
    "stack",
    "message",
    "name",
    "status",
    "statusCode",
    "code",
    "requestId",
    "request_id",
    "body",
    "data",
    "response",
    "cause",
    "fieldErrors",
  ]);
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([key, nested]) =>
      !omitted.has(key) &&
      typeof nested !== "function" &&
      typeof nested !== "undefined",
  );
  if (entries.length === 0) return "";
  return formatUnknownDetail(Object.fromEntries(entries));
}

function redactSensitiveValue(key: string, value: unknown) {
  if (/authorization|api[-_]?key|token|secret|password|credential/i.test(key)) {
    return "[redacted]";
  }
  if (typeof value === "string" && value.length > 800) {
    return `${value.slice(0, 800)}...`;
  }
  return value;
}

function unique(values: string[]) {
  return Array.from(new Set(values));
}

async function reserveSeedanceAttempt(endpoint: string, input: SeedanceReferenceRequest, context: ProviderContext, policy: string) {
  const duration = input.duration === "auto" ? 15 : Number(input.duration);
  const rate = input.resolution === "1080p" ? 0.682 : endpoint.includes("fast") ? 0.2419 : 0.3034;
  // fal bills input video duration too. Reserve the maximum accepted total reference length.
  const billableSeconds = input.video_urls?.length ? (duration + 15 * input.video_urls.length) * 0.6 : duration;
  await reserveProviderAttempt({ scope: `fal:${endpoint}`, videoId: context.videoId,
    key: `${context.idempotencyKey}:${context.outputAttempt ?? 1}:${policy}:${fingerprint(input)}`,
    costCents: Math.ceil(billableSeconds * rate * 100 * 1.08) });
}
