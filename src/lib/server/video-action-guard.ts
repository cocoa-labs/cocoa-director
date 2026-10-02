import { cents, estimateInitialCost, estimateShotPlanCost } from "@/lib/cost";
import type { PhaseNumber, Shot, VideoCreateRequest, VideoJob } from "@/lib/schemas";
import { seedanceRateForShot } from "@/lib/provider-pricing";
import type { UserContext } from "@/lib/server/auth";
import {
  assertProviderSpendAllowed,
  recordProviderSubmitted,
  type SpendGuardError,
} from "@/lib/server/spend-guard";

type VideoActionInput = {
  action: string;
  estimatedCostCents: number;
  idempotencyKey?: string;
  job?: VideoJob;
  metadata?: Record<string, unknown>;
  recordSubmitted?: boolean;
  user: UserContext;
};

export async function assertVideoActionAllowed(input: VideoActionInput) {
  return assertProviderSpendAllowed({
    user: input.user,
    projectId: input.job?.projectId,
    videoJobId: input.job?.id,
    provider: "pipeline",
    model: input.action,
    estimatedCostCents: input.estimatedCostCents,
    idempotencyKey: input.idempotencyKey,
    metadata: { ...input.metadata, action: input.action },
    recordSubmitted: input.recordSubmitted,
    source: "video_action_guard",
  });
}

export async function recordVideoActionSubmitted(input: VideoActionInput) {
  return recordProviderSubmitted({
    user: input.user,
    projectId: input.job?.projectId,
    videoJobId: input.job?.id,
    provider: "pipeline",
    model: input.action,
    estimatedCostCents: input.estimatedCostCents,
    idempotencyKey: input.idempotencyKey,
    metadata: { ...input.metadata, action: input.action },
    source: "video_action_guard",
  });
}

export function estimateCreateVideoCents(request: VideoCreateRequest) {
  return cents(estimateInitialCost(request).totalUsd);
}

export function estimateAdvanceCents(job: VideoJob) {
  return Math.max(0, job.estimatedCostCents - job.actualCostCents);
}

export function estimateRegeneratePhaseCents(job: VideoJob, phase: PhaseNumber) {
  if (phase === 3) return cents(0.5);
  if (phase === 5) return cents(0.8);
  if (phase === 7 && job.shotPlan) return cents(estimateShotPlanCost(job.shotPlan, job.aspectRatio));
  if (phase === 9) return cents(0.5);
  return cents(0.05);
}

export function estimateShotRegenerateCents(shot: Shot, aspectRatio: VideoJob["aspectRatio"]) {
  const durationSeconds = (shot.endMs - shot.startMs) / 1000;
  const aspectMultiplier = aspectRatio === "9:16" ? 1 : 1.08;
  const rate = seedanceRateForShot(shot);
  return cents(Number((durationSeconds * rate * aspectMultiplier).toFixed(2)));
}

export function spendGuardResponse(error: SpendGuardError) {
  return Response.json({ error: error.message, ...error.details }, { status: error.status });
}
