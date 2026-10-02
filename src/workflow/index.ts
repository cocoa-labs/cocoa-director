import { withJobContext } from "@/lib/server/provider-execution";
import { cents, dollars } from "@/lib/cost";
import { appendDirectiveText, directiveTextBlock, markDirectivesApplied, providerControlsFor } from "@/lib/editor";
import { applyMusicProviderControls, applyShotProviderControls, routeShotForQuality } from "@/lib/provider-capabilities";
import { styleModel } from "@/lib/model-routing";
import { MUSIC_VIDEO_V1_PHASES, musicVideoAdvanceBatch } from "@/lib/music-workflow-profile";
import type { PhaseNumber, VideoJob } from "@/lib/schemas";
import { getElevenLabsMusicModel, isLikenessLiveValidated } from "@/lib/server/config";
import { promoteFinalRenderToLibrary } from "@/lib/server/library-vault";
import { getStore } from "@/lib/server/store";
import { createIdempotencyKey, nowIso } from "@/lib/trace";
import { getProviders } from "@/providers";
import { ANCHOR_ROLE_ATTEMPT, createAnchorAssets } from "@/workflow/phases/anchorAssets";
import { extractBeatGrid } from "@/workflow/phases/beatExtraction";
import { createCompositionPlan } from "@/workflow/phases/compositionPlan";
import { judgeAndApplyRegenerationBudget } from "@/workflow/phases/qa";
import { createRenderManifest } from "@/workflow/phases/render";
import { createShotPlan } from "@/workflow/phases/shotPlan";
import { createTreatment } from "@/workflow/phases/treatment";
import { auditAnchorAssets } from "@/workflow/phases/anchorAudit";
import { buildPromptTrace } from "@/workflow/promptTrace";

export async function runInitialTreatment(videoId: string) {
  return runPhase(videoId, 1);
}

export async function advanceVideoToNextGate(videoId: string) {
  const store = getStore();
  const job = await requireJob(videoId);

  if (job.cancellationRequested || job.status === "cancelled") {
    return store.updateJob(videoId, { status: "cancelled" });
  }

  let updated = job;
  for (const phase of musicVideoAdvanceBatch(job.currentPhase)) {
    updated = await runPhase(videoId, phase.phaseNumber);
    if (updated.status === "failed" || updated.status === "cancelled") break;
  }
  return updated;
}

export async function runPhase(videoId: string, phaseNumber: PhaseNumber) {
  "use step";
  return withJobContext(videoId, async () => {
  const store = getStore();
  let job = await requireJob(videoId);
  assertWithinBudget(job);
  await store.updateJob(videoId, { status: "running", currentPhase: phaseNumber, error: undefined });
  await store.updatePhase(videoId, phaseNumber, {
    state: "running",
    startedAt: nowIso(),
    completedAt: undefined,
    artifactUrl: undefined,
    error: undefined,
  });

  try {
    switch (phaseNumber) {
      case 1:
        job = await phaseTreatment(videoId);
        break;
      case 2:
        job = await phaseCompositionPlan(videoId);
        break;
      case 3:
        job = await phaseMusicRender(videoId);
        break;
      case 4:
        job = await phaseBeatExtraction(videoId);
        break;
      case 5:
        job = await phaseAnchorAssets(videoId);
        break;
      case 6:
        job = await phaseShotPlan(videoId);
        break;
      case 7:
        job = await phaseShotGeneration(videoId);
        break;
      case 8:
        job = await phaseQa(videoId);
        break;
      case 9:
        job = await phaseRender(videoId);
        break;
    }

    const isComplete = phaseNumber === 9;
    await store.updatePhase(videoId, phaseNumber, {
      state: isComplete ? "complete" : "awaiting_user",
      completedAt: nowIso(),
      artifactUrl: artifactForPhase(job, phaseNumber),
    });
    const updated = await store.updateJob(videoId, { status: isComplete ? "complete" : "awaiting_user", error: undefined });
    if (isComplete) {
      await promoteFinalRenderToLibrary(updated);
    }
    return updated;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown workflow error";
    await store.updatePhase(videoId, phaseNumber, { state: "failed", error: message });
    return store.updateJob(videoId, { status: "failed", error: message });
  }

  });
}

export async function regeneratePhase(videoId: string, phaseNumber: PhaseNumber) {
  await clearDownstream(videoId, phaseNumber);
  return runPhase(videoId, phaseNumber);
}

export async function cancelVideo(videoId: string) {
  const store = getStore();
  return store.updateJob(videoId, {
    status: "cancelled",
    cancellationRequested: true,
  });
}

async function phaseTreatment(videoId: string) {
  const store = getStore();
  const providers = getProviders();
  const job = await requireJob(videoId);
  const editDirections = directiveTextBlock(job, { scope: "treatment", phase: 1 });
  const directedPrompt = appendDirectiveText(job.prompt, editDirections);
  const moderation = await providers.moderation.checkText(directedPrompt, "phase_1_input", {
    videoId,
    traceId: job.traceId,
    phaseNumber: 1,
  });
  if (!moderation.allowed) {
    throw new Error("Prompt failed moderation.");
  }
  const creativeBrief = await createTreatment({ ...job, prompt: directedPrompt });
  if (creativeBrief.styleContract?.source === "llm" && creativeBrief.styleContract.providerRequestId) {
    await logProviderCall(job, 1, "openai", styleModel(), creativeBrief.styleContract.providerRequestId, 0, 0.01);
  }
  const editDirectives = markDirectivesApplied(job, { scope: "treatment", phase: 1 });
  return store.updateJob(videoId, withPromptTrace(job, { editDirectives, creativeBrief }));
}

async function phaseCompositionPlan(videoId: string) {
  const store = getStore();
  const job = await requireJob(videoId);
  if (!job.creativeBrief) throw new Error("Creative brief is required.");
  const editDirections = directiveTextBlock(job, { scope: "music", phase: 2 });
  const musicPlan = await createCompositionPlan(job.creativeBrief, editDirections);
  const lyricText = musicPlan.sections.map((section) => section.lyrics).join("\n");
  const moderation = await getProviders().moderation.checkText(lyricText, "phase_2_lyrics", {
    videoId,
    traceId: job.traceId,
    phaseNumber: 2,
  });
  if (!moderation.allowed) {
    throw new Error("Generated lyrics failed moderation.");
  }
  return store.updateJob(videoId, withPromptTrace(job, {
    editDirectives: markDirectivesApplied(job, { scope: "music", phase: 2 }),
    musicPlan,
  }));
}

async function phaseMusicRender(videoId: string) {
  const store = getStore();
  const job = await requireJob(videoId);
  if (!job.musicPlan) throw new Error("Music plan is required.");
  const providerControls = providerControlsFor(job, { scope: "music", phase: 2 })?.music;
  const directedPlan = applyMusicProviderControls(job.musicPlan, providerControls);
  const result = await getProviders().music.compose(directedPlan, context(job, 3), providerControls);
  await logProviderCall(job, 3, "elevenlabs", getElevenLabsMusicModel(), result.requestId, result.latencyMs, result.costUsd);
  return store.updateJob(videoId, withPromptTrace(job, { musicPlan: directedPlan, musicTrack: result.data }));
}

async function phaseBeatExtraction(videoId: string) {
  const store = getStore();
  const job = await requireJob(videoId);
  if (!job.musicTrack || !job.musicPlan) throw new Error("Music track and plan are required.");
  return store.updateJob(videoId, withPromptTrace(job, {
    beatGrid: await extractBeatGrid(job.musicTrack, job.musicPlan),
  }));
}

async function phaseAnchorAssets(videoId: string) {
  const store = getStore();
  const job = await requireJob(videoId);
  if (!job.creativeBrief) throw new Error("Creative brief is required.");
  const editDirections = directiveTextBlock(job, { scope: "anchors", phase: 5 });
  const providerControls = providerControlsFor(job, { scope: "anchors", phase: 5 })?.anchors;
  const results = await createAnchorAssets(
    job.creativeBrief,
    job.musicPlan,
    { videoId, traceId: job.traceId, phaseNumber: 5 },
    (role) => createIdempotencyKey({ videoId, phase: 5, attempt: ANCHOR_ROLE_ATTEMPT[role] }),
    editDirections,
    providerControls,
    job.seeds,
  );
  for (const result of results) {
    await logProviderCall(job, 5, "openai", "gpt-image-2", result.requestId, result.latencyMs, result.costUsd);
  }
  const anchorAssets = await auditAnchorAssets(job.creativeBrief, results.map((result) => result.data));
  for (const audit of anchorAssets.map((asset) => asset.audit).filter(Boolean)) {
    if (audit?.providerRequestId) {
      await logProviderCall(job, 5, "openai", process.env.OPENAI_VISION_AUDIT_MODEL ?? "vision-audit", audit.providerRequestId, 0, 0.01);
    }
  }
  return store.updateJob(videoId, withPromptTrace(job, {
    editDirectives: markDirectivesApplied(job, { scope: "anchors", phase: 5 }),
    anchorAssets,
  }));
}

async function phaseShotPlan(videoId: string) {
  const store = getStore();
  const job = await requireJob(videoId);
  if (!job.creativeBrief || !job.beatGrid || !job.musicTrack || !job.musicPlan) {
    throw new Error("Creative brief, music plan, beat grid, and music track are required.");
  }
  const editDirections = directiveTextBlock(job, { scope: "shots", phase: 6 });
  const planned = await createShotPlan(job.creativeBrief, job.beatGrid, job.anchorAssets, job.musicPlan, editDirections);
  const shotPlan = {
    ...planned,
    shots: planned.shots.map((shot) => routeShotForQuality(shot, job.qualityTier ?? "standard")),
  };
  return store.updateJob(videoId, withPromptTrace(job, {
    editDirectives: markDirectivesApplied(job, { scope: "shots", phase: 6 }),
    shotPlan,
  }));
}

async function phaseShotGeneration(videoId: string) {
  const store = getStore();
  const job = await requireJob(videoId);
  if (!job.creativeBrief || !job.shotPlan) throw new Error("Brief and shot plan are required.");
  const generated = [];
  const directedShots = [];
  for (const shot of job.shotPlan.shots) {
    assertWithinBudget(await requireJob(videoId));
    const editDirections = directiveTextBlock(job, { scope: "shots", phase: 7, targetId: String(shot.shotIndex) });
    const providerControls = providerControlsFor(job, { scope: "shots", phase: 7, targetId: String(shot.shotIndex) })?.shots;
    const directedShot = applyShotProviderControls(
      { ...shot, prompt: appendDirectiveText(shot.prompt, editDirections) },
      providerControls,
    );
    const result = await getProviders().video.generateShot(directedShot, job.creativeBrief, {
      ...context(job, 7),
      idempotencyKey: createIdempotencyKey({ videoId, phase: 7, shotIndex: shot.shotIndex }),
    }, providerControls);
    await logProviderCall(
      job,
      7,
      "fal",
      "bytedance/seedance-2.0/reference-to-video",
      result.requestId,
      result.latencyMs,
      result.costUsd,
      likenessProviderMetadata(job, directedShot, result.data.referencePolicy),
    );
    directedShots.push(directedShot);
    generated.push(result.data);
  }
  return store.updateJob(videoId, withPromptTrace(job, {
    editDirectives: markDirectivesApplied(job, { scope: "shots", phase: 7 }),
    shotPlan: { ...job.shotPlan, shots: directedShots },
    generatedShots: generated,
  }));
}

async function phaseQa(videoId: string) {
  const store = getStore();
  const job = await requireJob(videoId);
  if (!job.shotPlan || !job.creativeBrief) throw new Error("Shot plan and creative brief are required.");
  return store.updateJob(videoId, withPromptTrace(job, {
    generatedShots: await judgeAndApplyRegenerationBudget(
      job.generatedShots,
      job.shotPlan,
      async (generated, planned) => {
        assertWithinBudget(await requireJob(videoId));
        const attempt = generated.attempts + 1;
        const result = await getProviders().video.generateShot(
          { ...planned, seed: planned.seed + attempt },
          job.creativeBrief!,
          {
            ...context(job, 8),
            idempotencyKey: createIdempotencyKey({
              videoId,
              phase: 8,
              shotIndex: planned.shotIndex,
              attempt,
            }),
          },
        );
        await logProviderCall(
          job,
          8,
          "fal",
          "bytedance/seedance-2.0/reference-to-video",
          result.requestId,
          result.latencyMs,
          result.costUsd,
          likenessProviderMetadata(job, planned, result.data.referencePolicy),
        );
        return result.data;
      },
    ),
  }));
}

async function phaseRender(videoId: string) {
  const store = getStore();
  const job = await requireJob(videoId);
  if (!job.musicTrack || !job.beatGrid) throw new Error("Music track and beat grid are required.");
  const startedAt = Date.now();
  const render = await createRenderManifest({
    videoId,
    musicTrack: job.musicTrack,
    generatedShots: job.generatedShots,
    beatGrid: job.beatGrid,
    aspectRatio: job.aspectRatio,
  });
  await logProviderCall(job, 9, "vercel", "sandbox-ffmpeg", `render-${videoId}`, Date.now() - startedAt, 0.5);
  return store.updateJob(videoId, withPromptTrace(job, {
    renderManifest: render.manifest,
    timelineManifest: render.manifest.timeline,
    qaReport: render.manifest.qaReport,
    finalVideoUrl: render.videoUrl,
    thumbnailUrl: render.thumbnailUrl,
  }));
}

async function logProviderCall(
  job: VideoJob,
  phaseNumber: PhaseNumber,
  provider: string,
  model: string,
  requestId: string,
  latencyMs: number,
  costUsd: number,
  metadata?: Record<string, unknown>,
) {
  const store = getStore();
  await store.addProviderCall({
    videoJobId: job.id,
    phaseNumber,
    provider,
    model,
    requestId,
    idempotencyKey: createIdempotencyKey({ videoId: job.id, phase: phaseNumber, nonce: requestId }),
    latencyMs,
    costCents: cents(costUsd),
    status: "success",
    metadata,
  });
}

function likenessProviderMetadata(
  job: VideoJob,
  shot: { seededCharacter?: boolean; routingReason?: string },
  referencePolicy?: string,
) {
  const consent = shot.seededCharacter ? job.seeds.subjects[0]?.consent : undefined;
  return {
    seededCharacter: shot.seededCharacter === true,
    likenessMode: shot.seededCharacter ? "authorized_reference" : "none",
    referencePolicy: referencePolicy ?? "all",
    consentVersion: consent?.version,
    consentAffirmedAt: consent?.affirmedAt,
    liveValidationCompleted: isLikenessLiveValidated(),
    routingReason: shot.routingReason,
  };
}

function withPromptTrace(job: VideoJob, patch: Partial<VideoJob>) {
  const next = { ...job, ...patch };
  return { ...patch, promptTrace: buildPromptTrace(next) };
}

function context(job: VideoJob, phaseNumber: PhaseNumber) {
  return {
    videoId: job.id,
    traceId: job.traceId,
    phaseNumber,
    idempotencyKey: createIdempotencyKey({ videoId: job.id, phase: phaseNumber }),
  };
}

async function requireJob(videoId: string) {
  const job = await getStore().getJob(videoId);
  if (!job) {
    throw new Error(`Video job not found: ${videoId}`);
  }
  return job;
}

function assertWithinBudget(job: VideoJob) {
  if (dollars(job.actualCostCents) > dollars(job.estimatedCostCents)) {
    throw new Error("Estimated cost cap reached.");
  }
}

function artifactForPhase(job: VideoJob, phaseNumber: PhaseNumber) {
  switch (phaseNumber) {
    case 5:
      return job.anchorAssets[0]?.url;
    case 9:
      return job.finalVideoUrl;
    default:
      return `/api/videos/${job.id}/artifacts/${["", "treatment", "music-plan", "music", "beat-grid", "anchors", "shot-plan", "shots", "manifest"][phaseNumber]}`;
  }
}

async function clearDownstream(videoId: string, phaseNumber: PhaseNumber) {
  const patch: Partial<VideoJob> = {};
  if (phaseNumber <= 1) Object.assign(patch, { creativeBrief: undefined });
  if (phaseNumber <= 2) Object.assign(patch, { musicPlan: undefined });
  if (phaseNumber <= 3) Object.assign(patch, { musicTrack: undefined });
  if (phaseNumber <= 4) Object.assign(patch, { beatGrid: undefined });
  if (phaseNumber <= 5) Object.assign(patch, { anchorAssets: [] });
  if (phaseNumber <= 6) Object.assign(patch, { shotPlan: undefined });
  if (phaseNumber <= 7) Object.assign(patch, { generatedShots: [] });
  if (phaseNumber <= 9) Object.assign(patch, { renderManifest: undefined, finalVideoUrl: undefined, thumbnailUrl: undefined });
  await getStore().updateJob(videoId, patch as Parameters<ReturnType<typeof getStore>["updateJob"]>[1]);
}

/** Mock providers execute locally; compiled workflow entry points must be started with the SDK. */
export async function runMockAutopilot(videoId: string) {
  let job = await requireJob(videoId);
  for (const phase of MUSIC_VIDEO_V1_PHASES) {
    job = await runPhase(videoId, phase.phaseNumber);
    if (job.status === "failed" || job.status === "cancelled") break;
  }
  return job;
}
