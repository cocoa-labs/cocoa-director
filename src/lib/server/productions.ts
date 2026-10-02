import { createHash, randomUUID } from "node:crypto";

import { ProductionCreateRequest, type SourceBundle, type SourceFragment, type VideoJob, type WorkflowStep } from "@/lib/schemas";
import { isExplicitBreakingClaim } from "@/lib/news-claims";
import { applyValidatedLikenessRouting, attachVisualPlanToStoryboard, buildHybridVisualPlan, narrationBudgetSummary } from "@/lib/hybrid-visuals";
import { ApiRequestError } from "@/lib/server/api-error";
import type { UserContext } from "@/lib/server/auth";
import { isCinematicReenactmentsEnabled, isEditorialDirectionV3Enabled, isEditorialTimingV2Enabled, isHybridSafeRecoveryEnabled, isHybridVisualsV2Enabled, isHybridWorkflowV4Enabled, isLikenessLiveValidated, isLikenessVideoEnabled, isNewsDigestV2Enabled, isNewsPresenterEnabled, isNewsWebResearchEnabled, isSourceVisualsV2Enabled } from "@/lib/server/config";
import { attachAuthenticSourceVisuals } from "@/lib/server/source-visuals";
import { getStore } from "@/lib/server/store";
import { corroborateNewsBundle } from "@/lib/server/news-research";
import { fitNewsEditorialOutline, generateNewsEditorialOutline } from "@/lib/server/news-editorial-ai";
import { auditDifficultNewsClaims } from "@/lib/server/news-factual-audit";
import { extractIntelligentNewsClaims } from "@/lib/server/news-source-intelligence";
import { hydrateBundleFromRecords, hydrateSourceBundle } from "@/lib/server/source-processing";
import {
  initialWorkflowSteps,
  legacyVideoRequestForProduction,
  validateTimeline,
  workflowProfileFor,
} from "@/lib/production";
import { buildSourceFirstDraft } from "@/workflow/source-first";

export async function createProduction(input: ProductionCreateRequest, user: UserContext): Promise<VideoJob> {
  const store = getStore();
  if (input.contentType === "news_digest" && !isNewsDigestV2Enabled()) {
    throw new ApiRequestError("News Digest V2 is not enabled.", 409, "feature_unavailable");
  }
  if (input.researchMode === "corroborate" && !isNewsWebResearchEnabled()) {
    throw new ApiRequestError("Web corroboration is unavailable here. Choose supplied sources only, or enable NEWS_WEB_RESEARCH_ENABLED.", 409, "feature_unavailable");
  }
  if (input.presentationMode === "presenter" && (!isNewsPresenterEnabled() || !isLikenessLiveValidated())) {
    throw new ApiRequestError("Presenter mode is unavailable until likeness consent and live provider validation are enabled.", 409, "feature_unavailable");
  }
  const now = new Date().toISOString();
  const profile = workflowProfileFor(input.contentType);
  const projectId = input.projectId;
  if (projectId) {
    const project = await store.getProject(projectId);
    if (!project || project.userId !== user.id) throw new Error("Project not found.");
  }
  if (input.sourceRecordIds.length > 0 && !projectId) throw new Error("projectId is required when attaching source records.");
  let hydratedSources = input.sourceRecordIds.length > 0
    ? await hydrateBundleFromRecords(input.sourceBundle, input.sourceRecordIds, user.id, projectId as string)
    : await hydrateSourceBundle(input.sourceBundle, now);
  const researchLead = hydratedSources.inputs.find((source) => source.kind === "url" && !source.extractedText?.trim());
  if (researchLead?.kind === "url" && (input.contentType !== "news_digest" || input.researchMode !== "corroborate")) {
    throw new ApiRequestError(
      `${researchLead.title ?? researchLead.url} could not be extracted directly. Enable web corroboration, paste the article text, upload a PDF, or remove this source.`,
      409,
      "source_requires_research",
    );
  }
  if (input.contentType === "news_digest" && input.researchMode === "corroborate") {
    if (!projectId) throw new Error("projectId is required for web corroboration.");
    hydratedSources = await corroborateNewsBundle({ bundle: hydratedSources, brief: input.brief, projectId, userId: user.id });
  }
  if (input.contentType === "news_digest" || input.contentType === "explainer") {
    hydratedSources = await extractIntelligentNewsClaims(hydratedSources, input.digestMode, input.contentType);
  }
  const job = await store.createJob(legacyVideoRequestForProduction(input), user, projectId);
  for (const sourceId of input.sourceRecordIds) {
    await store.updateProductionSource(sourceId, { productionId: job.id });
  }
  const basePatch = {
    prompt: input.brief,
    durationSeconds: input.targetDurationSeconds,
    aspectRatio: input.aspectRatio,
    contentType: input.contentType,
    qualityTier: input.qualityTier,
    workflowVersion: isHybridWorkflowV4Enabled() || input.contentType === "music_video"
      ? profile.id
      : input.contentType === "explainer" ? "explainer-v2" : input.contentType === "news_digest" ? "news-digest-v3" : profile.id,
    sourceBundle: hydratedSources,
    digestMode: input.digestMode,
    researchMode: input.researchMode,
    presentationMode: input.presentationMode,
    visualStylePreset: input.visualStylePreset,
    workflowSteps: initialWorkflowSteps(input.contentType),
  };

  if (input.contentType === "music_video") {
    return store.updateJob(job.id, basePatch);
  }

  let draft = buildSourceFirstDraft(job.id, { ...input, sourceBundle: hydratedSources }, now);
  let sourceBundle = input.contentType === "news_digest"
    ? await auditDifficultNewsClaims(await linkClaimEvidence(draft.sourceBundle))
    : await linkClaimEvidence(draft.sourceBundle);
  if (input.contentType === "news_digest" || input.contentType === "explainer") {
    const editorialOutline = await generateNewsEditorialOutline({ request: input, sourceBundle });
    if (editorialOutline) {
      draft = buildSourceFirstDraft(job.id, { ...input, sourceBundle }, now, editorialOutline);
      sourceBundle = await linkClaimEvidence(draft.sourceBundle);
      if (input.contentType === "news_digest") sourceBundle = await auditDifficultNewsClaims(sourceBundle);
    }
    sourceBundle = applyEditorialClaimSelection(sourceBundle, draft.editorialPlan.scenes.flatMap((scene) => scene.claimIds));
  }
  const linkedStoryboard = input.contentType === "news_digest" || input.contentType === "explainer"
    ? citationLinkedStoryboard(draft.storyboard, sourceBundle)
    : draft.storyboard;
  const plannedVisualsBase = isHybridVisualsV2Enabled()
    ? buildHybridVisualPlan({ productionId: job.id, request: input, storyboard: linkedStoryboard, createdAt: now, directionVersion: isEditorialTimingV2Enabled() ? 4 : isEditorialDirectionV3Enabled() ? 3 : 2 })
    : undefined;
  const plannedVisuals = plannedVisualsBase && isSourceVisualsV2Enabled()
    ? attachAuthenticSourceVisuals(plannedVisualsBase, sourceBundle)
    : plannedVisualsBase;
  const visualPlan = plannedVisuals
    ? applyValidatedLikenessRouting(plannedVisuals, isCinematicReenactmentsEnabled() && isLikenessVideoEnabled() && isLikenessLiveValidated())
    : undefined;
  const storyboard = attachVisualPlanToStoryboard(linkedStoryboard, visualPlan);
  const script = input.contentType === "news_digest" ? citedScript(draft.editorialPlan.scenes, sourceBundle) : draft.script;
  const qaReport = validateTimeline({ timeline: draft.timeline, sourceBundle, checkedAt: now });
  const recoveryBudgetCents = visualPlan && isHybridSafeRecoveryEnabled() ? Math.ceil(visualPlan.metrics.estimatedCostCents * 0.15) : 0;
  const scriptVersionId = randomUUID();
  const storyboardVersionId = randomUUID();
  const workflowSteps = markDraftSteps(basePatch.workflowSteps, input.contentType, qaReport.passed, now)
    .map((step) => step.id === "script"
      ? { ...step, artifactVersionId: scriptVersionId }
      : step.id === "storyboard"
        ? { ...step, artifactVersionId: storyboardVersionId }
        : step);
  return store.updateJob(job.id, {
    ...basePatch,
    sourceBundle,
    editorialPlan: draft.editorialPlan,
    storyboard,
    visualPlan,
    estimatedCostCents: visualPlan ? visualPlan.metrics.estimatedCostCents + 150 : job.estimatedCostCents,
    recoveryBudgetCents,
    recoverySpentCents: 0,
    timelineManifest: draft.timeline,
    script,
    qaReport,
    workflowSteps,
    approvals: [],
    artifactVersions: [
      ...job.artifactVersions,
      { id: scriptVersionId, scope: "script", label: "Cited script v1", payload: script, urls: {}, createdAt: now },
      { id: storyboardVersionId, scope: "storyboard", label: "Storyboard v1", payload: storyboard, urls: {}, createdAt: now },
    ],
    status: "awaiting_user",
    error: qaReport.passed ? undefined : "Draft requires QA corrections before narration or rendering.",
  });
}

export async function regenerateNewsEditorialDraft(job: VideoJob, user: UserContext) {
  if (job.status === "running" || job.cancellationRequested) throw new ApiRequestError("This production cannot be edited while running or after cancellation.", 409, "production_not_editable");
  if ((job.contentType !== "news_digest" && job.contentType !== "explainer") || job.userId !== user.id) throw new Error("Editorial production not found.");
  const store = getStore();
  const sources = (await store.listProductionSources(job.projectId)).filter((source) => source.productionId === job.id);
  if (sources.length === 0) throw new Error("Add at least one ready source before regenerating the editorial draft.");
  const now = new Date().toISOString();
  let sourceBundle = await hydrateBundleFromRecords({ inputs: [], claims: [] }, sources.map((source) => source.id), user.id, job.projectId);
  const request = ProductionCreateRequest.parse({
    contentType: job.contentType,
    projectId: job.projectId,
    brief: job.prompt,
    sourceBundle,
    sourceRecordIds: [],
    digestMode: job.digestMode ?? "auto",
    researchMode: "supplied_only",
    presentationMode: job.presentationMode ?? "faceless",
    visualStylePreset: job.visualStylePreset ?? "auto",
    targetDurationSeconds: job.durationSeconds,
    aspectRatio: job.aspectRatio,
    qualityTier: job.qualityTier ?? "standard",
  });
  sourceBundle = await extractIntelligentNewsClaims(sourceBundle, request.digestMode, job.contentType);
  let draft = buildSourceFirstDraft(job.id, { ...request, sourceBundle }, now);
  let linkedBundle = await linkClaimEvidence(draft.sourceBundle);
  if (job.contentType === "news_digest") linkedBundle = await auditDifficultNewsClaims(linkedBundle);
  const editorialOutline = await generateNewsEditorialOutline({ request, sourceBundle: linkedBundle });
  if (editorialOutline) {
    draft = buildSourceFirstDraft(job.id, { ...request, sourceBundle: linkedBundle }, now, editorialOutline);
    linkedBundle = await linkClaimEvidence(draft.sourceBundle);
    if (job.contentType === "news_digest") linkedBundle = await auditDifficultNewsClaims(linkedBundle);
  }
  linkedBundle = applyEditorialClaimSelection(linkedBundle, draft.editorialPlan.scenes.flatMap((scene) => scene.claimIds));
  const linkedStoryboard = citationLinkedStoryboard(draft.storyboard, linkedBundle);
  const visualPlanBase = isHybridVisualsV2Enabled()
    ? buildHybridVisualPlan({ productionId: job.id, request, storyboard: linkedStoryboard, createdAt: now, directionVersion: isEditorialTimingV2Enabled() ? 4 : isEditorialDirectionV3Enabled() ? 3 : 2 })
    : undefined;
  const visualPlan = visualPlanBase && isSourceVisualsV2Enabled() ? attachAuthenticSourceVisuals(visualPlanBase, linkedBundle) : visualPlanBase;
  const storyboard = attachVisualPlanToStoryboard(linkedStoryboard, visualPlan);
  const script = job.contentType === "news_digest" ? citedScript(draft.editorialPlan.scenes, linkedBundle) : draft.script;
  const qaReport = validateTimeline({ timeline: draft.timeline, sourceBundle: linkedBundle, checkedAt: now });
  const recoveryBudgetCents = visualPlan ? Math.ceil(visualPlan.metrics.estimatedCostCents * 0.15) : 0;
  const scriptVersionId = randomUUID();
  const storyboardVersionId = randomUUID();
  const workflowSteps = markDraftSteps(initialWorkflowSteps(job.contentType), job.contentType, qaReport.passed, now)
    .map((step) => step.id === "script" ? { ...step, artifactVersionId: scriptVersionId } : step.id === "storyboard" ? { ...step, artifactVersionId: storyboardVersionId } : step);
  return store.updateJob(job.id, {
    sourceBundle: linkedBundle,
    editorialPlan: draft.editorialPlan,
    storyboard,
    visualPlan,
    visualStylePreset: request.visualStylePreset,
    estimatedCostCents: visualPlan ? visualPlan.metrics.estimatedCostCents + 150 : job.estimatedCostCents,
    recoveryBudgetCents,
    recoverySpentCents: 0,
    script,
    timelineManifest: draft.timeline,
    qaReport,
    approvals: [],
    workflowSteps,
    artifactVersions: [
      ...job.artifactVersions,
      { id: scriptVersionId, scope: "script", label: `Cited script v${job.artifactVersions.filter((version) => version.scope === "script").length + 1}`, payload: script, urls: {}, createdAt: now },
      { id: storyboardVersionId, scope: "storyboard", label: `Storyboard v${job.artifactVersions.filter((version) => version.scope === "storyboard").length + 1}`, payload: storyboard, urls: {}, createdAt: now },
    ],
    status: "awaiting_user",
    error: qaReport.passed ? undefined : "Draft requires QA corrections before narration or rendering.",
  });
}

export async function fitProductionEditorialDraft(job: VideoJob, user: UserContext) {
  if (job.status === "running" || job.cancellationRequested) throw new ApiRequestError("This production cannot be edited while running or after cancellation.", 409, "production_not_editable");
  if ((job.contentType !== "news_digest" && job.contentType !== "explainer") || job.userId !== user.id) {
    throw new Error("Editorial production not found.");
  }
  if (!job.sourceBundle || !job.editorialPlan || !job.storyboard) {
    throw new Error("Create the sourced editorial draft before fitting its narration.");
  }
  const now = new Date().toISOString();
  const request = ProductionCreateRequest.parse({
    contentType: job.contentType,
    projectId: job.projectId,
    brief: job.prompt,
    sourceBundle: job.sourceBundle,
    sourceRecordIds: [],
    digestMode: job.digestMode ?? "auto",
    researchMode: job.researchMode ?? "supplied_only",
    presentationMode: job.presentationMode ?? "faceless",
    visualStylePreset: job.visualStylePreset ?? "auto",
    targetDurationSeconds: job.durationSeconds,
    aspectRatio: job.aspectRatio,
    qualityTier: job.qualityTier ?? "standard",
  });

  const fittedOutline = await fitNewsEditorialOutline({ request, sourceBundle: job.sourceBundle, currentOutline: job.editorialPlan.scenes });
  const fittedBudget = narrationBudgetSummary(fittedOutline.map((scene) => scene.narration).join(" "), job.durationSeconds);
  if (fittedBudget.predictedCoverage < 0.75 || !fittedBudget.withinBudget) {
    throw new ApiRequestError(`The current script predicts ${Math.round(fittedBudget.predictedDurationMs / 1_000)} seconds of narration for a ${job.durationSeconds}-second target. Edit the script or adjust its duration before approval.`, 422, "narration_outside_budget");
  }

  const draft = buildSourceFirstDraft(job.id, { ...request, sourceBundle: job.sourceBundle }, now, fittedOutline);
  const sourceBundle = applyEditorialClaimSelection(await linkClaimEvidence(draft.sourceBundle), fittedOutline.flatMap((scene) => scene.claimIds));
  const linkedStoryboard = citationLinkedStoryboard(draft.storyboard, sourceBundle);
  const visualPlanBase = isHybridVisualsV2Enabled()
    ? buildHybridVisualPlan({ productionId: job.id, request, storyboard: linkedStoryboard, createdAt: now, directionVersion: isEditorialTimingV2Enabled() ? 4 : isEditorialDirectionV3Enabled() ? 3 : 2 })
    : undefined;
  const sourcedVisualPlan = visualPlanBase && isSourceVisualsV2Enabled()
    ? attachAuthenticSourceVisuals(visualPlanBase, sourceBundle)
    : visualPlanBase;
  const visualPlan = sourcedVisualPlan
    ? applyValidatedLikenessRouting(sourcedVisualPlan, isCinematicReenactmentsEnabled() && isLikenessVideoEnabled() && isLikenessLiveValidated())
    : undefined;
  const storyboard = attachVisualPlanToStoryboard(linkedStoryboard, visualPlan);
  const script = job.contentType === "news_digest" ? citedScript(fittedOutline, sourceBundle) : draft.script;
  const qaReport = validateTimeline({ timeline: draft.timeline, sourceBundle, checkedAt: now });
  const scriptVersionId = randomUUID();
  const storyboardVersionId = randomUUID();
  const workflowSteps = markDraftSteps(initialWorkflowSteps(job.contentType), job.contentType, qaReport.passed, now)
    .map((step) => step.id === "script"
      ? { ...step, artifactVersionId: scriptVersionId }
      : step.id === "storyboard"
        ? { ...step, artifactVersionId: storyboardVersionId }
        : step);
  const recoveryBudgetCents = visualPlan && isHybridSafeRecoveryEnabled() ? Math.ceil(visualPlan.metrics.estimatedCostCents * 0.15) : 0;

  return getStore().updateJob(job.id, {
    sourceBundle,
    editorialPlan: draft.editorialPlan,
    storyboard,
    visualPlan,
    script,
    timelineManifest: draft.timeline,
    qaReport,
    approvals: [],
    workflowSteps,
    estimatedCostCents: visualPlan ? visualPlan.metrics.estimatedCostCents + 150 : job.estimatedCostCents,
    recoveryBudgetCents,
    recoverySpentCents: 0,
    artifactVersions: [
      ...job.artifactVersions,
      { id: scriptVersionId, scope: "script", label: `Cited script v${job.artifactVersions.filter((version) => version.scope === "script").length + 1}`, payload: script, urls: {}, createdAt: now },
      { id: storyboardVersionId, scope: "storyboard", label: `Storyboard v${job.artifactVersions.filter((version) => version.scope === "storyboard").length + 1}`, payload: storyboard, urls: {}, createdAt: now },
    ],
    status: "awaiting_user",
    error: undefined,
  });
}

async function linkClaimEvidence(sourceBundle: SourceBundle): Promise<SourceBundle> {
  const store = getStore();
  const recordIds = [...new Set(sourceBundle.inputs.flatMap((source) => source.sourceRecordId ? [source.sourceRecordId] : []))];
  const records = new Map<string, { url?: string; canonicalUrl?: string; sha256?: string; fragments: SourceFragment[] }>();
  for (const sourceId of recordIds) {
    const [source, fragments] = await Promise.all([store.getProductionSource(sourceId), store.listSourceFragments(sourceId)]);
    if (source) records.set(sourceId, { url: source.url, canonicalUrl: source.canonicalUrl, sha256: source.sha256, fragments });
  }
  return {
    ...sourceBundle,
    claims: sourceBundle.claims.map((claim) => {
      const evidenceRefs = claim.sourceIds.flatMap((sourceId) => {
        const record = records.get(sourceId);
        if (!record) {
          const source = sourceBundle.inputs.find((source) => source.id === sourceId);
          const text = source?.kind === "text" ? source.text : source?.extractedText ?? "";
          return claim.evidenceRefs.filter((evidence) => evidence.sourceId === sourceId).flatMap((evidence) => {
            const excerpt = exactEvidenceSpan(text, evidence.excerpt);
            return excerpt ? [{ ...evidence, excerpt, excerptHash: createHash("sha256").update(excerpt).digest("hex"), sourceUrl: source?.kind === "url" ? source.canonicalUrl ?? source.url : evidence.sourceUrl }] : [];
          });
        }
        const previous = claim.evidenceRefs.find((evidence) => evidence.sourceId === sourceId);
        const fragment = (previous && record.fragments.find((fragment) => exactEvidenceSpan(fragment.text, previous.excerpt)))
          ?? bestEvidenceFragment(claim.text, record.fragments);
        if (!fragment) return [];
        const excerpt = (previous && exactEvidenceSpan(fragment.text, previous.excerpt))
          || exactEvidenceSpan(fragment.text, claim.text)
          || bestEvidenceSentence(claim.text, fragment.text);
        if (!excerpt) return [];
        return [{
          sourceId,
          fragmentId: fragment.id,
          pageNumber: fragment.pageNumber,
          section: fragment.section,
          sourceUrl: record.canonicalUrl ?? record.url,
          excerpt,
          excerptHash: createHash("sha256").update(excerpt).digest("hex"),
          extractionMethod: fragment.extractionMethod,
        }];
      });
      const independenceGroups = [...new Set(claim.sourceIds.map((sourceId) => {
        const record = records.get(sourceId);
        return record?.canonicalUrl ? new URL(record.canonicalUrl).hostname : record?.sha256 ?? sourceId;
      }))];
      const breaking = isExplicitBreakingClaim(claim.text);
      const supported = evidenceRefs.length > 0 && (!breaking || independenceGroups.length >= 2);
      return {
        ...claim,
        evidenceRefs,
        evidence: evidenceRefs.map((evidence) => evidence.excerpt),
        independenceGroup: independenceGroups.join("|"),
        breaking,
        confidence: supported ? Math.max(claim.confidence, 0.82) : Math.min(claim.confidence, 0.55),
        status: supported ? "supported" as const : breaking && evidenceRefs.length > 0 ? "contested" as const : "unverified" as const,
      };
    }),
  };
}

function bestEvidenceFragment(claim: string, fragments: SourceFragment[]) {
  const words = new Set(claim.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);
  return [...fragments].filter((fragment) => scoreFragment(fragment.text, words) > 0).sort((left, right) => scoreFragment(right.text, words) - scoreFragment(left.text, words))[0];
}

function exactEvidenceSpan(text: string, excerpt: string) {
  if (!excerpt.trim()) return undefined;
  const pattern = excerpt.trim().split(/\s+/).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
  return new RegExp(pattern, "i").exec(text)?.[0].slice(0, 1_000);
}

function bestEvidenceSentence(claim: string, text: string) {
  const words = new Set(claim.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);
  return text.split(/(?<=[.!?])\s+|\n+/).filter((sentence) => sentence.trim().length > 20)
    .sort((left, right) => scoreFragment(right, words) - scoreFragment(left, words))[0]?.trim().slice(0, 1_000);
}

function scoreFragment(text: string, words: Set<string>) {
  const haystack = text.toLowerCase();
  let score = 0;
  for (const word of words) if (haystack.includes(word)) score += 1;
  return score;
}

function citationLinkedStoryboard(storyboard: NonNullable<VideoJob["storyboard"]>, sourceBundle: SourceBundle) {
  const titles = new Map(sourceBundle.inputs.map((source) => [source.id, source.title ?? (source.kind === "url" ? new URL(source.url).hostname : "Supplied source")]));
  const claims = new Map(sourceBundle.claims.map((claim) => [claim.id, claim]));
  return {
    ...storyboard,
    scenes: storyboard.scenes.map((scene) => {
      const labels = scene.claimIds.flatMap((claimId) => claims.get(claimId)?.evidenceRefs ?? []).map((evidence) => {
        const label = titles.get(evidence.sourceId) ?? "Source";
        return evidence.pageNumber ? `${label}, p. ${evidence.pageNumber}` : evidence.section ? `${label} · ${evidence.section}` : label;
      });
      return { ...scene, citationLabels: [...new Set(labels)].slice(0, 4).map((label) => label.slice(0, 160)) };
    }),
  };
}

function citedScript(scenes: NonNullable<VideoJob["editorialPlan"]>["scenes"], sourceBundle: SourceBundle) {
  const activeClaims = new Map(sourceBundle.claims.filter((claim) => claim.editorialStatus !== "excluded").map((claim) => [claim.id, claim]));
  return scenes.map((scene) => {
    const markers = scene.claimIds.filter((claimId) => activeClaims.has(claimId)).map((claimId) => `[claim:${claimId}]`).join(" ");
    return `${scene.title}\n${scene.narration}${markers ? ` ${markers}` : ""}`;
  }).join("\n\n");
}

function applyEditorialClaimSelection(sourceBundle: SourceBundle, narratedClaimIds: string[]) {
  const narrated = new Set(narratedClaimIds);
  return {
    ...sourceBundle,
    claims: sourceBundle.claims.map((claim) => ({
      ...claim,
      editorialStatus: narrated.has(claim.id) ? "draft" as const : "excluded" as const,
    })),
  } satisfies SourceBundle;
}

function markDraftSteps(
  steps: WorkflowStep[],
  contentType: ProductionCreateRequest["contentType"],
  qaPassed: boolean,
  completedAt: string,
) {
  const complete = new Set(["intake", "source_processing", "editorial", "script"]);
  if (contentType === "news_digest") complete.add("research");
  const reviewGate = contentType === "explainer" || contentType === "news_digest" ? "script_approval" : "plan_review";
  return steps.map((step): WorkflowStep => {
    if (step.id === reviewGate) {
      return {
        ...step,
        state: "awaiting_user",
        error: qaPassed ? undefined : "One or more blocking source or factual QA findings require review.",
      };
    }
    if (!complete.has(step.id)) return step;
    return { ...step, state: "complete", completedAt };
  });
}
