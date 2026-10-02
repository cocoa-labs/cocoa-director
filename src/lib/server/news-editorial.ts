import { editorialNarrationTiming } from "@/lib/editorial-narration";
import { makeDurationPlan, usesNaturalDuration } from "@/lib/editorial-duration";
import { naturalEditorialAllowance } from "@/lib/editorial-costs";
import { criticalSection } from "@/lib/server/critical-section";
import { ApiRequestError } from "@/lib/server/api-error";
import { randomUUID } from "node:crypto";

import type { HybridVisualPlanV2, NewsStoryboard, SourceClaim, VideoJob, VisualStylePreset, WorkflowStep } from "@/lib/schemas";
import { validateTimeline } from "@/lib/production";
import { spokenScriptText, applyTimingPlan, compileNaturalEditorialTiming } from "@/lib/editorial-timing";
import { applyValidatedLikenessRouting, narrationBudgetSummary, recalculateHybridVisualPlan } from "@/lib/hybrid-visuals";
import type { UserContext } from "@/lib/server/auth";
import { isCinematicReenactmentsEnabled, isHybridSafeRecoveryEnabled, isHybridVisualsV2Enabled, isHybridWorkflowV4Enabled, isLikenessLiveValidated, isLikenessVideoEnabled } from "@/lib/server/config";
import { getStore } from "@/lib/server/store";
import { validateGraphicPayload } from "@/lib/server/source-visuals";
import { readableEditorialMessage } from "@/lib/server/editorial-graphics";

export type NewsGate = "script" | "storyboard";

export function assertDurationProposal(job: VideoJob, acceptedSeconds?: number) {
  if (!usesNaturalDuration(job)) return;
  if (job.durationPlan?.scopeTooLong || job.durationSeconds > 600) throw new ApiRequestError("This outline exceeds ten minutes. Narrow the scope before generating media.", 409, "duration_scope_too_long");
  if (acceptedSeconds !== job.durationSeconds) throw new ApiRequestError("Review and accept the current runtime and cost before generating media.", 409, "duration_review_required");
}

export function assertEditorialStoryboardReady(job: VideoJob) {
  const blockers = storyboardBlockers(job);
  if (blockers.length) throw new ApiRequestError(blockers.join(" "), 409, "approval_blocked");
}

export async function invalidateNewsAfterSourceChange(productionId?: string, source?: { id: string; projectId: string }) {
  const store = getStore();
  const linked = source ? (await store.listProjectJobs(source.projectId)).filter((job) => job.sourceBundle?.inputs.some((input) => input.sourceRecordId === source.id)).map((job) => job.id) : [];
  const resetIds = ["research", "editorial", "script", "script_approval", "storyboard", "storyboard_approval", "narration", "timing_reconciliation", "imagery", "score", "generation", "visual_rough_cut_qa", "timeline", "preflight_qa", "render", "final_qa", "qa", "review"];
  for (const id of new Set([...linked, ...(productionId ? [productionId] : [])])) {
    await store.mutateJob(id, (job) => {
      if (!["news_digest", "explainer"].includes(job.contentType ?? "") || job.status === "complete" || job.status === "cancelled") return {};
      if (job.status === "running") throw new ApiRequestError("Wait for the production using this source to finish before changing it.", 409, "source_in_use");
      return {
        approvals: [], workflowSteps: resetFrom(job.workflowSteps ?? [], resetIds), status: "awaiting_user",
        editorialPlan: undefined, storyboard: undefined, script: undefined, timelineManifest: undefined,
        durationPlan: job.durationPlan ? { ...job.durationPlan, needsReview: true, approvedDurationSeconds: undefined, approvedCostCents: undefined } : undefined,
        qaReport: undefined, narrationAssetId: undefined,
        error: "Sources changed. Regenerate the cited editorial draft before approval.",
      };
    });
  }
}

export async function approveNewsGate(input: {
  job: VideoJob;
  user: UserContext;
  gate: NewsGate;
  artifactVersionId: string;
  confirmSpend?: boolean;
  acceptedDurationSeconds?: number;
}) {
  const { gate } = input;
  let launch = false;
  const updated = await criticalSection(`editorial:${input.job.projectId}`, () => getStore().mutateJob(input.job.id, (job) => {
  if (job.userId !== input.user.id) throw new Error("Production not found.");
  if (job.cancellationRequested || job.status === "cancelled") throw new Error("Production cancelled.");
  if (job.contentType !== "news_digest" && job.contentType !== "explainer") throw new Error("Approvals are only available for news and explainer productions.");
  const artifactStepId = gate === "script" ? "script" : "storyboard";
  const artifactStep = job.workflowSteps?.find((step) => step.id === artifactStepId);
  if (!artifactStep?.artifactVersionId || artifactStep.artifactVersionId !== input.artifactVersionId) {
    throw new Error(`This ${gate} approval is stale. Review the latest version before approving.`);
  }
  if (!job.artifactVersions.some((version) => version.id === input.artifactVersionId)) {
    throw new Error(`${gate} artifact version not found.`);
  }
  const blockers = gate === "script" ? scriptBlockers(job) : storyboardBlockers(job);
  if (blockers.length > 0) throw new ApiRequestError(blockers.join(" "), 409, "approval_blocked");
  if (gate === "storyboard") {
    assertDurationProposal(job, input.acceptedDurationSeconds);
    const activeScriptVersion = job.workflowSteps?.find((step) => step.id === "script")?.artifactVersionId;
    const scriptApproved = job.approvals?.some((approval) => approval.gate === "script" && approval.artifactVersionId === activeScriptVersion);
    if (!scriptApproved) throw new Error("Approve the current cited script before approving the storyboard.");
    if (!input.confirmSpend) throw new Error("Spend confirmation is required before narration and asset generation.");
  }
  if (job.approvals?.some((approval) => approval.gate === gate && approval.artifactVersionId === input.artifactVersionId)) return {};
  const now = new Date().toISOString();
  const approval = { gate, artifactVersionId: input.artifactVersionId, approvedBy: input.user.id, approvedAt: now };
  const approvals = [...(job.approvals ?? []).filter((item) => item.gate !== gate), approval];
  const workflowSteps = advanceApprovalSteps(job.workflowSteps ?? [], gate, now);
  launch = gate === "storyboard";
  return { approvals, workflowSteps,
    ...(gate === "storyboard" && usesNaturalDuration(job) && job.durationPlan ? { durationPlan: { ...job.durationPlan, needsReview: false, approvedDurationSeconds: job.durationSeconds, approvedCostCents: job.estimatedCostCents + job.recoveryBudgetCents, updatedAt: now } } : {}),
    status: gate === "storyboard" ? "running" : "awaiting_user", error: undefined };
  }));
  if (launch) await startApprovedEditorialGeneration(input.job.id);
  return updated;
}

export async function updateNewsDraft(input: {
  job: VideoJob;
  script?: string;
  claims?: SourceClaim[];
  storyboard?: NewsStoryboard;
  visualPlan?: HybridVisualPlanV2;
  visualStylePreset?: VisualStylePreset;
}) {
  return criticalSection(`editorial:${input.job.projectId}`, () => getStore().mutateJob(input.job.id, (job) => {
  if (job.status === "running") throw new ApiRequestError("Wait for this run to finish before editing its approved draft.", 409, "production_running");
  if (job.updatedAt !== input.job.updatedAt) throw new ApiRequestError("This draft changed. Reload it before saving.", 409, "stale_draft");
  if (input.script === job.script && input.script !== undefined && !input.claims && !input.storyboard && !input.visualPlan && !input.visualStylePreset) return {};
  if (job.contentType !== "news_digest" && job.contentType !== "explainer") throw new Error("Draft editing is only available for news and explainer productions.");
  const now = new Date().toISOString();
  const artifactVersions = [...job.artifactVersions];
  let workflowSteps = [...(job.workflowSteps ?? [])];
  let approvals = [...(job.approvals ?? [])];
  let scriptVersionId: string | undefined;
  let storyboardVersionId: string | undefined;
  if (input.script !== undefined) {
    scriptVersionId = randomUUID();
    artifactVersions.push({ id: scriptVersionId, scope: "script", label: `Cited script v${versionCount(artifactVersions, "script") + 1}`, payload: input.script, urls: {}, createdAt: now });
    workflowSteps = setArtifactVersion(workflowSteps, "script", scriptVersionId);
    workflowSteps = resetFrom(workflowSteps, ["script_approval", "storyboard", "storyboard_approval", "narration", "timing_reconciliation", "imagery", "score", "generation", "visual_rough_cut_qa", "timeline", "preflight_qa", "render", "final_qa", "qa", "review"]);
    workflowSteps = setStepState(workflowSteps, "script", "complete", now);
    workflowSteps = setStepState(workflowSteps, "script_approval", "awaiting_user");
    approvals = [];
  }
  let synchronizedStoryboard = input.script !== undefined && job.storyboard
    ? storyboardForEditedScript(input.script, input.storyboard ?? job.storyboard)
    : input.storyboard;
  const pacing = editorialNarrationTiming(job).pacing;
  let visualPlan = input.visualPlan ? applyValidatedLikenessRouting(
    recalculateHybridVisualPlan(input.visualPlan),
    isCinematicReenactmentsEnabled() && isLikenessVideoEnabled() && isLikenessLiveValidated(),
  ) : input.script !== undefined && job.visualPlan ? {
    ...job.visualPlan,
    timingPlan: undefined,
    narrationWordsPerSecond: pacing?.wordsPerSecond,
    metrics: { ...job.visualPlan.metrics, predictedNarrationDurationMs: narrationBudgetSummary(spokenScriptText(input.script, job.storyboard?.scenes.map((scene) => scene.title) ?? []), job.durationSeconds, pacing).predictedDurationMs },
  } : undefined;
  if (synchronizedStoryboard !== undefined || visualPlan !== undefined || input.visualStylePreset !== undefined) {
    const nextStoryboard = synchronizedStoryboard ?? job.storyboard;
    storyboardVersionId = randomUUID();
    artifactVersions.push({ id: storyboardVersionId, scope: "storyboard", label: `Storyboard v${versionCount(artifactVersions, "storyboard") + 1}`, payload: { storyboard: nextStoryboard, visualPlan: visualPlan ?? job.visualPlan }, urls: {}, createdAt: now });
    workflowSteps = setArtifactVersion(workflowSteps, "storyboard", storyboardVersionId);
    workflowSteps = resetFrom(workflowSteps, ["storyboard_approval", "narration", "timing_reconciliation", "imagery", "score", "generation", "visual_rough_cut_qa", "timeline", "preflight_qa", "render", "final_qa", "qa", "review"]);
    workflowSteps = setStepState(workflowSteps, "storyboard", "complete", now);
    workflowSteps = setStepState(workflowSteps, "storyboard_approval", "awaiting_user");
    approvals = approvals.filter((approval) => approval.gate !== "storyboard");
  }
  if (input.claims !== undefined) {
    approvals = [];
    workflowSteps = resetFrom(workflowSteps, ["script_approval", "storyboard", "storyboard_approval", "narration", "timing_reconciliation", "imagery", "score", "generation", "visual_rough_cut_qa", "timeline", "preflight_qa", "render", "final_qa", "qa", "review"]);
    workflowSteps = setStepState(workflowSteps, "script_approval", "awaiting_user");
  }
  const sourceBundle = input.claims ? { ...(job.sourceBundle ?? { inputs: [], claims: [] }), claims: input.claims } : job.sourceBundle;
  let durationPlan = usesNaturalDuration(job) && job.durationPlan && sourceBundle && (synchronizedStoryboard || input.claims)
    ? makeDurationPlan({ request: { durationMode: job.durationPlan.mode, voiceId: job.durationPlan.voiceId, excludedClaimIds: job.durationPlan.excludedClaimIds, targetDurationSeconds: job.durationPlan.requestedTargetSeconds ?? Math.min(600, job.durationSeconds) }, sourceBundle, scenes: (synchronizedStoryboard ?? job.storyboard)?.scenes ?? [], wordsPerSecond: pacing?.wordsPerSecond, now }) : job.durationPlan;
  if (durationPlan && usesNaturalDuration(job) && synchronizedStoryboard && (visualPlan ?? job.visualPlan)) {
    const estimatedTiming = compileNaturalEditorialTiming({ productionId: job.id, storyboard: synchronizedStoryboard, narration: synchronizedStoryboard.scenes.map((scene) => ({ sceneId: scene.id, durationMs: Math.max(1000, Math.round(scene.narration.split(/\s+/).length / (pacing?.wordsPerSecond ?? 2) * 1000)) })), compiledAt: now });
    const timed = applyTimingPlan(synchronizedStoryboard, (visualPlan ?? job.visualPlan)!, estimatedTiming);
    synchronizedStoryboard = timed.storyboard;
    visualPlan = { ...recalculateHybridVisualPlan(timed.plan), timingPlan: undefined };
    durationPlan = { ...durationPlan, estimatedDurationSeconds: estimatedTiming.targetDurationMs / 1000, scopeTooLong: estimatedTiming.targetDurationMs > 600_000 };
    const artifact = artifactVersions.find((version) => version.id === storyboardVersionId);
    if (artifact) artifact.payload = { storyboard: synchronizedStoryboard, visualPlan };
  }
  const qaReport = job.timelineManifest
    ? validateTimeline({ timeline: job.timelineManifest, sourceBundle, checkedAt: now })
    : job.qaReport;
  return {
    durationPlan,
    ...(durationPlan && synchronizedStoryboard ? { durationSeconds: durationPlan.estimatedDurationSeconds, timelineManifest: undefined, finalVideoUrl: undefined } : {}),
    ...(input.script !== undefined ? { script: input.script } : {}),
    ...(synchronizedStoryboard !== undefined ? { storyboard: synchronizedStoryboard, editorialPlan: job.editorialPlan ? { ...job.editorialPlan, scenes: synchronizedStoryboard.scenes } : undefined } : {}),
    ...(visualPlan !== undefined ? { visualPlan } : {}),
    ...(input.visualPlan !== undefined && visualPlan !== undefined ? {
      estimatedCostCents: visualPlan.metrics.estimatedCostCents + 150,
      recoveryBudgetCents: isHybridSafeRecoveryEnabled() ? Math.ceil(visualPlan.metrics.estimatedCostCents * 0.15) : 0,
      recoverySpentCents: 0,
    } : {}),
    ...(durationPlan && visualPlan ? { estimatedCostCents: naturalEditorialAllowance({ plan: visualPlan, aspectRatio: job.aspectRatio, durationSeconds: durationPlan.estimatedDurationSeconds, narration: (synchronizedStoryboard ?? job.storyboard)?.scenes.map((scene) => scene.narration) }), recoveryBudgetCents: Math.ceil(visualPlan.metrics.estimatedCostCents * .15) } : {}),
    ...(input.visualStylePreset !== undefined ? { visualStylePreset: input.visualStylePreset } : {}),
    sourceBundle,
    qaReport,
    approvals,
    artifactVersions,
    workflowSteps,
    status: "awaiting_user",
    error: qaReport?.passed ? undefined : "Draft requires QA corrections before approval.",
  };
  }));
}


function storyboardForEditedScript(script: string, storyboard: NewsStoryboard): NewsStoryboard {
  const titles = storyboard.scenes.map((scene) => scene.title);
  const clean = (text: string) => spokenScriptText(text, titles).replace(/\[claim:[^\]]+\]/g, "").replace(/\s+/g, " ").trim();
  let paragraphs = script.split(/\n\s*\n/).map(clean).filter(Boolean);
  if (paragraphs.length !== storyboard.scenes.length) {
    const sentences = clean(script).split(/(?<=[.!?])\s+/).filter(Boolean);
    const units = sentences.length >= storyboard.scenes.length ? sentences : clean(script).split(/\s+/);
    if (units.length < storyboard.scenes.length) throw new ApiRequestError("Add narration for each storyboard scene before saving.", 400, "incomplete_scene_narration");
    paragraphs = storyboard.scenes.map((_, index) => units.slice(Math.floor(index * units.length / storyboard.scenes.length), Math.floor((index + 1) * units.length / storyboard.scenes.length)).join(" "));
  }
  return { ...storyboard, scenes: storyboard.scenes.map((scene, index) => ({ ...scene, narration: paragraphs[index] })) };
}

function scriptBlockers(job: VideoJob) {
  const blockers: string[] = [];
  if (usesNaturalDuration(job) && job.durationPlan?.scopeTooLong) blockers.push("The complete outline exceeds ten minutes. Narrow its scope before generating media; your outline is saved.");
  // The versioned script is the approval artifact and therefore the authoritative
  // input for this gate. Storyboard narration is rebuilt from the fitted script before
  // the storyboard gate and must not make a corrected script appear permanently stale.
  const timing = editorialNarrationTiming(job);
  const budget = timing.budget;
  if (timing.measured && timing.requiresRevision) {
    blockers.push("Recorded narration does not fit the selected duration. Fit the script to duration and review the new version before approval.");
  }
  if (!timing.measured && !budget.withinBudget) {
    blockers.push(`Narration is ${budget.words} words; the ${job.durationSeconds}-second voice budget is ${budget.budgetWords}. Condense the script before approval.`);
  }
  if (!timing.measured && budget.words < budget.minimumWords) blockers.push(`Estimated spoken coverage is ${Math.round(budget.predictedCoverage * 100)}%; add sourced context or shorten the selected duration before approval.`);
  if (job.contentType !== "news_digest" && job.contentType !== "explainer") return blockers;
  const claims = new Map((job.sourceBundle?.claims ?? []).map((claim) => [claim.id, claim]));
  const narratedClaimIds = new Set(
    [...(job.script?.matchAll(/\[claim:([^\]]+)\]/g) ?? [])].map((match) => match[1]),
  );
  // Explainers retain their editable, narration-only script format. Their
  // citation lineage is carried by the synchronized storyboard scenes.
  if (job.contentType === "explainer") {
    for (const scene of job.storyboard?.scenes ?? []) for (const claimId of scene.claimIds) narratedClaimIds.add(claimId);
  }
  for (const claimId of narratedClaimIds) {
    const claim = claims.get(claimId);
    if (!claim) {
      blockers.push(`Cited script references an unknown claim: ${claimId}.`);
      continue;
    }
    if (claim.editorialStatus === "excluded") {
      blockers.push(`Cited script references an excluded claim: ${claim.text}`);
      continue;
    }
    if (claim.status !== "supported" || claim.evidenceRefs.length === 0) blockers.push(`Unsupported or uncited narrated claim: ${claim.text}`);
    const independentCount = new Set((claim.independenceGroup ?? "").split("|").filter(Boolean)).size;
    if (claim.breaking && independentCount < 2) blockers.push(`Breaking claim needs two independent sources: ${claim.text}`);
  }
  if (narratedClaimIds.size === 0) blockers.push("The cited script does not contain any claim markers.");
  return blockers;
}

function storyboardBlockers(job: VideoJob) {
  const blockers: string[] = [];
  const spokenScript = spokenScriptText(job.script ?? "", job.storyboard?.scenes.map((scene) => scene.title) ?? []).replace(/\[claim:[^\]]+\]/g, "").replace(/\s+/g, " ").trim();
  const narrated = job.storyboard?.scenes.map((scene) => scene.narration).join(" ").replace(/\[claim:[^\]]+\]/g, "").replace(/\s+/g, " ").trim();
  if (spokenScript !== narrated) blockers.push("The storyboard narration differs from the saved script. Save the script again, then review both approvals.");
  if (!isHybridVisualsV2Enabled()) return blockers;
  if (!job.visualPlan || job.visualPlan.beats.length === 0) blockers.push("Hybrid visual plan is missing or empty.");
  const cinematic = job.visualPlan?.beats.filter((beat) => ["cinematic_broll", "synthetic_reenactment", "composite"].includes(beat.kind)) ?? [];
  if (job.qualityTier !== "draft" && cinematic.length === 0) blockers.push("Standard and Premium storyboards require cinematic visual beats.");
  for (const beat of job.visualPlan?.beats ?? []) {
    if (usesNaturalDuration(job)) {
      const scene = job.storyboard?.scenes.find((scene) => scene.id === beat.sceneId);
      try { readableEditorialMessage(scene?.title ?? "Key idea", beat.sourceVisual?.excerpt, beat.endMs - beat.startMs); }
      catch (error) { blockers.push(error instanceof Error ? error.message : "Shorten the primary on-screen message for comfortable reading."); }
    }
    if (beat.kind === "synthetic_reenactment") {
      if (!isCinematicReenactmentsEnabled()) blockers.push(`Synthetic reenactment ${beat.id} is disabled for this deployment.`);
      if (!beat.disclosure.required || !beat.disclosure.persistent || !beat.disclosure.label) blockers.push(`Synthetic reenactment ${beat.id} requires a persistent disclosure label.`);
    }
    if (beat.endMs <= beat.startMs) blockers.push(`Visual beat ${beat.id} has invalid timing.`);
    if ((job.visualPlan?.version ?? 0) >= 4 && ["documentary_source", "document_excerpt", "data_visualization"].includes(beat.kind)) {
      const validation = validateGraphicPayload(beat);
      if (!validation.valid) blockers.push(`Visual treatment unavailable for ${beat.id}: ${validation.reason}`);
    }
    const durationMs = beat.endMs - beat.startMs;
    if ((job.visualPlan?.version ?? 0) >= 4 && (durationMs < 1_900 || durationMs > 6_100)) blockers.push(`Visual beat ${beat.id} lasts ${(durationMs / 1_000).toFixed(1)} seconds; V4 beats must be planned between 2 and 6 seconds.`);
    const fullScreenLimit = beat.sourceVisual?.kind === "pdf_page" || beat.sourceVisual?.kind === "pdf_highlight_crop" ? 4_000 : 3_000;
    if (beat.fullScreen && durationMs > fullScreenLimit) blockers.push(`Full-screen information beat ${beat.id} lasts ${(durationMs / 1_000).toFixed(1)} seconds; shorten or layer it before approval.`);
  }
  return blockers;
}

function advanceApprovalSteps(steps: WorkflowStep[], gate: NewsGate, completedAt: string) {
  let next = setStepState(steps, gate === "script" ? "script_approval" : "storyboard_approval", "complete", completedAt);
  if (gate === "script") {
    next = setStepState(next, "storyboard", "complete", completedAt);
    next = setStepState(next, "storyboard_approval", "awaiting_user");
  }
  return next;
}

function resetFrom(steps: WorkflowStep[], ids: string[]): WorkflowStep[] {
  const reset = new Set(ids);
  return steps.map((step): WorkflowStep => reset.has(step.id) ? { ...step, state: "pending", startedAt: undefined, completedAt: undefined, error: undefined } : step);
}

function setStepState(steps: WorkflowStep[], id: string, state: WorkflowStep["state"], completedAt?: string) {
  return steps.map((step) => step.id === id ? { ...step, state, completedAt: state === "complete" ? completedAt : undefined, error: undefined } : step);
}

function setArtifactVersion(steps: WorkflowStep[], id: string, artifactVersionId: string) {
  return steps.map((step) => step.id === id ? { ...step, artifactVersionId } : step);
}

function versionCount(versions: VideoJob["artifactVersions"], scope: "script" | "storyboard") {
  return versions.filter((version) => version.scope === scope).length;
}

async function startApprovedEditorialGeneration(videoId: string) {
  const { runNewsProductionWorkflow, runNewsProductionWorkflowLegacy } = await import("@/workflow/news");
  const workflow = isHybridWorkflowV4Enabled() ? runNewsProductionWorkflow : runNewsProductionWorkflowLegacy;
  if (process.env.NODE_ENV === "test") {
    await workflow(videoId);
    return;
  }
  const { start } = await import("workflow/api");
  const run = await start(workflow, [videoId]);
  const { registerProductionWorkflowRun } = await import("@/lib/server/production-runtime");
  const job = await getStore().getJob(videoId);
  await registerProductionWorkflowRun({
    productionId: videoId,
    runId: run.runId,
    kind: "main",
    workflowVersion: isHybridWorkflowV4Enabled() ? job?.workflowVersion ?? (job?.contentType === "explainer" ? "explainer-v5" : "news-digest-v6") : job?.contentType === "explainer" ? "explainer-v2" : "news-digest-v3",
  });
}
