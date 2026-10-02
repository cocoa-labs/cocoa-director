import { reserveBudget, bindReservation } from "@/lib/server/budget-ledger";
import { ApiRequestError } from "@/lib/server/api-error";
import { cents, estimateMediaGenerationCost } from "@/lib/cost";
import type { MediaGenerationCreateRequest } from "@/lib/schemas";
import type { UserContext } from "@/lib/server/auth";
import {
  getElevenLabsMusicModel,
  getOpenAiImageModel,
  getOpenAiImageQuality,
  getOpenAiImageSize,
  getSeedanceFastEndpoint,
  getSeedanceStandardEndpoint,
} from "@/lib/server/config";
import { getStore } from "@/lib/server/store";

export class SpendGuardError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

type ProviderSpendDecision = {
  actualCostCents?: number;
  estimatedCostCents: number;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
  model: string;
  provider: string;
  projectId?: string;
  recordSubmitted?: boolean;
  source: string;
  user: UserContext;
  videoJobId?: string;
  mediaGenerationId?: string;
  mediaSessionId?: string;
};

export async function assertProviderSpendAllowed(input: ProviderSpendDecision) {
  try {
    const decision = await reserveBudget({ user: input.user, scope: `${input.source}:${input.model}`, key: input.idempotencyKey,
      estimatedCostCents: input.estimatedCostCents, metadata: { ...input.metadata, source: input.source }, videoJobId: input.videoJobId });
    if (!decision.replayed) await getStore().createProviderAuditEvent({
      userId: input.user.id, projectId: input.projectId, videoJobId: input.videoJobId,
      mediaGenerationId: input.mediaGenerationId, mediaSessionId: input.mediaSessionId,
      provider: input.provider, model: input.model, status: "submitted",
      estimatedCostCents: input.estimatedCostCents, actualCostCents: 0, idempotencyKey: input.idempotencyKey,
      metadata: { ...input.metadata, source: input.source, spendCapExempt: input.user.spendCapExempt === true, reservationId: decision.reservation.id },
    });
    return { replayed: decision.replayed, event: { metadata: decision.reservation.metadata } };
  } catch (error) {
    if (error instanceof ApiRequestError) {
      if (error.status === 429 || error.code === "provider_calls_paused") await getStore().createProviderAuditEvent({
        userId: input.user.id, projectId: input.projectId, videoJobId: input.videoJobId, provider: input.provider, model: input.model,
        status: error.status === 429 ? "blocked_cap" : "blocked_paused", estimatedCostCents: input.estimatedCostCents, actualCostCents: 0,
        idempotencyKey: input.idempotencyKey, error: error.message, metadata: { source: input.source, code: error.code },
      });
      throw new SpendGuardError(error.message, error.status, { code: error.code });
    }
    throw error;
  }
}

export async function recordProviderSubmitted(input: ProviderSpendDecision) {
  await bindReservation(`${input.source}:${input.model}`, input.idempotencyKey, input.user.id, {
    ...input.metadata, videoJobId: input.videoJobId ?? input.metadata?.videoId,
  });
}

export async function assertMediaGenerationAllowed(
  user: UserContext,
  request: MediaGenerationCreateRequest,
  context: { projectId?: string; mediaSessionId?: string } = {},
) {
  if (!request.execute) return;
  const inputs = context.projectId ? await Promise.all([...new Set(request.inputAssetIds)].map((id) => getStore().getMediaAsset(context.projectId!, id))) : [];
  if (inputs.some((asset) => !asset)) throw new ApiRequestError("An input asset is unavailable in this project.", 404, "input_asset_not_found");
  const controls = {
    ...(request.kind === "image" ? { quality: getOpenAiImageQuality(), size: getOpenAiImageSize() } : {}),
    ...request.controls,
    referenceCount: inputs.filter((asset) => asset?.kind === "image").length,
    referenceVideoUrls: inputs.filter((asset) => asset?.kind === "video").map((asset) => asset!.url),
  };
  const estimatedCostCents = cents(estimateMediaGenerationCost({ ...request, controls }));
  await assertProviderSpendAllowed({
    user,
    projectId: context.projectId,
    mediaSessionId: context.mediaSessionId,
    provider: providerForRequest(request),
    model: modelForRequest(request),
    estimatedCostCents,
    idempotencyKey: request.idempotencyKey,
    metadata: { kind: request.kind },
    source: "media_generation_guard",
  });
}

function providerForRequest(request: MediaGenerationCreateRequest) {
  if (request.provider) return request.provider;
  if (request.kind === "image") return "openai";
  if (request.kind === "video") return "fal";
  if (request.kind === "music") return "elevenlabs";
  return "vercel-render";
}

function modelForRequest(request: MediaGenerationCreateRequest) {
  if (request.kind === "image") return typeof request.controls.model === "string" ? request.controls.model : getOpenAiImageModel();
  if (request.kind === "video") return request.controls.seedanceTier === "fast" ? getSeedanceFastEndpoint() : getSeedanceStandardEndpoint();
  if (request.kind === "music") return getElevenLabsMusicModel();
  return "remotion-render";
}
