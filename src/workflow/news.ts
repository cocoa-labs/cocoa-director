import { withJobContext, withSourceContext } from "@/lib/server/provider-execution";
import { processProductionSource } from "@/lib/server/source-processing";
import type { HybridAssetState } from "@/lib/server/hybrid-assets";
import { createHook, FatalError, RetryableError, sleep } from "workflow";

type NewsWorkflowOptions = {
  recoveryBeatIds?: string[];
  identitySafeRecovery?: boolean;
};

type RecoveryPayload = {
  action: "resume" | "safe_retry" | "retry_failed_beats" | "salvage_visuals" | "rebuild_visuals";
  beatIds: string[];
};

export async function processNewsSourceStep(sourceId: string) {
  "use step";
  return withSourceContext(sourceId, async () => {
  return processProductionSource(sourceId);

  });
}
processNewsSourceStep.maxRetries = 1;

export async function finalizeNewsSourceFailureStep(sourceId: string) {
  "use step";
  return withSourceContext(sourceId, async () => {
  const { getStore } = await import("@/lib/server/store");
  const store = getStore();
  const source = await store.getProductionSource(sourceId);
  if (!source || source.processingState === "ready" || source.processingState === "warning" || source.processingState === "failed") return source;
  return store.updateProductionSource(sourceId, {
    processingState: "failed",
    error: "Source extraction stopped after its retry limit. Retry it, paste the text, use it as a web-research lead, or remove it from this draft.",
  });

  });
}
finalizeNewsSourceFailureStep.maxRetries = 3;

export async function processNewsSourceWorkflow(sourceId: string) {
  "use workflow";
  try {
    return await processNewsSourceStep(sourceId);
  } catch {
    await finalizeNewsSourceFailureStep(sourceId);
    throw new FatalError(`Source processing failed after retries: ${sourceId}`);
  }
}

export async function generateNewsDeliveryStep(videoId: string) {
  "use step";
  return withJobContext(videoId, async () => {
  const { generateNewsDelivery } = await import("@/lib/server/news-delivery");
  return generateNewsDelivery(videoId);

  });
}
generateNewsDeliveryStep.maxRetries = 2;

export async function compileEditorialTimelineStep(videoId: string) {
  "use step";
  return withJobContext(videoId, async () => {
  const { prepareEditorialTimeline } = await import("@/lib/server/news-delivery");
  return prepareEditorialTimeline(videoId);

  });
}
compileEditorialTimelineStep.maxRetries = 2;

export async function getHybridPreparationContextStep(videoId: string) {
  "use step";
  return withJobContext(videoId, async () => {
  const [{ getProviderMode }, { hybridGeneratedBeatIds }, { getStore }] = await Promise.all([
    import("@/lib/server/config"),
    import("@/lib/server/hybrid-assets"),
    import("@/lib/server/store"),
  ]);
  const job = await getStore().getJob(videoId);
  if (!job) throw new Error("Production not found.");
  return { mode: getProviderMode(), beatIds: hybridGeneratedBeatIds(job), sceneIds: job.storyboard?.scenes.map((scene) => scene.id) ?? [] };

  });
}

export async function generateNarrationSceneStep(videoId: string, sceneId: string) {
  "use step";
  return withJobContext(videoId, async () => {
  const { generateNarrationScene } = await import("@/lib/server/news-delivery");
  return generateNarrationScene(videoId, sceneId);

  });
}
generateNarrationSceneStep.maxRetries = 3;

export async function reconcileEditorialTimingStep(videoId: string) {
  "use step";
  return withJobContext(videoId, async () => {
  const { reconcileEditorialTiming } = await import("@/lib/server/news-delivery");
  return reconcileEditorialTiming(videoId);

  });
}
reconcileEditorialTimingStep.maxRetries = 1;

export async function prepareHybridVisualAssetsStep(videoId: string) {
  "use step";
  return withJobContext(videoId, async () => {
  const { prepareHybridVisualAssets } = await import("@/lib/server/hybrid-assets");
  return prepareHybridVisualAssets(videoId);

  });
}

export async function prepareHybridVisualBeatStep(
  videoId: string,
  beatId: string,
  options: { identitySafe?: boolean; retryFailed?: boolean; forceRegenerate?: boolean; recoveryOfGenerationId?: string; recoveryReason?: string; attempt?: number } = {},
) {
  "use step";
  return withJobContext(videoId, async () => {
  const { prepareHybridVisualBeat } = await import("@/lib/server/hybrid-assets");
  return prepareHybridVisualBeat(videoId, beatId, options);

  });
}
prepareHybridVisualBeatStep.maxRetries = 3;

export async function prepareEditorialScoreStep(videoId: string) {
  "use step";
  return withJobContext(videoId, async () => {
  const { prepareEditorialScore } = await import("@/lib/server/hybrid-assets");
  return prepareEditorialScore(videoId);

  });
}
prepareEditorialScoreStep.maxRetries = 3;

export async function pollHybridVisualAssetsStep(videoId: string, beatIds?: string[]) {
  "use step";
  return withJobContext(videoId, async () => {
  const { pollHybridVisualAssets } = await import("@/lib/server/hybrid-assets");
  return pollHybridVisualAssets(videoId, beatIds);

  });
}

export async function authorizeSafeRecoveryStep(videoId: string, failures: HybridAssetState["failed"]) {
  "use step";
  return withJobContext(videoId, async () => {
  const { authorizeIdentitySafeRecovery } = await import("@/lib/server/production-recovery");
  return authorizeIdentitySafeRecovery(videoId, failures);

  });
}

export async function runVisualRoughCutQaStep(videoId: string) {
  "use step";
  return withJobContext(videoId, async () => {
  const { runVisualRoughCutQa } = await import("@/lib/server/visual-quality");
  return runVisualRoughCutQa(videoId);

  });
}
runVisualRoughCutQaStep.maxRetries = 1;

export async function authorizeVisualAutopolishStep(videoId: string, beatIds: string[]) {
  "use step";
  return withJobContext(videoId, async () => {
  const { authorizeVisualAutopolish } = await import("@/lib/server/production-recovery");
  return authorizeVisualAutopolish(videoId, beatIds);

  });
}

export async function visualAutopolishEnabledStep() {
  "use step";
  const { isVisualAutopolishEnabled, isVisualVarietyQaEnabled } = await import("@/lib/server/config");
  return { qaEnabled: isVisualVarietyQaEnabled(), autoPolishEnabled: isVisualAutopolishEnabled() };
}

export async function recordEditorialStepStep(
  videoId: string,
  stepId: string,
  state: "pending" | "running" | "awaiting_user" | "complete" | "failed" | "cancelled",
  error?: string,
) {
  "use step";
  return withJobContext(videoId, async () => {
  const { recordEditorialStep } = await import("@/lib/server/production-runtime");
  return recordEditorialStep(videoId, stepId, state, error);

  });
}

export async function recordNeedsAttentionStep(videoId: string, message: string, token: string) {
  "use step";
  return withJobContext(videoId, async () => {
  const { recordProductionNeedsAttention } = await import("@/lib/server/production-runtime");
  return recordProductionNeedsAttention(videoId, message, token);

  });
}

export async function recordWorkflowFailureStep(videoId: string, stepId: string, error: string) {
  "use step";
  return withJobContext(videoId, async () => {
  const { recordProductionFailure } = await import("@/lib/server/production-runtime");
  return recordProductionFailure(videoId, stepId, error);

  });
}

export async function recordWorkflowCompleteStep(videoId: string) {
  "use step";
  return withJobContext(videoId, async () => {
  const { recordProductionComplete } = await import("@/lib/server/production-runtime");
  return recordProductionComplete(videoId);

  });
}

export async function runNewsProductionWorkflow(videoId: string, options: NewsWorkflowOptions = {}) {
  "use workflow";
  let activeStep = "narration";
  try {
    const context = await getHybridPreparationContextStep(videoId);
    const selectedBeatIds = options.recoveryBeatIds?.length ? options.recoveryBeatIds : context.beatIds;
    await recordEditorialStepStep(videoId, "narration", "running");
    await runNarrationBatches(videoId, context.sceneIds);
    await recordEditorialStepStep(videoId, "narration", "complete");

    activeStep = "timing_reconciliation";
    await recordEditorialStepStep(videoId, "timing_reconciliation", "running");
    const timing = await reconcileEditorialTimingStep(videoId);
    if (timing.requiresScriptRevision) {
      return { videoId, state: "awaiting_user" as const, reason: "script_revision" as const };
    }
    await recordEditorialStepStep(videoId, "timing_reconciliation", "complete");

    activeStep = "imagery";
    await recordEditorialStepStep(videoId, "imagery", "running");
    await recordEditorialStepStep(videoId, "score", "running");
    await recordEditorialStepStep(videoId, "generation", "running");
    await Promise.all([
      context.mode === "mock"
        ? prepareHybridVisualAssetsStep(videoId)
        : runBeatBatches(videoId, selectedBeatIds, (beatId) => prepareHybridVisualBeatStep(videoId, beatId, {
          identitySafe: options.identitySafeRecovery === true,
          attempt: options.identitySafeRecovery ? 2 : 1,
        })),
      prepareEditorialScoreStep(videoId),
    ]);
    await recordEditorialStepStep(videoId, "imagery", "complete");
    await recordEditorialStepStep(videoId, "score", "complete");
    activeStep = "generation";

    let state: HybridAssetState = context.mode === "mock"
      ? { complete: true, pending: 0, failed: [] }
      : await waitForHybridAssets(videoId, selectedBeatIds);
    for (let retryRound = 0; state.failed.some((failure) => failure.retryable && failure.attempt < 4) && retryRound < 3; retryRound += 1) {
      const transient = state.failed.filter((failure) => failure.retryable && failure.attempt < 4);
      await sleep(retryRound === 0 ? "15s" : retryRound === 1 ? "30s" : "1m");
      await runBeatBatches(videoId, transient.map((failure) => failure.beatId), (beatId) => {
        const failure = transient.find((candidate) => candidate.beatId === beatId);
        return prepareHybridVisualBeatStep(videoId, beatId, {
          retryFailed: true,
          recoveryOfGenerationId: failure?.generationId,
          attempt: (failure?.attempt ?? 1) + 1,
        });
      });
      state = await waitForHybridAssets(videoId, selectedBeatIds);
    }

    if (state.failed.length > 0) {
      const authorization = await authorizeSafeRecoveryStep(videoId, state.failed);
      if (authorization.authorized.length > 0) {
        await runBeatBatches(videoId, authorization.authorized.map((item) => item.beatId), (beatId) => {
          const item = authorization.authorized.find((candidate) => candidate.beatId === beatId);
          return prepareHybridVisualBeatStep(videoId, beatId, {
            identitySafe: true,
            recoveryOfGenerationId: item?.generationId,
            attempt: item?.attempt ?? 2,
          });
        });
        state = await waitForHybridAssets(videoId, selectedBeatIds);
      }
    }

    let recoveryRound = 0;
    while (state.failed.length > 0) {
      recoveryRound += 1;
      const token = `production-recovery:${videoId}:${recoveryRound}`;
      const message = state.failed.map((failure) => `${failure.beatId}: ${failure.error}`).join(" ");
      await recordNeedsAttentionStep(videoId, message, token);
      const hook = createHook<RecoveryPayload>({ token });
      const recovery = await hook;
      await recordEditorialStepStep(videoId, "generation", "running");
      const failuresByBeat = new Map(state.failed.map((failure) => [failure.beatId, failure]));
      await runBeatBatches(videoId, recovery.beatIds, (beatId) => prepareHybridVisualBeatStep(videoId, beatId, {
        identitySafe: recovery.action === "safe_retry",
        retryFailed: recovery.action === "retry_failed_beats",
        recoveryOfGenerationId: failuresByBeat.get(beatId)?.generationId,
        attempt: (failuresByBeat.get(beatId)?.attempt ?? 1) + 1,
      }));
      state = await waitForHybridAssets(videoId, recovery.beatIds);
    }

    if (!state.complete || state.failed.length > 0) {
      throw new Error(state.failed.length > 0
        ? state.failed.map((failure) => `${failure.beatId}: ${failure.error}`).join(" ")
        : "Hybrid visual providers did not complete inside the 45-minute polling window.");
    }

    await recordEditorialStepStep(videoId, "generation", "complete");
    activeStep = "visual_rough_cut_qa";
    const qualityFlags = await visualAutopolishEnabledStep();
    if (qualityFlags.qaEnabled) {
      await recordEditorialStepStep(videoId, "visual_rough_cut_qa", "running");
      let report = await runVisualRoughCutQaStep(videoId);
      if (!report.passed && qualityFlags.autoPolishEnabled && report.autoPolishAttempts < 1 && report.rejectedBeatIds.length > 0) {
        const authorization = await authorizeVisualAutopolishStep(videoId, report.rejectedBeatIds);
        if (authorization.authorized) {
          await runBeatBatches(videoId, authorization.beatIds, (beatId) => prepareHybridVisualBeatStep(videoId, beatId, {
            forceRegenerate: true,
            retryFailed: true,
            recoveryReason: "visual_rough_cut_autopolish",
            attempt: 2,
          }));
          const polishedAssets = await waitForHybridAssets(videoId, authorization.beatIds);
          if (!polishedAssets.complete || polishedAssets.failed.length > 0) throw new Error("Visual auto-polish provider work did not complete.");
          report = await runVisualRoughCutQaStep(videoId);
        }
      }
      let reviewRound = 0;
      while (!report.passed) {
        reviewRound += 1;
        const token = `visual-quality-recovery:${videoId}:${reviewRound}`;
        await recordNeedsAttentionStep(videoId, report.findings.map((finding) => finding.message).join(" "), token);
        await recordEditorialStepStep(videoId, "visual_rough_cut_qa", "awaiting_user", "Visual rough-cut QA needs attention.");
        const hook = createHook<RecoveryPayload>({ token });
        const recovery = await hook;
        await recordEditorialStepStep(videoId, "visual_rough_cut_qa", "running");
        if (recovery.action !== "resume") {
          await runBeatBatches(videoId, recovery.beatIds.length > 0 ? recovery.beatIds : report.rejectedBeatIds, (beatId) => prepareHybridVisualBeatStep(videoId, beatId, {
            forceRegenerate: true,
            retryFailed: true,
            recoveryReason: recovery.action,
            attempt: 2 + reviewRound,
          }));
          await waitForHybridAssets(videoId, recovery.beatIds.length > 0 ? recovery.beatIds : report.rejectedBeatIds);
        }
        report = await runVisualRoughCutQaStep(videoId);
      }
      await recordEditorialStepStep(videoId, "visual_rough_cut_qa", "complete");
    } else {
      await recordEditorialStepStep(videoId, "visual_rough_cut_qa", "complete");
    }
    activeStep = "timeline";
    await compileEditorialTimelineStep(videoId);
    activeStep = "render";
    const result = await generateNewsDeliveryStep(videoId);
    await recordWorkflowCompleteStep(videoId);
    return result;
  } catch (error) {
    const message = workflowFailureMessage(error);
    await recordWorkflowFailureStep(videoId, activeStep, message);
    throw error;
  }
}

export async function runNewsDeliveryResumeWorkflow(videoId: string) {
  "use workflow";
  let activeStep = "timeline";
  try {
    await compileEditorialTimelineStep(videoId);
    activeStep = "render";
    const result = await generateNewsDeliveryStep(videoId);
    await recordWorkflowCompleteStep(videoId);
    return result;
  } catch (error) {
    const message = workflowFailureMessage(error);
    await recordWorkflowFailureStep(videoId, activeStep, message);
    throw error;
  }
}

export async function runHybridBeatRegenerationWorkflow(videoId: string, beatId: string) {
  "use workflow";
  return runNewsProductionWorkflow(videoId, { recoveryBeatIds: [beatId] });
}

export async function runNewsProductionWorkflowLegacy(videoId: string) {
  "use workflow";
  let state = await prepareHybridVisualAssetsStep(videoId);
  if (state.failed.length > 0) throw new FatalError(state.failed.map((failure) => `${failure.beatId}: ${failure.error}`).join(" "));
  for (let attempt = 0; !state.complete && attempt < 160; attempt += 1) {
    await sleep("15s");
    state = await pollHybridVisualAssetsStep(videoId);
    if (state.failed.length > 0) throw new FatalError(state.failed.map((failure) => `${failure.beatId}: ${failure.error}`).join(" "));
  }
  if (!state.complete) throw new RetryableError("Hybrid visual providers did not complete inside the polling window.", { retryAfter: "2m" });
  return generateNewsDeliveryStep(videoId);
}

export function workflowFailureMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object") {
    const candidate = error as Record<string, unknown>;
    for (const key of ["message", "error", "cause"]) {
      const nested = candidate[key];
      if (nested === error) continue;
      const message = workflowFailureMessage(nested);
      if (message !== "Editorial workflow failed.") return message;
    }
  }
  return "Editorial workflow failed.";
}

async function runBeatBatches<T>(videoId: string, beatIds: string[], operation: (beatId: string) => Promise<T>) {
  void videoId;
  for (let index = 0; index < beatIds.length; index += 4) {
    await Promise.all(beatIds.slice(index, index + 4).map(operation));
  }
}

async function runNarrationBatches(videoId: string, sceneIds: string[]) {
  for (let index = 0; index < sceneIds.length; index += 4) {
    await Promise.all(sceneIds.slice(index, index + 4).map((sceneId) => generateNarrationSceneStep(videoId, sceneId)));
  }
}

async function waitForHybridAssets(videoId: string, beatIds?: string[]) {
  let state = await pollHybridVisualAssetsStep(videoId, beatIds);
  for (let attempt = 0; !state.complete && state.failed.length === 0 && attempt < 180; attempt += 1) {
    await sleep("15s");
    state = await pollHybridVisualAssetsStep(videoId, beatIds);
  }
  return state;
}
