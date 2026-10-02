import { spokenScriptText } from "@/lib/editorial-timing";
import { DEFAULT_NARRATION_WORDS_PER_SECOND, narrationBudgetSummary, type NarrationPacing } from "@/lib/hybrid-visuals";
import type { VideoJob } from "@/lib/schemas";

/** One timing decision for the approval UI, approval gate, and recovery writer. */
export function editorialNarrationTiming(job: VideoJob) {
  const titles = job.storyboard?.scenes.map((scene) => scene.title) ?? [];
  const narration = spokenScriptText(job.script ?? job.storyboard?.scenes.map((scene) => scene.narration).join(" ") ?? "", titles);
  const estimate = narrationBudgetSummary(narration, job.durationSeconds);
  const plan = job.visualPlan?.timingPlan;
  const scriptVersionId = job.workflowSteps?.find((step) => step.id === "script")?.artifactVersionId;
  const scriptVersion = job.artifactVersions.find((version) => version.id === scriptVersionId);
  // Older saved timing plans predate scriptVersionId. Their compile time still
  // establishes whether the measurement belongs to the currently saved script.
  const currentMeasurement = plan && plan.productionId === job.id && plan.targetDurationMs === job.durationSeconds * 1_000
    && (plan.scriptVersionId ? plan.scriptVersionId === scriptVersionId
      : Boolean(scriptVersion && Date.parse(plan.compiledAt) >= Date.parse(scriptVersion.createdAt)));
  const timing = currentMeasurement ? plan : undefined;
  const measuredMs = timing?.scenes.reduce((sum, scene) => sum + scene.measuredNarrationMs, 0) ?? 0;
  const wordsPerSecond = measuredMs > 0 && estimate.words > 0
    ? estimate.words / (measuredMs / 1_000)
    : job.visualPlan?.narrationWordsPerSecond;
  const pacing: NarrationPacing | undefined = wordsPerSecond
    ? { wordsPerSecond, sceneCount: job.storyboard?.scenes.length }
    : undefined;
  const budget = narrationBudgetSummary(narration, job.durationSeconds, pacing ?? { wordsPerSecond: DEFAULT_NARRATION_WORDS_PER_SECOND, sceneCount: job.storyboard?.scenes.length });
  const revisionMessage = timing && !timing.coverage.passed
    ? `Recorded narration is ${(timing.coverage.spokenDurationMs / 1_000).toFixed(1)} seconds. This ${job.durationSeconds}-second video needs ${(budget.minimumCoverage * job.durationSeconds).toFixed(1)}–${(job.durationSeconds * 0.92).toFixed(1)} seconds of speech to leave room for transitions. Fit the script to duration, then review and approve the new version.`
    : undefined;
  return {
    budget,
    pacing,
    revisionMessage,
    measured: Boolean(timing),
    durationMs: timing?.coverage.spokenDurationMs ?? budget.predictedDurationMs,
    coverage: timing?.coverage.spokenCoverage ?? budget.predictedCoverage,
    requiresRevision: timing ? !timing.coverage.passed : !budget.withinBudget || budget.words < budget.minimumWords,
  };
}

export function editorialReviewStatus(job: VideoJob) {
  if (!["news_digest", "explainer"].includes(job.contentType ?? "") || job.status !== "awaiting_user") return undefined;
  if (editorialNarrationTiming(job).requiresRevision) return {
    title: "Script revision needed",
    detail: "Generation is paused. Fit the script to the selected duration, then review and approve the revised script and storyboard.",
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
