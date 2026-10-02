import { randomUUID } from "node:crypto";

import type { GraphicFamily, HybridVisualPlanV2, MediaGeneration } from "@/lib/schemas";
import type { HybridAssetState } from "@/lib/server/hybrid-assets";
import { attachVisualPlanToStoryboard, buildHybridVisualPlan } from "@/lib/hybrid-visuals";
import { copyRemoteFileToBlob } from "@/lib/server/blob";
import { isHybridSafeRecoveryEnabled } from "@/lib/server/config";
import { probeMediaUrl } from "@/lib/server/media-probe";
import { editorialStepsFor } from "@/lib/server/production-runtime";
import { getStore } from "@/lib/server/store";

export type RecoveryAuthorization = {
  authorized: Array<{ beatId: string; generationId?: string; attempt: number }>;
  requiredCents: number;
  paused: boolean;
  reason?: string;
};

const GRAPHIC_FAMILIES: GraphicFamily[] = [
  "hero_number",
  "magnitude_comparison",
  "change_over_time",
  "ranking",
  "part_to_whole",
  "geographic_map",
  "timeline",
  "process_flow",
  "relationship_network",
  "source_excerpt",
];
const QUANTITATIVE_GRAPHIC_FAMILIES = new Set<GraphicFamily>([
  "hero_number",
  "magnitude_comparison",
  "change_over_time",
  "ranking",
  "part_to_whole",
]);

export function rebalanceGraphicFamilies(plan: HybridVisualPlanV2, requestedBeatIds: string[]) {
  if (plan.version >= 4) return plan;
  const requested = new Set(requestedBeatIds);
  const beats = plan.beats.map((beat) => ({ ...beat, graphicSpec: beat.graphicSpec && !("version" in beat.graphicSpec) ? { ...beat.graphicSpec } : undefined }));
  const graphicBeats = beats.filter((beat) => beat.graphicSpec && !("version" in beat.graphicSpec));
  if (graphicBeats.length < 4) return { ...plan, beats };
  const maximumPerFamily = Math.max(1, Math.floor(graphicBeats.length * 0.25));
  const counts = new Map<GraphicFamily, number>(GRAPHIC_FAMILIES.map((family) => [family, 0]));
  for (const beat of graphicBeats) counts.set(beat.graphicSpec!.family, (counts.get(beat.graphicSpec!.family) ?? 0) + 1);

  const replaceFamily = (beat: typeof graphicBeats[number]) => {
    const current = beat.graphicSpec!.family;
    const index = beats.findIndex((candidate) => candidate.id === beat.id);
    const neighborFamilies = new Set([
      beats[index - 1]?.graphicSpec?.family,
      beats[index + 1]?.graphicSpec?.family,
    ].filter((family): family is GraphicFamily => Boolean(family)));
    const candidates = GRAPHIC_FAMILIES
      .filter((family) => family !== current)
      .filter((family) => beat.graphicSpec!.values.length > 0 || !QUANTITATIVE_GRAPHIC_FAMILIES.has(family))
      .filter((family) => (counts.get(family) ?? 0) < maximumPerFamily)
      .sort((left, right) => {
        const neighborDifference = Number(neighborFamilies.has(left)) - Number(neighborFamilies.has(right));
        return neighborDifference || (counts.get(left) ?? 0) - (counts.get(right) ?? 0) || GRAPHIC_FAMILIES.indexOf(left) - GRAPHIC_FAMILIES.indexOf(right);
      });
    const replacement = candidates[0];
    if (!replacement) return false;
    beat.graphicSpec = { ...beat.graphicSpec!, family: replacement };
    counts.set(current, Math.max(0, (counts.get(current) ?? 0) - 1));
    counts.set(replacement, (counts.get(replacement) ?? 0) + 1);
    return true;
  };

  for (const family of GRAPHIC_FAMILIES) {
    let overflow = Math.max(0, (counts.get(family) ?? 0) - maximumPerFamily);
    const candidates = graphicBeats.filter((beat) => beat.graphicSpec?.family === family && requested.has(beat.id)).reverse();
    for (const beat of candidates) {
      if (overflow <= 0) break;
      if (replaceFamily(beat)) overflow -= 1;
    }
  }
  for (let index = 1; index < beats.length; index += 1) {
    const previous = beats[index - 1];
    const current = beats[index];
    if (previous.sceneId === current.sceneId || !current.graphicSpec || previous.graphicSpec?.family !== current.graphicSpec.family || !requested.has(current.id)) continue;
    replaceFamily(current as typeof graphicBeats[number]);
  }
  return { ...plan, beats };
}

export function strengthenSemanticRecoveryDirections(plan: HybridVisualPlanV2, requestedBeatIds: string[]) {
  const requested = new Set(requestedBeatIds);
  const semanticFindings = new Set(
    plan.qualityReport?.findings
      .filter((finding) => finding.code === "visual.semantic_mismatch")
      .flatMap((finding) => finding.beatIds) ?? [],
  );
  return {
    ...plan,
    beats: plan.beats.map((beat) => {
      if (!requested.has(beat.id) || !semanticFindings.has(beat.id)) return beat;
      const direction = [
        `APPROVED SUBJECT: ${beat.shotSpec?.subject ?? beat.intent}.`,
        `SUPPORTED SETTING: ${beat.shotSpec?.setting ?? beat.intent}.`,
        `SUPPORTED ACTION OR MECHANISM: ${beat.shotSpec?.action ?? beat.intent}.`,
        `NARRATIVE FUNCTION: ${beat.shotSpec?.narrativeFunction ?? beat.intent}.`,
        "Retain these exact scene-specific objects, environment, mechanism, and consequence. Do not replace them with a generic AI, network, office, data-center, or abstract-technology image.",
        beat.generationPrompt ?? beat.intent,
      ].join(" ").slice(0, 2_000);
      return { ...beat, generationPrompt: direction };
    }),
  };
}

export async function authorizeVisualAutopolish(productionId: string, beatIds: string[]) {
  const store = getStore();
  const job = await store.getJob(productionId);
  if (!job?.visualPlan) throw new Error("Hybrid production not found.");
  const uniqueBeatIds = [...new Set(beatIds)].filter((beatId) => job.visualPlan?.beats.some((beat) => beat.id === beatId));
  const requiredCents = uniqueBeatIds.reduce((sum, beatId) => sum + (job.visualPlan?.beats.find((beat) => beat.id === beatId)?.costEstimateCents ?? 0), 0);
  const remainingCents = Math.max(0, job.recoveryBudgetCents - job.recoverySpentCents);
  if (requiredCents > remainingCents) return { authorized: false, requiredCents, remainingCents, beatIds: uniqueBeatIds };
  const now = new Date().toISOString();
  const rebalancedPlan = strengthenSemanticRecoveryDirections(
    rebalanceGraphicFamilies(job.visualPlan, uniqueBeatIds),
    uniqueBeatIds,
  );
  const visualPlan = {
    ...rebalancedPlan,
    qualityReport: job.visualPlan.qualityReport ? {
      ...job.visualPlan.qualityReport,
      autoPolishAttempts: job.visualPlan.qualityReport.autoPolishAttempts + 1,
    } : undefined,
  };
  await store.updateJob(productionId, {
    recoverySpentCents: job.recoverySpentCents + requiredCents,
    visualPlan,
    storyboard: job.storyboard ? attachVisualPlanToStoryboard(job.storyboard, visualPlan) : undefined,
    artifactVersions: [...job.artifactVersions, {
      id: randomUUID(),
      scope: "recovery",
      label: `Visual auto-polish · ${uniqueBeatIds.length} beat${uniqueBeatIds.length === 1 ? "" : "s"}`,
      targetId: uniqueBeatIds.join(","),
      payload: { policy: "visual_rough_cut_autopolish", beatIds: uniqueBeatIds, requiredCents },
      urls: {},
      createdAt: now,
    }],
  });
  return { authorized: true, requiredCents, remainingCents: remainingCents - requiredCents, beatIds: uniqueBeatIds };
}

export async function authorizeManualVisualQualityRecovery(
  productionId: string,
  requestedBeatIds: string[],
  confirmSpend: boolean,
): Promise<RecoveryAuthorization> {
  const store = getStore();
  const job = await store.getJob(productionId);
  const report = job?.visualPlan?.qualityReport;
  if (!job?.visualPlan || !report || (report.state !== "failed" && report.state !== "needs_review")) {
    return { authorized: [], requiredCents: 0, paused: true, reason: "Visual rough-cut QA has not identified any beats that require recovery." };
  }
  const rejectedBeatIds = new Set(report.rejectedBeatIds);
  const beatIds = [...new Set(requestedBeatIds.length > 0 ? requestedBeatIds : report.rejectedBeatIds)]
    .filter((beatId) => rejectedBeatIds.has(beatId) && job.visualPlan?.beats.some((beat) => beat.id === beatId));
  if (beatIds.length === 0) {
    return { authorized: [], requiredCents: 0, paused: true, reason: "Visual rough-cut QA has no rejected beats available for recovery." };
  }
  const requiredCents = beatIds.reduce((sum, beatId) => (
    sum + (job.visualPlan?.beats.find((beat) => beat.id === beatId)?.costEstimateCents ?? 0)
  ), 0);
  const remainingCents = Math.max(0, job.recoveryBudgetCents - job.recoverySpentCents);
  if (requiredCents > remainingCents && !confirmSpend) {
    return {
      authorized: [],
      requiredCents,
      paused: true,
      reason: `Visual recovery requires $${(requiredCents / 100).toFixed(2)}; the remaining authorized reserve is $${(remainingCents / 100).toFixed(2)}.`,
    };
  }
  const now = new Date().toISOString();
  const attempt = Math.max(2, report.autoPolishAttempts + 2);
  const authorized = beatIds.map((beatId) => ({ beatId, attempt }));
  const rebalancedPlan = strengthenSemanticRecoveryDirections(
    rebalanceGraphicFamilies(job.visualPlan, beatIds),
    beatIds,
  );
  const visualPlan = {
    ...rebalancedPlan,
    qualityReport: { ...report, autoPolishAttempts: report.autoPolishAttempts + 1 },
  };
  await store.updateJob(productionId, {
    recoveryBudgetCents: requiredCents > remainingCents ? job.recoveryBudgetCents + requiredCents - remainingCents : job.recoveryBudgetCents,
    recoverySpentCents: job.recoverySpentCents + requiredCents,
    status: "running",
    error: undefined,
    visualPlan,
    storyboard: job.storyboard ? attachVisualPlanToStoryboard(job.storyboard, visualPlan) : undefined,
    artifactVersions: [...job.artifactVersions, {
      id: randomUUID(),
      scope: "recovery",
      label: `Visual QA recovery · ${beatIds.length} beat${beatIds.length === 1 ? "" : "s"}`,
      targetId: beatIds.join(","),
      payload: { policy: "visual_quality_manual_recovery", beatIds, requiredCents, reportCheckedAt: report.checkedAt },
      urls: {},
      createdAt: now,
    }],
  });
  return { authorized, requiredCents, paused: false };
}

export async function rebuildEditorialVisualPlan(productionId: string) {
  const store = getStore();
  const job = await store.getJob(productionId);
  if (!job?.storyboard || (job.contentType !== "news_digest" && job.contentType !== "explainer")) throw new Error("Hybrid production not found.");
  const createdAt = new Date().toISOString();
  const visualPlan = buildHybridVisualPlan({
    productionId: job.id,
    request: {
      contentType: job.contentType,
      brief: job.prompt,
      qualityTier: job.qualityTier ?? "standard",
      visualStylePreset: job.visualStylePreset ?? "auto",
      targetDurationSeconds: job.durationSeconds,
      aspectRatio: job.aspectRatio,
    },
    storyboard: job.storyboard,
    createdAt,
    directionVersion: 3,
  });
  if (!visualPlan) throw new Error("Could not build Editorial Direction V3 plan.");
  const storyboard = attachVisualPlanToStoryboard(job.storyboard, visualPlan);
  const storyboardVersionId = randomUUID();
  return store.updateJob(productionId, {
    visualPlan,
    storyboard,
    workflowVersion: job.contentType === "explainer" ? "explainer-v4" : "news-digest-v5",
    estimatedCostCents: visualPlan.metrics.estimatedCostCents + 150,
    recoveryBudgetCents: Math.ceil(visualPlan.metrics.estimatedCostCents * 0.15),
    recoverySpentCents: 0,
    approvals: (job.approvals ?? []).filter((approval) => approval.gate !== "storyboard"),
    artifactVersions: [...job.artifactVersions, {
      id: storyboardVersionId,
      scope: "storyboard",
      label: `Editorial Direction V3 storyboard`,
      payload: { storyboard, visualPlan, reason: "visual_diversity_rebuild" },
      urls: {},
      createdAt,
    }],
    workflowSteps: editorialStepsFor(job).map((step) => step.id === "storyboard"
      ? { ...step, state: "complete" as const, artifactVersionId: storyboardVersionId, completedAt: createdAt, error: undefined }
      : step.id === "storyboard_approval" ? { ...step, state: "awaiting_user" as const, startedAt: createdAt, completedAt: undefined, error: undefined }
        : ["imagery", "generation", "visual_rough_cut_qa", "timeline", "preflight_qa", "render", "final_qa"].includes(step.id)
          ? { ...step, state: "pending" as const, startedAt: undefined, completedAt: undefined, error: undefined }
          : step),
    status: "awaiting_user",
    error: "Review and approve the materially revised Editorial Direction V3 storyboard before generation.",
  });
}

export async function salvageCollidedVisualAssets(productionId: string) {
  const store = getStore();
  let job = await rebuildEditorialVisualPlan(productionId);
  const media = await store.listJobMedia(productionId);
  const salvaged: string[] = [];
  const missing: string[] = [];
  for (const beat of job.visualPlan?.beats.filter((candidate) => ["cinematic_broll", "synthetic_reenactment", "composite"].includes(candidate.kind)) ?? []) {
    const exactGeneration = selectSalvageGeneration(media.generations, beat, true);
    const exactAssets = exactGeneration ? media.assets.filter((asset) => asset.generationId === exactGeneration.id) : [];
    const existingImmutableAsset = exactAssets.find((asset) => typeof asset.metadata.storageKey === "string" && typeof asset.metadata.contentSha256 === "string");
    if (exactGeneration?.status === "success" && existingImmutableAsset) {
      salvaged.push(beat.id);
      continue;
    }

    // Editorial Direction V3 may move the cinematic beat from beat 02 to beat
    // 01 while preserving the scene. Recover the already-paid provider result
    // by scene rather than treating that editorial reordering as a missing clip.
    const sceneGeneration = selectSalvageGeneration(media.generations, beat);
    const sourceGeneration = exactGeneration ?? sceneGeneration;
    if (!sourceGeneration) { missing.push(beat.id); continue; }
    const oldAssets = media.assets.filter((asset) => asset.generationId === sourceGeneration.id);
    const providerUrl = nestedString(sourceGeneration.metadata.providerData, "providerVideoUrl")
      ?? nestedString(sourceGeneration.metadata.providerData, "sourceVideoUrl")
      ?? oldAssets.map((asset) => typeof asset.metadata.providerVideoUrl === "string" ? asset.metadata.providerVideoUrl : undefined).find(Boolean);
    if (!providerUrl) { missing.push(beat.id); continue; }
    const generation = exactGeneration ?? await store.createMediaGeneration({
      projectId: job.projectId,
      videoJobId: job.id,
      kind: "video",
      provider: sourceGeneration.provider,
      model: sourceGeneration.model,
      status: "running",
      prompt: beat.generationPrompt ?? sourceGeneration.prompt,
      controls: {
        ...sourceGeneration.controls,
        visualBeatId: beat.id,
        sceneId: beat.sceneId,
        generationAttempt: 1,
      },
      inputAssetIds: [],
      outputUrls: {},
      metadata: {
        idempotencyKey: `${job.id}:visual:${beat.id}:video:salvage-v1`,
        recoveryOfGenerationId: sourceGeneration.id,
        recoveryReason: "editorial_direction_v3_scene_remap",
        attempt: 1,
        providerData: sourceGeneration.metadata.providerData,
      },
      costCents: 0,
      requestId: sourceGeneration.requestId,
    });
    const storageKey = `projects/${job.projectId}/productions/${job.id}/generations/${generation.id}/${safePart(beat.id)}/video/attempt-1/video.mp4`;
    const blob = await copyRemoteFileToBlob({ url: providerUrl, pathname: storageKey, contentType: "video/mp4", immutable: true });
    const probe = await probeMediaUrl(blob.url);
    const asset = await store.createMediaAsset({
      projectId: job.projectId,
      videoJobId: job.id,
      generationId: generation.id,
      kind: "video",
      role: "seedance_clip",
      url: blob.url,
      mimeType: "video/mp4",
      metadata: {
        providerVideoUrl: providerUrl,
        storageKey,
        contentSha256: blob.sha256,
        probe,
        salvagedAt: new Date().toISOString(),
        collisionRecovery: true,
        recoveryOfGenerationId: sourceGeneration.id,
      },
    });
    await store.updateMediaGeneration(generation.id, {
      status: "success",
      outputUrls: { video: blob.url },
      metadata: {
        ...generation.metadata,
        assetId: asset.id,
        storageKey,
        contentSha256: blob.sha256,
        collisionRecoveredAt: new Date().toISOString(),
        providerData: { ...(sourceGeneration.metadata.providerData as Record<string, unknown> | undefined), videoUrl: blob.url, providerVideoUrl: providerUrl },
      },
      error: undefined,
    });
    salvaged.push(beat.id);
  }
  job = await store.getJob(productionId) ?? job;
  await store.updateJob(productionId, {
    artifactVersions: [...job.artifactVersions, {
      id: randomUUID(), scope: "recovery", label: `Immutable visual salvage · ${salvaged.length} clips`, targetId: salvaged.join(","),
      payload: { policy: "immutable_asset_salvage", salvaged, missing, incrementalProviderCostCents: 0 }, urls: {}, createdAt: new Date().toISOString(),
    }],
  });
  const [{ syncHybridVisualAssets }, { runVisualRoughCutQa }] = await Promise.all([
    import("@/lib/server/hybrid-assets"),
    import("@/lib/server/visual-quality"),
  ]);
  await syncHybridVisualAssets(productionId);
  const qualityReport = await runVisualRoughCutQa(productionId);
  return { salvaged, missing, qualityReport, incrementalProviderCostCents: 0, job: await store.getJob(productionId) };
}

export async function authorizeIdentitySafeRecovery(
  productionId: string,
  failures: HybridAssetState["failed"],
  options: { explicit?: boolean; confirmSpend?: boolean; requestedBeatIds?: string[] } = {},
): Promise<RecoveryAuthorization> {
  if (!isHybridSafeRecoveryEnabled()) {
    return { authorized: [], requiredCents: 0, paused: true, reason: "Identity-safe recovery is disabled for this deployment." };
  }
  const store = getStore();
  const job = await store.getJob(productionId);
  if (!job?.visualPlan) throw new Error("Hybrid production not found.");
  const requested = options.requestedBeatIds?.length ? new Set(options.requestedBeatIds) : undefined;
  const media = await store.listJobMedia(productionId);
  const candidates = failures.filter((failure) => {
    if (failure.beatId === "editorial-score" || (requested && !requested.has(failure.beatId))) return false;
    if (!options.explicit && failure.errorCode !== "fal_likeness_policy") return false;
    const latest = media.generations
      .filter((generation) => generation.controls.visualBeatId === failure.beatId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    const attempt = numberMetadata(latest?.metadata.attempt) ?? 1;
    return options.explicit || attempt < 2;
  });
  const requiredCents = candidates.reduce((sum, failure) => {
    const beat = job.visualPlan?.beats.find((candidate) => candidate.id === failure.beatId);
    return sum + (beat?.costEstimateCents ?? 0);
  }, 0);
  const remaining = Math.max(0, job.recoveryBudgetCents - job.recoverySpentCents);
  if (candidates.length === 0) return { authorized: [], requiredCents, paused: true, reason: "No eligible failed beats remain for safe recovery." };
  if (requiredCents > remaining && !options.confirmSpend) {
    return {
      authorized: [],
      requiredCents,
      paused: true,
      reason: `Safe recovery requires $${(requiredCents / 100).toFixed(2)}; the remaining authorized reserve is $${(remaining / 100).toFixed(2)}.`,
    };
  }
  const now = new Date().toISOString();
  const authorized = candidates.map((failure) => ({ beatId: failure.beatId, generationId: failure.generationId, attempt: 2 }));
  await store.updateJob(productionId, {
    recoveryBudgetCents: requiredCents > remaining ? job.recoveryBudgetCents + requiredCents - remaining : job.recoveryBudgetCents,
    recoverySpentCents: job.recoverySpentCents + requiredCents,
    artifactVersions: [
      ...job.artifactVersions,
      {
        id: randomUUID(),
        scope: "recovery",
        label: `Identity-safe recovery · ${authorized.length} beat${authorized.length === 1 ? "" : "s"}`,
        targetId: authorized.map((item) => item.beatId).join(","),
        payload: {
          policy: "identity_safe_editorial_visualization",
          failures,
          authorized,
          requiredCents,
          explicit: options.explicit === true,
        },
        urls: {},
        createdAt: now,
      },
    ],
    status: "running",
    error: undefined,
  });
  return { authorized, requiredCents, paused: false };
}

export async function reconcileProductionForRecovery(productionId: string) {
  const store = getStore();
  const reconciled = await store.reconcileJobActualCost(productionId);
  const media = await store.listJobMedia(productionId);
  const failed = latestFailedVisuals(media.generations);
  const now = new Date().toISOString();
  const steps = editorialStepsFor(reconciled).map((step) => {
    if (step.id === "imagery") return { ...step, state: "complete" as const, completedAt: step.completedAt ?? now, error: undefined };
    if (step.id === "generation") return { ...step, state: "awaiting_user" as const, error: failed.map((item) => `${item.beatId}: ${item.error}`).join(" ") };
    if (["narration", "visual_rough_cut_qa", "timeline", "preflight_qa", "render", "final_qa"].includes(step.id)) return { ...step, state: "pending" as const, startedAt: undefined, completedAt: undefined, error: undefined };
    return step;
  });
  return store.updateJob(productionId, {
    workflowVersion: reconciled.contentType === "explainer" ? "explainer-v4" : "news-digest-v5",
    status: failed.length > 0 ? "awaiting_user" : reconciled.status,
    workflowSteps: steps,
    error: failed.length > 0 ? `${failed.length} cinematic beat${failed.length === 1 ? "" : "s"} need safe recovery.` : reconciled.error,
  });
}

export async function prepareProductionDeliveryResume(productionId: string) {
  const store = getStore();
  const reconciled = await store.reconcileJobActualCost(productionId);
  if (reconciled.contentType !== "news_digest" && reconciled.contentType !== "explainer") {
    throw new Error("Delivery resume is available only for news and explainer productions.");
  }
  const media = await store.listJobMedia(productionId);
  if (latestFailedVisuals(media.generations).length > 0) {
    throw new Error("Failed cinematic beats must be recovered before delivery can resume.");
  }
  const steps = editorialStepsFor(reconciled).map((step) => {
    if (["visual_rough_cut_qa", "timeline", "preflight_qa", "render", "final_qa"].includes(step.id)) {
      return {
        ...step,
        state: "pending" as const,
        startedAt: undefined,
        completedAt: undefined,
        error: undefined,
      };
    }
    return step;
  });
  return store.updateJob(productionId, {
    workflowVersion: reconciled.contentType === "explainer" ? "explainer-v4" : "news-digest-v5",
    status: "running",
    workflowSteps: steps,
    error: undefined,
  });
}

export function latestFailedVisuals(generations: Awaited<ReturnType<ReturnType<typeof getStore>["listJobMedia"]>>["generations"]) {
  const latest = new Map<string, typeof generations[number]>();
  for (const generation of [...generations].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))) {
    const beatId = typeof generation.controls.visualBeatId === "string" ? generation.controls.visualBeatId : undefined;
    if (!beatId || generation.kind !== "video" || latest.has(beatId)) continue;
    latest.set(beatId, generation);
  }
  return [...latest.entries()].flatMap(([beatId, generation]) => generation.status === "failed" ? [{
    beatId,
    generationId: generation.id,
    errorCode: typeof generation.metadata.errorCode === "string"
      ? generation.metadata.errorCode
      : generation.metadata.providerError && typeof generation.metadata.providerError === "object" && typeof (generation.metadata.providerError as Record<string, unknown>).code === "string"
        ? String((generation.metadata.providerError as Record<string, unknown>).code)
        : undefined,
    retryable: generation.metadata.retryable === true,
    attempt: typeof generation.metadata.attempt === "number" ? Math.max(1, Math.floor(generation.metadata.attempt)) : 1,
    error: generation.error ?? "Visual provider generation failed.",
  }] : []);
}

function numberMetadata(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.floor(value)) : undefined;
}

function nestedString(value: unknown, key: string) {
  return value && typeof value === "object" && typeof (value as Record<string, unknown>)[key] === "string" ? String((value as Record<string, unknown>)[key]) : undefined;
}

function safePart(value: string) { return value.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 120); }
function stringValue(value: unknown) { return typeof value === "string" ? value : undefined; }

export function selectSalvageGeneration(
  generations: MediaGeneration[],
  beat: { id: string; sceneId: string },
  exactOnly = false,
) {
  const newest = [...generations].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const exact = newest.find((candidate) => candidate.kind === "video" && candidate.controls.visualBeatId === beat.id);
  if (exact || exactOnly) return exact;
  return newest.find((candidate) => candidate.kind === "video" && candidate.status === "success" && stringValue(candidate.controls.visualBeatId)?.startsWith(`${beat.sceneId}-beat-`));
}
