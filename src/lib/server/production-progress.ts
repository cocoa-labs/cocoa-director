import {
  ProductionProgressSnapshot,
  type MediaGeneration,
  type ProductionProgressSnapshot as ProductionProgressSnapshotType,
  type ProductionStageProgress,
  type VideoJob,
  type WorkflowStep,
  type WorkUnitProgress,
} from "@/lib/schemas";
import { getStore } from "@/lib/server/store";

const ACTIVE_SECONDS = 90;
const STALLED_SECONDS = 300;

const EDITORIAL_STAGES = [
  { id: "sources", label: "Sources", steps: ["intake", "source_processing"] },
  { id: "editorial", label: "Editorial", steps: ["research", "editorial"] },
  { id: "script_review", label: "Script review", steps: ["script", "script_approval"] },
  { id: "storyboard_review", label: "Storyboard review", steps: ["storyboard", "storyboard_approval"] },
  { id: "narration", label: "Narration and timing", steps: ["narration", "timing_reconciliation"] },
  { id: "visuals", label: "Visuals and score", steps: ["imagery", "generation", "score"] },
  { id: "visual_rough_cut_qa", label: "Audiovisual rough-cut QA", steps: ["visual_rough_cut_qa"] },
  { id: "timeline", label: "Timeline", steps: ["timeline"] },
  { id: "preflight_qa", label: "Preflight QA", steps: ["preflight_qa", "qa"] },
  { id: "render", label: "Render", steps: ["render"] },
  { id: "final_validation", label: "Final validation", steps: ["final_qa", "review"] },
] as const;

export async function getProductionProgress(productionId: string) {
  const store = getStore();
  const job = await store.getJob(productionId);
  if (!job) throw new Error("Production not found.");
  const [media, runs] = await Promise.all([
    store.listJobMedia(productionId),
    store.listProductionWorkflowRuns(productionId),
  ]);
  return buildProductionProgress(job, media.generations, runs);
}

export function buildProductionProgress(
  job: VideoJob,
  generations: MediaGeneration[],
  runs: Awaited<ReturnType<ReturnType<typeof getStore>["listProductionWorkflowRuns"]>> = [],
) {
  const latestGenerations = latestGenerationByUnit(generations);
  const units = [...latestGenerations.values()].map((generation) => workUnitFromGeneration(generation));
  const existingUnitIds = new Set(units.map((unit) => unit.id));
  units.push(...narrationUnits(job).filter((unit) => !existingUnitIds.has(unit.id)));

  const lastActivityAt = latestIso([
    job.updatedAt,
    ...generations.map((generation) => stringMetadata(generation.metadata.heartbeatAt) ?? generation.updatedAt),
    ...runs.map((run) => run.heartbeatAt),
    ...job.providerCalls.map((call) => call.createdAt),
  ]);
  const ageSeconds = Math.max(0, (Date.now() - Date.parse(lastActivityAt)) / 1_000);
  const policyFailures = units.filter((unit) => unit.state === "needs_attention");
  const stages = EDITORIAL_STAGES.map((definition) => stageProgress(job, definition, units));
  const terminalState = terminalSnapshotState(job);
  const state = terminalState
    ?? (policyFailures.length > 0 ? "needs_attention"
      : job.status === "awaiting_user" ? "awaiting_user"
        : ageSeconds >= STALLED_SECONDS && job.status === "running" ? "possibly_stalled"
          : job.status === "running" ? "active" : "queued");
  const activeStage = stages.find((stage) => ["running", "awaiting_user", "needs_attention", "failed"].includes(stage.state))
    ?? stages.find((stage) => stage.state !== "complete");
  const recoverable = policyFailures.length > 0 || state === "possibly_stalled";
  const nextAction = nextActionFor(job, state, recoverable);
  const remainingRecoveryCents = Math.max(0, job.recoveryBudgetCents - job.recoverySpentCents);

  return ProductionProgressSnapshot.parse({
    productionId: job.id,
    workflowVersion: job.workflowVersion ?? "music-video-v1",
    state,
    activeStageId: activeStage?.id,
    activeStageLabel: activeStage?.label,
    activeDetail: activeStage?.detail,
    lastActivityAt,
    staleAfterSeconds: state === "active" ? ACTIVE_SECONDS : STALLED_SECONDS,
    stages,
    units,
    costs: {
      estimatedBaseCents: job.estimatedCostCents,
      recoveryReserveCents: job.recoveryBudgetCents,
      maximumAuthorizedCents: job.estimatedCostCents + job.recoveryBudgetCents,
      actualCents: job.actualCostCents,
      recoverySpentCents: job.recoverySpentCents,
      remainingRecoveryCents,
    },
    recoverable,
    nextAction,
    artifactVersionCount: job.artifactVersions.length,
    visualQuality: visualQualityProgress(job, generations),
    updatedAt: new Date().toISOString(),
  });
}

function visualQualityProgress(job: VideoJob, generations: MediaGeneration[]) {
  const report = job.visualPlan?.qualityReport;
  const step = job.workflowSteps?.find((candidate) => candidate.id === "visual_rough_cut_qa");
  const collisionGroups = generationCollisionGroups(job, generations);
  if (!report && !step && collisionGroups.length === 0) return undefined;
  const currentVisualGenerations = latestVisualGenerationByUnit(generations);
  const collidedGenerationIds = new Set(collisionGroups.flat());
  const state = collisionGroups.length > 0 ? "failed" as const
    : report?.state === "passed" ? "passed" as const
    : report?.state === "needs_review" ? "needs_review" as const
      : report?.state === "failed" ? "failed" as const
        : step?.state === "running" ? "running" as const : "not_started" as const;
  return {
    state,
    retainedAssetCount: report?.retainedBeatIds.length
      ?? currentVisualGenerations.filter((generation) => generation.status === "success" && !collidedGenerationIds.has(generation.id)).length,
    rejectedAssetCount: report?.rejectedBeatIds.length ?? collisionGroups.flat().length,
    rejectedBeatIds: report?.rejectedBeatIds ?? [...new Set(collisionGroups.flatMap((group) => group.map((generationId) => stringMetadata(generations.find((generation) => generation.id === generationId)?.controls.visualBeatId)).filter((value): value is string => Boolean(value))))],
    autoPolishAttempts: report?.autoPolishAttempts ?? 0,
    uniqueAssetRatio: report?.uniqueAssetRatio,
    cinematicCoverage: report?.cinematicCoverage,
    semanticScore: report?.semanticScore,
    spokenCoverage: report?.narrationCoverage?.spokenCoverage,
    longestUnapprovedGapMs: report?.narrationCoverage?.longestUnapprovedGapMs,
    maximumInformationStasisMs: report?.motionEnergy?.maximumInformationStasisMs,
    authenticSourceVisualCount: report?.sourceVisuals?.authenticArtifactCount,
    unsupportedGraphicCount: report?.sourceVisuals?.unsupportedGraphicBeatIds.length,
    duplicateGroupCount: Math.max(report?.duplicateGroups.length ?? 0, collisionGroups.length),
    findings: report?.findings ?? collisionGroups.map((group) => ({
      code: "visual.exact_asset_reuse",
      severity: "blocking" as const,
      message: `${group.length} generated beats resolve to the same output asset.`,
      beatIds: group.map((generationId) => stringMetadata(generations.find((generation) => generation.id === generationId)?.controls.visualBeatId)).filter((value): value is string => Boolean(value)),
    })),
    nextAction: state === "running" ? "wait" as const
      : state === "failed" || state === "needs_review" ? (report?.autoPolishAttempts ?? 0) < 1 ? "auto_polish" as const : "review_flagged_beats" as const
        : "continue" as const,
  };
}

function latestVisualGenerationByUnit(generations: MediaGeneration[]) {
  const latest = new Map<string, MediaGeneration>();
  for (const generation of [...generations].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))) {
    if (generation.kind !== "image" && generation.kind !== "video") continue;
    const beatId = stringMetadata(generation.controls.visualBeatId);
    if (!beatId) continue;
    const unitId = `${generation.kind}:${beatId}`;
    if (!latest.has(unitId)) latest.set(unitId, generation);
  }
  return [...latest.values()];
}

function generationCollisionGroups(job: VideoJob, generations: MediaGeneration[]) {
  const expectedKindByBeatId = new Map<string, MediaGeneration["kind"]>();
  for (const beat of job.visualPlan?.beats ?? []) {
    if (["cinematic_broll", "synthetic_reenactment", "composite"].includes(beat.kind)) expectedKindByBeatId.set(beat.id, "video");
    else if (beat.kind === "editorial_image") expectedKindByBeatId.set(beat.id, "image");
  }
  const latest = new Map<string, MediaGeneration>();
  for (const generation of [...generations].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))) {
    const beatId = stringMetadata(generation.controls.visualBeatId);
    const expectedKind = beatId ? expectedKindByBeatId.get(beatId) : undefined;
    if (!beatId || (expectedKindByBeatId.size > 0 && expectedKind !== generation.kind)) continue;
    const unit = `${generation.kind}:${beatId}`;
    if (!latest.has(unit)) latest.set(unit, generation);
  }
  const groups = new Map<string, string[]>();
  for (const generation of [...latest.values()].filter((candidate) => candidate.status === "success")) {
    const url = Object.values(generation.outputUrls)[0];
    if (!url) continue;
    const key = `${generation.kind}:${url}`;
    groups.set(key, [...(groups.get(key) ?? []), generation.id]);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

function latestGenerationByUnit(generations: MediaGeneration[]) {
  const latest = new Map<string, MediaGeneration>();
  for (const generation of [...generations].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))) {
    const beatId = stringMetadata(generation.controls.visualBeatId);
    const narrationSceneId = stringMetadata(generation.controls.narrationSceneId);
    const unit = narrationSceneId ? `narration:${narrationSceneId}` : beatId ? `${generation.kind}:${beatId}` : generation.kind === "music" ? "music:editorial-score" : `${generation.kind}:${generation.id}`;
    if (!latest.has(unit)) latest.set(unit, generation);
  }
  return latest;
}

function workUnitFromGeneration(generation: MediaGeneration): WorkUnitProgress {
  const beatId = stringMetadata(generation.controls.visualBeatId);
  const narrationSceneId = stringMetadata(generation.controls.narrationSceneId);
  const errorCode = stringMetadata(generation.metadata.errorCode)
    ?? objectStringMetadata(generation.metadata.providerError, "code")
    ?? (generation.provider === "fal" && /likeness|private information|real[- ]?person|privacy|identity/i.test(generation.error ?? "") ? "fal_likeness_policy" : undefined);
  const state = generation.status === "success" ? "ready"
    : generation.status === "queued" ? "queued"
      : generation.status === "running" ? "running"
        : generation.status === "failed" && errorCode === "fal_likeness_policy" ? "needs_attention"
          : generation.status === "failed" ? "failed" : "not_started";
  return {
    id: narrationSceneId ? `narration:${narrationSceneId}` : beatId ? `${generation.kind}:${beatId}` : generation.id,
    stageId: narrationSceneId ? "narration" : "visuals",
    label: narrationSceneId ? `Narration · ${narrationSceneId}` : beatId ? `${generation.kind === "video" ? "Cinematic clip" : "Editorial image"} · ${beatId}` : generation.kind === "music" ? "Editorial score" : generation.kind,
    kind: narrationSceneId ? "speech" : generation.kind,
    state,
    provider: generation.provider,
    model: generation.model,
    requestId: generation.requestId,
    attempt: numberMetadata(generation.metadata.attempt) ?? 1,
    errorCode,
    error: generation.error,
    assetUrl: Object.values(generation.outputUrls)[0],
    updatedAt: normalizeIso(stringMetadata(generation.metadata.heartbeatAt) ?? generation.updatedAt),
  };
}

function narrationUnits(job: VideoJob): WorkUnitProgress[] {
  const byKey = new Map<string, VideoJob["providerCalls"][number]>();
  for (const call of job.providerCalls.filter((candidate) => candidate.idempotencyKey.includes(":narration:"))) {
    byKey.set(call.idempotencyKey, call);
  }
  const scenes = job.storyboard?.scenes ?? [];
  if (scenes.length === 0) return [...byKey.values()].map((call) => narrationUnitFromCall(call));
  const narrationSegments = job.timelineManifest?.tracks.find((track) => track.kind === "narration")?.segments ?? [];
  return scenes.map((scene, index): WorkUnitProgress => {
    const call = [...byKey.values()].find((candidate) => candidate.idempotencyKey.endsWith(`:${index + 1}`));
    const segment = narrationSegments.find((candidate) => candidate.metadata.sceneId === scene.id && candidate.sourceUrl);
    if (call) return narrationUnitFromCall(call, scene.id);
    return {
      id: `narration:${scene.id}`,
      stageId: "narration",
      label: `Narration · scene ${index + 1}`,
      kind: "speech",
      state: segment ? "ready" : "not_started",
      provider: segment ? "elevenlabs" : undefined,
      attempt: 1,
      assetUrl: segment?.sourceUrl,
      updatedAt: segment ? normalizeIso(job.updatedAt) : undefined,
    };
  });
}

function narrationUnitFromCall(call: VideoJob["providerCalls"][number], sceneId?: string): WorkUnitProgress {
  return {
    id: sceneId ? `narration:${sceneId}` : call.idempotencyKey,
    stageId: "narration",
    label: `Narration · ${call.idempotencyKey.split(":").at(-1) ?? "scene"}`,
    kind: "speech",
    state: call.status === "success" ? "ready" : call.status === "failed" ? "failed" : call.status === "running" ? "running" : "queued",
    provider: call.provider,
    model: call.model,
    requestId: call.requestId,
    attempt: 1,
    error: call.error,
    updatedAt: normalizeIso(call.createdAt),
  };
}

function stageProgress(
  job: VideoJob,
  definition: typeof EDITORIAL_STAGES[number],
  units: WorkUnitProgress[],
): ProductionStageProgress {
  const steps = definition.steps.flatMap((id) => job.workflowSteps?.filter((step) => step.id === id) ?? []);
  const stageUnits = units.filter((unit) => unit.stageId === definition.id);
  const failed = stageUnits.filter((unit) => unit.state === "failed" || unit.state === "needs_attention").length;
  const running = stageUnits.filter((unit) => unit.state === "running").length;
  const queued = stageUnits.filter((unit) => unit.state === "queued").length;
  const ready = stageUnits.filter((unit) => unit.state === "ready").length;
  const stepState = aggregateStepState(steps);
  const state = failed > 0 ? "needs_attention" as const
    : running > 0 || queued > 0 ? "running" as const
      : stageUnits.length > 0 && ready === stageUnits.length ? "complete" as const
        : stageUnits.length > 0 ? "not_started" as const : stepState;
  const completedAt = state === "complete"
    ? latestIsoOptional(steps.flatMap((step) => step.completedAt ? [step.completedAt] : []))
    : undefined;
  return {
    id: definition.id,
    label: definition.label,
    state,
    detail: stageDetail(definition.id, stageUnits, steps),
    total: stageUnits.length || steps.length,
    ready: stageUnits.length ? ready : steps.filter((step) => step.state === "complete").length,
    queued,
    running,
    failed,
    startedAt: latestIsoOptional(steps.flatMap((step) => step.startedAt ? [step.startedAt] : [])),
    completedAt,
  };
}

function aggregateStepState(steps: WorkflowStep[]): ProductionStageProgress["state"] {
  if (steps.some((step) => step.state === "failed")) return "failed";
  if (steps.some((step) => step.state === "awaiting_user")) return "awaiting_user";
  if (steps.some((step) => step.state === "running")) return "running";
  if (steps.length > 0 && steps.every((step) => step.state === "complete")) return "complete";
  return "not_started";
}

function stageDetail(stageId: string, units: WorkUnitProgress[], steps: WorkflowStep[]) {
  if (units.length > 0) {
    const ready = units.filter((unit) => unit.state === "ready").length;
    const failed = units.filter((unit) => unit.state === "failed" || unit.state === "needs_attention").length;
    return `${ready}/${units.length} ready${failed > 0 ? ` · ${failed} need attention` : ""}`;
  }
  const active = steps.find((step) => step.state === "running" || step.state === "awaiting_user" || step.state === "failed");
  return active?.error ?? active?.name ?? (stageId === "final_validation" ? "Final audiovisual validation and delivery" : undefined);
}

function terminalSnapshotState(job: VideoJob) {
  if (job.status === "complete") return "complete" as const;
  if (job.status === "failed") return "failed" as const;
  if (job.status === "cancelled") return "cancelled" as const;
  return undefined;
}

function nextActionFor(job: VideoJob, state: ProductionProgressSnapshotType["state"], recoverable: boolean) {
  if (state === "complete" || state === "cancelled") return "none" as const;
  if (recoverable) return "resume_safe_recovery" as const;
  if (job.workflowSteps?.some((step) => step.id === "script_approval" && step.state === "awaiting_user")) return "approve_script" as const;
  if (job.workflowSteps?.some((step) => step.id === "storyboard_approval" && step.state === "awaiting_user")) return "approve_storyboard" as const;
  if (state === "failed") return "review_failure" as const;
  return "wait" as const;
}

function latestIso(values: string[]) {
  const latest = values.reduce((maximum, value) => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? Math.max(maximum, parsed) : maximum;
  }, 0);
  return new Date(latest).toISOString();
}

function latestIsoOptional(values: string[]) {
  return values.length > 0 ? latestIso(values) : undefined;
}

function normalizeIso(value: string) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value;
}

function stringMetadata(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberMetadata(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.floor(value)) : undefined;
}

function objectStringMetadata(value: unknown, key: string) {
  return value && typeof value === "object" && key in value ? stringMetadata((value as Record<string, unknown>)[key]) : undefined;
}
