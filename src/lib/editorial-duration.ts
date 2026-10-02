import type { EditorialDurationPlan, ProductionCreateRequest, SourceBundle, VideoJob } from "@/lib/schemas";
import { DEFAULT_NARRATION_WORDS_PER_SECOND } from "@/lib/hybrid-visuals";

export const MAX_EDITORIAL_SECONDS = 600;
export const EDITORIAL_ENDING_MS = 3_000;
export const EDITORIAL_TRANSITION_MS = 600;
export const DURATION_TOLERANCE = 0.2;

export function usesNaturalDuration(value: { contentType?: VideoJob["contentType"]; durationMode?: ProductionCreateRequest["durationMode"]; durationPlan?: EditorialDurationPlan }) {
  const mode = value.durationMode ?? value.durationPlan?.mode;
  return (value.contentType === "explainer" || value.contentType === "news_digest") && (mode === "auto" || mode === "target");
}

/** Coverage is decided from evidence before any runtime or word budget exists. */
export function sourceCoverageOutline(bundle: SourceBundle, excludedClaimIds: string[] = []): EditorialDurationPlan["coverage"] {
  const seen = new Set<string>();
  return bundle.claims.map((claim, index) => {
    const key = claim.text.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const duplicate = seen.has(key);
    seen.add(key);
    const role = /\b(limit|caveat|uncertain|bias|conflict|cannot|not public|suspend|insufficient|risk)\w*/i.test(claim.text) ? "limitation"
      : /\b(method|calculat|weight|aggregat|process|mechanism|collect|record|normaliz|winsoriz)\w*/i.test(claim.text) ? "mechanism"
      : /\b(evidence|result|observ|experiment|measure|compar|data|study)\w*/i.test(claim.text) ? "evidence"
      : index === 0 ? "core" : "detail";
    const excludedByUser = excludedClaimIds.includes(claim.id);
    const included = claim.status === "supported" && !duplicate && !excludedByUser;
    return {
      claimId: claim.id, sourceIds: claim.sourceIds, text: claim.text, role,
      priority: role === "detail" ? "supporting" : "essential", included,
      reason: excludedByUser ? "Deliberately omitted from the selected scope; evidence remains in the source record." : duplicate ? "Repeated claim; the first occurrence retains the evidence."
        : !included ? "Not sufficiently supported by the supplied sources."
        : role === "detail" ? "Supporting context for a complete explanation." : `Preserves the ${role === "core" ? "central idea" : role} of the source.`,
    };
  });
}

export function editorialMessageExposureMs(text = "") {
  // Allow for both overlay fades as well as three readable words per second.
  return Math.max(2_000, Math.ceil(countEditorialWords(text) / 3 * 1_000 + 360));
}

export function naturalSceneDurationMs(speechMs: number, title: string | undefined, last: boolean) {
  return Math.max(Math.round(speechMs) + (last ? EDITORIAL_ENDING_MS : EDITORIAL_TRANSITION_MS), editorialMessageExposureMs(title));
}

export function estimateNaturalSceneDurations(scenes: Array<{ narration: string; title?: string }>, wordsPerSecond = DEFAULT_NARRATION_WORDS_PER_SECOND) {
  const durations = scenes.map((scene, index) => naturalSceneDurationMs(countEditorialWords(scene.narration) / Math.max(0.5, wordsPerSecond) * 1_000, scene.title, index === scenes.length - 1));
  const total = durations.reduce((sum, duration) => sum + duration, 0);
  if (durations.length) durations[durations.length - 1] += Math.max(5_000, Math.ceil(total / 1_000) * 1_000) - total;
  return durations;
}

export function estimateNaturalSeconds(scenes: Array<{ narration: string; title?: string }>, wordsPerSecond = DEFAULT_NARRATION_WORDS_PER_SECOND) {
  return Math.max(5, estimateNaturalSceneDurations(scenes, wordsPerSecond).reduce((sum, duration) => sum + duration, 0) / 1_000);
}

export function countEditorialWords(text: string) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function outsideDurationTolerance(seconds: number, target: number, tolerance = DURATION_TOLERANCE) {
  return seconds < target * (1 - tolerance) || seconds > target * (1 + tolerance);
}

export function makeDurationPlan(input: {
  request: Pick<ProductionCreateRequest, "durationMode" | "targetDurationSeconds"> & { voiceId?: string; excludedClaimIds?: string[] };
  sourceBundle: SourceBundle;
  scenes: Array<{ narration: string; claimIds: string[]; title: string }>;
  wordsPerSecond?: number;
  now: string;
}): EditorialDurationPlan {
  const estimated = estimateNaturalSeconds(input.scenes, input.wordsPerSecond);
  const used = new Set(input.scenes.flatMap((scene) => scene.claimIds));
  const coverage = sourceCoverageOutline(input.sourceBundle, input.request.excludedClaimIds).map((point) => point.included && !used.has(point.claimId)
    ? { ...point, included: false, reason: "Outside this outline's selected scope; retained in the source record." } : point);
  const scopeTooLong = estimated > MAX_EDITORIAL_SECONDS;
  return {
    version: 1, mode: input.request.durationMode, voiceId: input.request.voiceId, excludedClaimIds: input.request.excludedClaimIds, tolerance: DURATION_TOLERANCE,
    requestedTargetSeconds: input.request.durationMode === "target" ? input.request.targetDurationSeconds : undefined,
    estimatedDurationSeconds: estimated, needsReview: true, scopeTooLong,
    rationale: scopeTooLong ? "The complete outline needs more than ten minutes. Narrow the scope before generating media; the full outline is saved."
      : input.request.durationMode === "target" && outsideDurationTolerance(estimated, input.request.targetDurationSeconds)
      ? "The complete explanation falls outside your approximate length. Review this runtime or narrow the scope; no content was cut to fit."
      : "Runtime includes the complete explanation at a natural speaking pace, brief transitions, and a three-second closing hold.",
    coverage, closingTakeaway: closingTakeaway(input.scenes.at(-1)), updatedAt: input.now,
  };
}

function closingTakeaway(scene: { title: string; narration: string } | undefined) {
  if (!scene) return "Key takeaway";
  const generic = ["How the method works", "What the evidence shows", "Limits of the findings", "The central idea", "Supporting context"];
  // The deterministic draft uses chapter labels when no concise source sentence
  // exists. Its ending still shows a complete, source-supported conclusion.
  if (generic.includes(scene.title)) return scene.narration.match(/[^.!?]+[.!?](?:\s|$)/g)?.at(-1)?.trim() ?? scene.narration;
  return scene.title;
}

/** Compare with what the user actually approved, not just their original hint. */
export function resolveDurationPlan(plan: EditorialDurationPlan, seconds: number, costCents: number, now: string): EditorialDurationPlan {
  const scopeTooLong = seconds > MAX_EDITORIAL_SECONDS;
  const changed = plan.approvedDurationSeconds === undefined || outsideDurationTolerance(seconds, plan.approvedDurationSeconds, plan.tolerance);
  const costChanged = plan.approvedCostCents === undefined || costCents > plan.approvedCostCents;
  const needsReview = scopeTooLong || changed || costChanged;
  return {
    ...plan, resolvedDurationSeconds: seconds, scopeTooLong, needsReview, updatedAt: now,
    rationale: scopeTooLong ? "Recorded narration needs more than ten minutes. Narrow the saved outline before continuing."
      : needsReview ? "Measured narration changes the approved runtime or cost. Review the updated proposal before further media generation. Your recording and completed visuals are saved."
      : "Resolved from recorded narration at normal speed, transitions, and a three-second closing hold.",
  };
}
