import { compileEditorialTimingPlan, spokenScriptText } from "@/lib/editorial-timing";
import { DEFAULT_NARRATION_WORDS_PER_SECOND, narrationBudgetSummary, type NarrationPacing } from "@/lib/hybrid-visuals";
import type { VideoJob } from "@/lib/schemas";
import { usesNaturalDuration } from "@/lib/editorial-duration";

/** One timing decision for the approval UI, approval gate, and recovery writer. */
export function editorialNarrationTiming(job: VideoJob) {
  const titles = job.storyboard?.scenes.map((scene) => scene.title) ?? [];
  const narration = spokenScriptText(job.script ?? job.storyboard?.scenes.map((scene) => scene.narration).join(" ") ?? "", titles);
  const estimate = narrationBudgetSummary(narration, job.durationSeconds);
  const natural = usesNaturalDuration(job);
  const plan = job.visualPlan?.timingPlan;
  const scriptVersionId = job.workflowSteps?.find((step) => step.id === "script")?.artifactVersionId;
  const scriptVersion = job.artifactVersions.find((version) => version.id === scriptVersionId);
  // Older saved timing plans predate scriptVersionId. Their compile time still
  // establishes whether the measurement belongs to the currently saved script.
  const currentMeasurement = plan && plan.productionId === job.id && plan.targetDurationMs === job.durationSeconds * 1_000
    && (plan.scriptVersionId ? plan.scriptVersionId === scriptVersionId
      : Boolean(scriptVersion && Date.parse(plan.compiledAt) >= Date.parse(scriptVersion.createdAt)));
  const timing = currentMeasurement ? plan : undefined;
  const recordingFit = timing && !timing.coverage.passed && job.storyboard
    ? compileEditorialTimingPlan({ productionId: job.id, scriptVersionId, storyboard: job.storyboard,
      narration: timing.scenes.map((scene) => ({ sceneId: scene.sceneId, durationMs: scene.measuredNarrationMs })),
      targetDurationMs: job.durationSeconds * 1_000, compiledAt: timing.compiledAt })
    : undefined;
  const canFitRecording = recordingFit?.coverage.passed === true;
  const measuredMs = timing?.scenes.reduce((sum, scene) => sum + scene.measuredNarrationMs, 0) ?? 0;
  const wordsPerSecond = measuredMs > 0 && estimate.words > 0
    ? estimate.words / (measuredMs / 1_000)
    : job.visualPlan?.narrationWordsPerSecond;
  const pacing: NarrationPacing | undefined = wordsPerSecond
    ? { wordsPerSecond, sceneCount: job.storyboard?.scenes.length }
    : undefined;
  const fixedBudget = narrationBudgetSummary(narration, job.durationSeconds, pacing ?? { wordsPerSecond: DEFAULT_NARRATION_WORDS_PER_SECOND, sceneCount: job.storyboard?.scenes.length });
  const budget = natural ? { ...fixedBudget, withinBudget: true, minimumWords: 0, minimumCoverage: 0 } : fixedBudget;
  const revisionMessage = timing && !timing.coverage.passed
    ? canFitRecording
      ? `Recorded narration is ${(measuredMs / 1_000).toFixed(1)} seconds. Fit the existing recording to duration with a small pacing adjustment; the script, citations, and voice take are retained.`
      : `Recorded narration is ${(timing.coverage.spokenDurationMs / 1_000).toFixed(1)} seconds. This ${job.durationSeconds}-second video needs ${(budget.minimumCoverage * job.durationSeconds).toFixed(1)}–${(job.durationSeconds * 0.92).toFixed(1)} seconds of speech to leave room for transitions. Fit the script to duration, then review and approve the new version.`
    : undefined;
  return {
    budget,
    pacing,
    revisionMessage,
    measured: Boolean(timing),
    canFitRecording,
    recordedDurationMs: measuredMs,
    retimeRate: timing?.scenes[0]?.retimeRate ?? 1,
    durationMs: timing?.coverage.spokenDurationMs ?? budget.predictedDurationMs,
    coverage: timing?.coverage.spokenCoverage ?? budget.predictedCoverage,
    requiresRevision: timing ? !timing.coverage.passed : !budget.withinBudget || budget.words < budget.minimumWords,
  };
}

export function editorialReviewStatus(job: VideoJob) {
  if (!["news_digest", "explainer"].includes(job.contentType ?? "") || job.status !== "awaiting_user") return undefined;
  if (usesNaturalDuration(job) && job.durationPlan?.needsReview) return {
    title: job.durationPlan.scopeTooLong ? "Narrow the scope" : "Review the proposed runtime",
    detail: job.durationPlan.rationale,
  };
  const timing = editorialNarrationTiming(job);
  if (timing.requiresRevision) return {
    title: timing.canFitRecording ? "Timing adjustment needed" : "Script revision needed",
    detail: timing.canFitRecording
      ? "Fit the existing recording to the selected duration, then review and continue. Your script and voice take are saved."
      : "Generation is paused. Fit the script to the selected duration, then review and approve the revised script and storyboard.",
  };
  const awaitingApproval = ["script", "storyboard"].some((gate) => {
    const version = job.workflowSteps?.find((step) => step.id === gate)?.artifactVersionId;
    return !version || !job.approvals?.some((approval) => approval.gate === gate && approval.artifactVersionId === version);
  });
  if (!awaitingApproval) return {
    title: "Production needs attention",
    detail: job.error ?? "Review the production status and recover the unfinished work. Your approved script and completed assets are saved.",
  };
  return {
    title: "Waiting for your approval",
    detail: "Generation is paused while you review the current script or storyboard.",
  };
}
