import { withJobContext } from "@/lib/server/provider-execution";
import { cents } from "@/lib/cost";
import { appendDirectiveText, directiveTextBlock, markDirectivesApplied, providerControlsFor } from "@/lib/editor";
import { applyShotProviderControls } from "@/lib/provider-capabilities";
import type { AnchorAsset, PhaseNumber, Shot, VideoJob } from "@/lib/schemas";
import { getOpenAiImageModel, getSeedanceFastEndpoint, getSeedanceStandardEndpoint, isLikenessLiveValidated } from "@/lib/server/config";
import { getStore } from "@/lib/server/store";
import { createIdempotencyKey, nowIso } from "@/lib/trace";
import { getProviders } from "@/providers";
import { pollSeedanceShot, submitSeedanceShot } from "@/providers/seedance";
import { ANCHOR_ROLE_ATTEMPT, anchorSeedFor, getAnchorRoles, promptFor, seededFromFor } from "@/workflow/phases/anchorAssets";
import { auditAnchorAsset } from "@/workflow/phases/anchorAudit";
import { buildPromptTrace } from "@/workflow/promptTrace";

export type SeedanceShotSubmissionState =
  | { state: "complete"; shotIndex: number }
  | { state: "queued"; shotIndex: number; requestId: string; submittedAt: string };

export type SeedanceShotPollState =
  | { state: "pending"; shotIndex: number; requestId: string; queueStatus: string }
  | { state: "retryable_failed"; shotIndex: number; requestId: string; error: string }
  | { state: "complete"; shotIndex: number };

export async function runVideoPhaseStep(videoId: string, phaseNumber: PhaseNumber) {
  "use step";
  return withJobContext(videoId, async () => {
  const { runPhase } = await import("@/workflow");
  return runPhase(videoId, phaseNumber);

  });
}

export async function regenerateVideoPhaseStep(videoId: string, phaseNumber: PhaseNumber) {
  "use step";
  return withJobContext(videoId, async () => {
  const { regeneratePhase } = await import("@/workflow");
  return regeneratePhase(videoId, phaseNumber);

  });
}

export async function prepareAnchorAssetsPhaseStep(videoId: string, resetDownstream: boolean) {
  "use step";
  return withJobContext(videoId, async () => {
  const store = getStore();
  const job = await requireStepJob(videoId);
  if (!job.creativeBrief) throw new Error("Creative brief is required.");
  assertWithinBudget(job);

  const patch: Parameters<ReturnType<typeof getStore>["updateJob"]>[1] = {
    status: "running",
    currentPhase: 5,
    error: undefined,
  };

  if (resetDownstream) {
    Object.assign(patch, {
      anchorAssets: [],
      shotPlan: undefined,
      generatedShots: [],
      renderManifest: undefined,
      finalVideoUrl: undefined,
      thumbnailUrl: undefined,
    });
    await resetDownstreamPhaseStates(videoId);
  }

  await store.updateJob(videoId, patch);
  await store.updatePhase(videoId, 5, {
    state: "running",
    startedAt: nowIso(),
    completedAt: undefined,
    artifactUrl: undefined,
    error: undefined,
  });
  return getAnchorRoles(job.creativeBrief, job.seeds);

  });
}

export async function generateAnchorAssetStep(videoId: string, role: AnchorAsset["role"]) {
  "use step";
  return withJobContext(videoId, async () => {
  const store = getStore();
  const started = Date.now();
  const job = await requireStepJob(videoId);
  if (!job.creativeBrief) throw new Error("Creative brief is required.");
  assertWithinBudget(job);

  const existing = job.anchorAssets.find((asset) => asset.role === role);
  if (existing) return existing;

  const phaseStartedAt = job.phases.find((phase) => phase.phaseNumber === 5)?.startedAt ?? job.updatedAt;
  const idempotencyKey = createIdempotencyKey({
    videoId,
    phase: 5,
    attempt: ANCHOR_ROLE_ATTEMPT[role],
    nonce: phaseStartedAt,
  });

  try {
    const editDirections = directiveTextBlock(job, { scope: "anchors", phase: 5, targetId: role });
    const providerControls = providerControlsFor(job, { scope: "anchors", phase: 5, targetId: role })?.anchors;
    const seed = anchorSeedFor(role, job.seeds);
    const result = await getProviders().images.generateAnchorAsset(
      role,
      promptFor(role, job.creativeBrief, job.musicPlan, editDirections, seed?.intent),
      {
        videoId,
        traceId: job.traceId,
        phaseNumber: 5,
        idempotencyKey,
      },
      providerControls,
      seed?.references,
    );

    await store.addProviderCall({
      videoJobId: job.id,
      phaseNumber: 5,
      provider: "openai",
      model: getOpenAiImageModel(),
      requestId: result.requestId,
      idempotencyKey,
      latencyMs: result.latencyMs,
      costCents: cents(result.costUsd),
      status: "success",
    });

    const audit = await auditAnchorAsset(job.creativeBrief, result.data);
    if (audit.providerRequestId) {
      await store.addProviderCall({
        videoJobId: job.id,
        phaseNumber: 5,
        provider: "openai",
        model: process.env.OPENAI_VISION_AUDIT_MODEL ?? "vision-audit",
        requestId: audit.providerRequestId,
        idempotencyKey: createIdempotencyKey({ videoId, phase: 5, nonce: audit.providerRequestId }),
        latencyMs: 0,
        costCents: cents(0.01),
        status: "success",
      });
    }
    const auditedAsset = { ...result.data, audit, ...(seed ? { seededFrom: seededFromFor(seed) } : {}) };
    const updated = await store.mutateJob(videoId, (latest) => withPromptTrace(latest, {
      status: "running", currentPhase: 5,
      anchorAssets: orderAnchorAssets([...latest.anchorAssets.filter((asset) => asset.role !== role), auditedAsset]),
      error: undefined,
    }));
    const anchorAssets = updated.anchorAssets;
    await store.updatePhase(videoId, 5, {
      state: "running",
      artifactUrl: anchorAssets[0]?.url,
      error: undefined,
    });
    return auditedAsset;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Anchor image generation failed.";
    await store.addProviderCall({
      videoJobId: job.id,
      phaseNumber: 5,
      provider: "openai",
      model: getOpenAiImageModel(),
      requestId: `openai-${role}-failed`,
      idempotencyKey: createIdempotencyKey({
        videoId,
        phase: 5,
        attempt: ANCHOR_ROLE_ATTEMPT[role] + 100,
        nonce: phaseStartedAt,
      }),
      latencyMs: Date.now() - started,
      costCents: 0,
      status: "failed",
      error: message,
    });
    await store.updatePhase(videoId, 5, { state: "failed", error: message });
    await store.updateJob(videoId, { status: "failed", error: message });
    throw error;
  }

  });
}

export async function completeAnchorAssetsPhaseStep(videoId: string) {
  "use step";
  return withJobContext(videoId, async () => {
  const store = getStore();
  const job = await requireStepJob(videoId);
  if (job.anchorAssets.length === 0) {
    throw new Error("Anchor assets did not produce any images.");
  }

  await store.updatePhase(videoId, 5, {
    state: "awaiting_user",
    completedAt: nowIso(),
    artifactUrl: job.anchorAssets[0]?.url,
    error: undefined,
  });
  return store.updateJob(videoId, withPromptTrace(job, {
    status: "awaiting_user",
    currentPhase: 5,
    editDirectives: markDirectivesApplied(job, { scope: "anchors", phase: 5 }),
    error: undefined,
  }));

  });
}

export async function prepareShotGenerationPhaseStep(videoId: string, resetDownstream: boolean) {
  "use step";
  return withJobContext(videoId, async () => {
  const store = getStore();
  const job = await requireStepJob(videoId);
  if (!job.creativeBrief || !job.shotPlan) throw new Error("Brief and shot plan are required.");
  assertWithinBudget(job);

  const patch: Parameters<ReturnType<typeof getStore>["updateJob"]>[1] = {
    status: "running",
    currentPhase: 7,
    error: undefined,
  };

  if (resetDownstream) {
    Object.assign(patch, {
      generatedShots: [],
      renderManifest: undefined,
      finalVideoUrl: undefined,
      thumbnailUrl: undefined,
    });
    await resetPhaseStates(videoId, [8, 9]);
  }

  await store.updateJob(videoId, patch);
  await store.updatePhase(videoId, 7, {
    state: "running",
    startedAt: nowIso(),
    completedAt: undefined,
    artifactUrl: undefined,
    error: undefined,
  });
  return job.shotPlan.shots;

  });
}

export async function generateSeedanceShotStep(videoId: string, shotIndex: number) {
  "use step";
  return withJobContext(videoId, async () => {
  const store = getStore();
  const started = Date.now();
  const job = await requireStepJob(videoId);
  if (!job.creativeBrief || !job.shotPlan) throw new Error("Brief and shot plan are required.");
  assertWithinBudget(job);

  const existing = job.generatedShots.find((shot) => shot.shotIndex === shotIndex);
  if (existing) return existing;

  const shot = job.shotPlan.shots.find((candidate) => candidate.shotIndex === shotIndex);
  if (!shot) throw new Error(`Shot not found: ${shotIndex}`);

  const phaseStartedAt = job.phases.find((phase) => phase.phaseNumber === 7)?.startedAt ?? job.updatedAt;
  const idempotencyKey = createIdempotencyKey({
    videoId,
    phase: 7,
    shotIndex,
    nonce: phaseStartedAt,
  });

  try {
    const editDirections = directiveTextBlock(job, { scope: "shots", phase: 7, targetId: String(shotIndex) });
    const providerControls = providerControlsFor(job, { scope: "shots", phase: 7, targetId: String(shotIndex) })?.shots;
    const directedShot = applyShotProviderControls(
      { ...shot, prompt: appendDirectiveText(shot.prompt, editDirections) },
      providerControls,
    );
    await store.mutateJob(videoId, (latest) => ({ shotPlan: patchShotPlan(latest, directedShot) }));
    const result = await getProviders().video.generateShot(directedShot, job.creativeBrief, {
      videoId,
      traceId: job.traceId,
      phaseNumber: 7,
      idempotencyKey,
    }, providerControls);

    await store.addProviderCall({
      videoJobId: job.id,
      phaseNumber: 7,
      provider: "fal",
      model: seedanceEndpointFor(shot),
      requestId: result.requestId,
      idempotencyKey,
      latencyMs: result.latencyMs,
      costCents: cents(result.costUsd),
      status: "success",
      metadata: likenessProviderMetadata(job, directedShot, result.data.referencePolicy),
    });

    const updated = await store.mutateJob(videoId, (latest) => ({
      status: "running", currentPhase: 7,
      generatedShots: [...latest.generatedShots.filter((generated) => generated.shotIndex !== shotIndex), result.data]
        .sort((left, right) => left.shotIndex - right.shotIndex),
      error: undefined,
    }));
    const generatedShots = updated.generatedShots;
    await store.updatePhase(videoId, 7, {
      state: "running",
      artifactUrl: generatedShots[0]?.videoUrl,
      error: undefined,
    });
    return result.data;
  } catch (error) {
    const message = seedanceFailureMessage("generation failed", shotIndex, error);
    await store.addProviderCall({
      videoJobId: job.id,
      phaseNumber: 7,
      provider: "fal",
      model: seedanceEndpointFor(shot),
      requestId: `fal-shot-${shotIndex}-failed`,
      idempotencyKey: createIdempotencyKey({
        videoId,
        phase: 7,
        shotIndex,
        attempt: 100,
        nonce: phaseStartedAt,
      }),
      latencyMs: Date.now() - started,
      costCents: 0,
      status: "failed",
      error: message,
      metadata: likenessProviderMetadata(job, shot),
    });
    await store.updatePhase(videoId, 7, { state: "failed", error: message });
    await store.updateJob(videoId, { status: "failed", error: message });
    throw error;
  }

  });
}

export async function submitSeedanceShotStep(
  videoId: string,
  shotIndex: number,
): Promise<SeedanceShotSubmissionState> {
  "use step";
  return withJobContext(videoId, async () => {
  const store = getStore();
  const started = Date.now();
  const job = await requireStepJob(videoId);
  if (!job.creativeBrief || !job.shotPlan) throw new Error("Brief and shot plan are required.");
  assertWithinBudget(job);

  const existing = job.generatedShots.find((shot) => shot.shotIndex === shotIndex);
  if (existing) return { state: "complete", shotIndex };

  const shot = job.shotPlan.shots.find((candidate) => candidate.shotIndex === shotIndex);
  if (!shot) throw new Error(`Shot not found: ${shotIndex}`);

  const phaseStartedAt = phaseNonce(job, 7);
  const submitKey = shotProviderKey(videoId, shotIndex, "submit", phaseStartedAt);
  const submitted = job.providerCalls.find((call) => call.idempotencyKey === submitKey);
  if (submitted && submitted.status !== "failed") {
    return {
      state: "queued",
      shotIndex,
      requestId: submitted.requestId,
      submittedAt: submitted.createdAt,
    };
  }

  try {
    const editDirections = directiveTextBlock(job, { scope: "shots", phase: 7, targetId: String(shotIndex) });
    const providerControls = providerControlsFor(job, { scope: "shots", phase: 7, targetId: String(shotIndex) })?.shots;
    const directedShot = applyShotProviderControls(
      { ...shot, prompt: appendDirectiveText(shot.prompt, editDirections) },
      providerControls,
    );
    await store.mutateJob(videoId, (latest) => ({ shotPlan: patchShotPlan(latest, directedShot) }));
    const result = await submitSeedanceShot(directedShot, job.creativeBrief, {
      videoId,
      traceId: job.traceId,
      phaseNumber: 7,
      idempotencyKey: submitKey,
    });

    await store.addProviderCall({
      videoJobId: job.id,
      phaseNumber: 7,
      provider: "fal",
      model: result.endpoint,
      requestId: result.requestId,
      idempotencyKey: submitKey,
      latencyMs: Date.now() - started,
      costCents: 0,
      status: "queued",
      metadata: likenessProviderMetadata(job, directedShot, result.referencePolicy),
    });
    await store.updateJob(videoId, { status: "running", currentPhase: 7, error: undefined });
    await store.updatePhase(videoId, 7, { state: "running", error: undefined });

    const latest = await requireStepJob(videoId);
    const call = latest.providerCalls.find((providerCall) => providerCall.idempotencyKey === submitKey);
    return {
      state: "queued",
      shotIndex,
      requestId: result.requestId,
      submittedAt: call?.createdAt ?? nowIso(),
    };
  } catch (error) {
    const message = seedanceFailureMessage("submission failed", shotIndex, error);
    await store.addProviderCall({
      videoJobId: job.id,
      phaseNumber: 7,
      provider: "fal",
      model: seedanceEndpointFor(shot),
      requestId: `fal-shot-${shotIndex}-submit-failed`,
      idempotencyKey: shotProviderKey(videoId, shotIndex, "failed", phaseStartedAt),
      latencyMs: Date.now() - started,
      costCents: 0,
      status: "failed",
      error: message,
      metadata: likenessProviderMetadata(job, shot, "all"),
    });
    await store.updatePhase(videoId, 7, { state: "failed", error: message });
    await store.updateJob(videoId, { status: "failed", error: message });
    throw error;
  }

  });
}

export async function resubmitSeedanceShotStep(
  videoId: string,
  shotIndex: number,
  failedRequestId: string,
  reason: string,
  attempt: number,
): Promise<SeedanceShotSubmissionState> {
  "use step";
  return withJobContext(videoId, async () => {
  const store = getStore();
  const started = Date.now();
  const job = await requireStepJob(videoId);
  if (!job.creativeBrief || !job.shotPlan) throw new Error("Brief and shot plan are required.");
  assertWithinBudget(job);

  const existing = job.generatedShots.find((shot) => shot.shotIndex === shotIndex);
  if (existing) return { state: "complete", shotIndex };

  const shot = job.shotPlan.shots.find((candidate) => candidate.shotIndex === shotIndex);
  if (!shot) throw new Error(`Shot not found: ${shotIndex}`);

  const phaseStartedAt = phaseNonce(job, 7);
  const submitKey = shotProviderKey(videoId, shotIndex, "resubmit", phaseStartedAt, `${failedRequestId}:${attempt}`);
  const submitted = job.providerCalls.find((call) => call.idempotencyKey === submitKey);
  if (submitted && submitted.status !== "failed") {
    return {
      state: "queued",
      shotIndex,
      requestId: submitted.requestId,
      submittedAt: submitted.createdAt,
    };
  }

  try {
    console.warn(
      JSON.stringify({
        traceId: job.traceId,
        provider: "fal",
        shotIndex,
        action: "resubmit_seedance_shot",
        failedRequestId,
        attempt,
        reason,
      }),
    );
    const editDirections = directiveTextBlock(job, { scope: "shots", phase: 7, targetId: String(shotIndex) });
    const providerControls = providerControlsFor(job, { scope: "shots", phase: 7, targetId: String(shotIndex) })?.shots;
    const directedShot = applyShotProviderControls(
      { ...shot, prompt: appendDirectiveText(shot.prompt, editDirections) },
      providerControls,
    );
    await store.mutateJob(videoId, (latest) => ({ shotPlan: patchShotPlan(latest, directedShot) }));
    const result = await submitSeedanceShot(directedShot, job.creativeBrief, {
      videoId,
      traceId: job.traceId,
      phaseNumber: 7,
      idempotencyKey: submitKey,
    }, {
      referenceImages: shot.referenceImages.length > 2 ? shot.referenceImages.slice(0, 2) : shot.referenceImages,
      referencePolicy: "stability-retry",
    });

    await store.addProviderCall({
      videoJobId: job.id,
      phaseNumber: 7,
      provider: "fal",
      model: result.endpoint,
      requestId: result.requestId,
      idempotencyKey: submitKey,
      latencyMs: Date.now() - started,
      costCents: 0,
      status: "queued",
      metadata: likenessProviderMetadata(job, directedShot, result.referencePolicy),
    });
    await store.updateJob(videoId, { status: "running", currentPhase: 7, error: undefined });
    await store.updatePhase(videoId, 7, { state: "running", error: undefined });

    const latest = await requireStepJob(videoId);
    const call = latest.providerCalls.find((providerCall) => providerCall.idempotencyKey === submitKey);
    return {
      state: "queued",
      shotIndex,
      requestId: result.requestId,
      submittedAt: call?.createdAt ?? nowIso(),
    };
  } catch (error) {
    const message = seedanceFailureMessage("resubmission failed", shotIndex, error, failedRequestId);
    await store.addProviderCall({
      videoJobId: job.id,
      phaseNumber: 7,
      provider: "fal",
      model: seedanceEndpointFor(shot),
      requestId: `fal-shot-${shotIndex}-resubmit-failed`,
      idempotencyKey: shotProviderKey(videoId, shotIndex, "failed", phaseStartedAt, `${failedRequestId}:${attempt}`),
      latencyMs: Date.now() - started,
      costCents: 0,
      status: "failed",
      error: message,
      metadata: likenessProviderMetadata(job, shot, "stability-retry"),
    });
    await failShotGenerationPhaseStep(videoId, message);
    throw error;
  }

  });
}

export async function pollSeedanceShotStep(
  videoId: string,
  shotIndex: number,
  requestId: string,
  submittedAt: string,
): Promise<SeedanceShotPollState> {
  "use step";
  return withJobContext(videoId, async () => {
  const store = getStore();
  const started = Date.now();
  const job = await requireStepJob(videoId);
  if (!job.creativeBrief || !job.shotPlan) throw new Error("Brief and shot plan are required.");

  const existing = job.generatedShots.find((shot) => shot.shotIndex === shotIndex);
  if (existing) return { state: "complete", shotIndex };

  const shot = job.shotPlan.shots.find((candidate) => candidate.shotIndex === shotIndex);
  if (!shot) throw new Error(`Shot not found: ${shotIndex}`);

  const phaseStartedAt = phaseNonce(job, 7);
  try {
    const result = await pollSeedanceShot(shot, requestId, submittedAt, {
      videoId,
      traceId: job.traceId,
      phaseNumber: 7,
      idempotencyKey: shotProviderKey(videoId, shotIndex, "poll", phaseStartedAt),
    });

    await store.updateJob(videoId, { status: "running", currentPhase: 7, error: undefined });
    await store.updatePhase(videoId, 7, { state: "running", error: undefined });

    if (result.state === "retryable_failed") {
      await store.addProviderCall({
        videoJobId: job.id,
        phaseNumber: 7,
        provider: "fal",
        model: seedanceEndpointFor(shot),
        requestId,
        idempotencyKey: shotProviderKey(videoId, shotIndex, "result-failed", phaseStartedAt, requestId),
        latencyMs: Date.now() - started,
        costCents: 0,
        status: "failed",
        error: seedanceFailureMessage("result lookup needs a replacement", shotIndex, new Error(result.error), requestId),
      });
      return {
        state: "retryable_failed",
        shotIndex,
        requestId,
        error: result.error,
      };
    }

    if (result.state !== "complete") {
      if (result.state === "running") {
        await store.addProviderCall({
          videoJobId: job.id,
          phaseNumber: 7,
          provider: "fal",
          model: seedanceEndpointFor(shot),
          requestId,
          idempotencyKey: shotProviderKey(videoId, shotIndex, "running", phaseStartedAt),
          latencyMs: Date.now() - started,
          costCents: 0,
          status: "running",
        });
      }
      return { state: "pending", shotIndex, requestId, queueStatus: result.queueStatus };
    }

    await store.addProviderCall({
      videoJobId: job.id,
      phaseNumber: 7,
      provider: "fal",
      model: seedanceEndpointFor(shot),
      requestId: result.requestId,
      idempotencyKey: shotProviderKey(videoId, shotIndex, "success", phaseStartedAt),
      latencyMs: result.latencyMs,
      costCents: cents(result.costUsd),
      status: "success",
      metadata: likenessProviderMetadata(job, shot),
    });

    const updated = await store.mutateJob(videoId, (latest) => ({
      status: "running", currentPhase: 7,
      generatedShots: [...latest.generatedShots.filter((generated) => generated.shotIndex !== shotIndex), result.data]
        .sort((left, right) => left.shotIndex - right.shotIndex),
      error: undefined,
    }));
    const generatedShots = updated.generatedShots;
    await store.updatePhase(videoId, 7, {
      state: "running",
      artifactUrl: generatedShots[0]?.videoUrl,
      error: undefined,
    });
    return { state: "complete", shotIndex };
  } catch (error) {
    const message = seedanceFailureMessage("polling failed", shotIndex, error, requestId);
    await store.addProviderCall({
      videoJobId: job.id,
      phaseNumber: 7,
      provider: "fal",
      model: seedanceEndpointFor(shot),
      requestId,
      idempotencyKey: shotProviderKey(videoId, shotIndex, "failed", phaseStartedAt),
      latencyMs: Date.now() - started,
      costCents: 0,
      status: "failed",
      error: message,
      metadata: likenessProviderMetadata(job, shot),
    });
    await store.updatePhase(videoId, 7, { state: "failed", error: message });
    await store.updateJob(videoId, { status: "failed", error: message });
    throw error;
  }

  });
}

export async function completeShotGenerationPhaseStep(videoId: string) {
  "use step";
  return withJobContext(videoId, async () => {
  const store = getStore();
  const job = await requireStepJob(videoId);
  const expectedShots = job.shotPlan?.shots.length ?? 0;
  if (expectedShots === 0 || job.generatedShots.length < expectedShots) {
    const message = `Shot generation incomplete: ${job.generatedShots.length}/${expectedShots} shots ready.`;
    await failShotGenerationPhaseStep(videoId, message);
    throw new Error(message);
  }

  await store.updatePhase(videoId, 7, {
    state: "awaiting_user",
    completedAt: nowIso(),
    artifactUrl: job.generatedShots[0]?.videoUrl,
    error: undefined,
  });
  return store.updateJob(videoId, {
    status: "awaiting_user",
    currentPhase: 7,
    editDirectives: markDirectivesApplied(job, { scope: "shots", phase: 7 }),
    error: undefined,
  });

  });
}

export async function failShotGenerationPhaseStep(videoId: string, message: string) {
  "use step";
  return withJobContext(videoId, async () => {
  const store = getStore();
  await store.updatePhase(videoId, 7, { state: "failed", error: message });
  return store.updateJob(videoId, { status: "failed", error: message });

  });
}

async function resetDownstreamPhaseStates(videoId: string) {
  await resetPhaseStates(videoId, [6, 7, 8, 9]);
}

async function resetPhaseStates(videoId: string, phases: PhaseNumber[]) {
  const store = getStore();
  for (const phaseNumber of phases) {
    await store.updatePhase(videoId, phaseNumber, {
      state: "pending",
      startedAt: undefined,
      completedAt: undefined,
      artifactUrl: undefined,
      error: undefined,
    });
  }
}

function patchShotPlan(job: VideoJob, shot: Shot) {
  if (!job.shotPlan) return job.shotPlan;
  return {
    ...job.shotPlan,
    shots: job.shotPlan.shots.map((candidate) =>
      candidate.shotIndex === shot.shotIndex ? shot : candidate,
    ),
  };
}

function likenessProviderMetadata(job: VideoJob, shot: Shot, referencePolicy?: string) {
  const consent = shot.seededCharacter ? job.seeds.subjects[0]?.consent : undefined;
  return {
    seededCharacter: shot.seededCharacter === true,
    likenessMode: shot.seededCharacter ? "authorized_reference" : "none",
    referencePolicy: referencePolicy ?? "recorded_at_submission",
    consentVersion: consent?.version,
    consentAffirmedAt: consent?.affirmedAt,
    liveValidationCompleted: isLikenessLiveValidated(),
    routingReason: shot.routingReason,
  };
}

async function requireStepJob(videoId: string) {
  const job = await getStore().getJob(videoId);
  if (!job) {
    throw new Error(`Video job not found: ${videoId}`);
  }
  return job;
}

function assertWithinBudget(job: VideoJob) {
  if (job.actualCostCents > job.estimatedCostCents) {
    throw new Error("Estimated cost cap reached.");
  }
}

function orderAnchorAssets(assets: AnchorAsset[]) {
  return assets.sort((left, right) => ANCHOR_ROLE_ATTEMPT[left.role] - ANCHOR_ROLE_ATTEMPT[right.role]);
}

function withPromptTrace(job: VideoJob, patch: Partial<VideoJob>) {
  const next = { ...job, ...patch };
  return { ...patch, promptTrace: buildPromptTrace(next) };
}

function seedanceEndpointFor(shot: Shot) {
  return shot.seedanceTier === "fast" ? getSeedanceFastEndpoint() : getSeedanceStandardEndpoint();
}

function phaseNonce(job: VideoJob, phaseNumber: PhaseNumber) {
  return job.phases.find((phase) => phase.phaseNumber === phaseNumber)?.startedAt ?? job.updatedAt;
}

function shotProviderKey(
  videoId: string,
  shotIndex: number,
  kind: "submit" | "resubmit" | "poll" | "running" | "success" | "failed" | "result-failed",
  nonce: string,
  detail = "",
) {
  const attemptByKind = {
    submit: 10,
    resubmit: 14,
    poll: 11,
    running: 12,
    success: 13,
    failed: 100,
    "result-failed": 101,
  } satisfies Record<typeof kind, number>;
  return createIdempotencyKey({
    videoId,
    phase: 7,
    shotIndex,
    attempt: attemptByKind[kind],
    nonce: `${kind}:${nonce}:${detail}`,
  });
}

function seedanceFailureMessage(
  action: string,
  shotIndex: number,
  error: unknown,
  requestId?: string,
) {
  const detail = error instanceof Error ? error.message : "Seedance provider call failed.";
  const request = requestId ? ` request ${requestId}` : "";
  return `Seedance shot ${shotIndex + 1} ${action}${request}: ${detail}`;
}
