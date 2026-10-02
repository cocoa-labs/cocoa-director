import type {
  AspectRatio,
  BeatGrid,
  ContentType,
  GeneratedShot,
  MusicTrack,
  ProductionCreateRequest,
  ProviderCapability,
  QAReport,
  QualityTier,
  SourceBundle,
  TimelineManifestV2,
  TimelineSegment,
  VideoCreateRequest,
  WorkflowStep,
} from "@/lib/schemas";

export type WorkflowProfile = {
  id: string;
  contentType: ContentType;
  label: string;
  description: string;
  steps: Array<{ id: string; name: string; dependsOn?: string[] }>;
};

const COMMON_END_STEPS: WorkflowProfile["steps"] = [
  { id: "timeline", name: "Timeline assembly", dependsOn: ["generation"] },
  { id: "qa", name: "Quality assurance", dependsOn: ["timeline"] },
  { id: "review", name: "Review", dependsOn: ["qa"] },
  { id: "render", name: "Render", dependsOn: ["review"] },
];

const EDITORIAL_DELIVERY_STEPS: WorkflowProfile["steps"] = [
  { id: "narration", name: "Narration and alignment", dependsOn: ["storyboard_approval"] },
  { id: "timing_reconciliation", name: "Editorial timing reconciliation", dependsOn: ["narration"] },
  { id: "imagery", name: "Editorial imagery", dependsOn: ["timing_reconciliation"] },
  { id: "score", name: "Editorial score", dependsOn: ["timing_reconciliation"] },
  { id: "generation", name: "Cinematic clips", dependsOn: ["imagery"] },
  { id: "visual_rough_cut_qa", name: "Audiovisual rough-cut QA", dependsOn: ["generation", "score"] },
  { id: "timeline", name: "Timeline assembly", dependsOn: ["timing_reconciliation", "visual_rough_cut_qa"] },
  { id: "preflight_qa", name: "Preflight quality assurance", dependsOn: ["timeline"] },
  { id: "render", name: "Render", dependsOn: ["preflight_qa"] },
  { id: "final_qa", name: "Final validation and delivery", dependsOn: ["render"] },
];

export const WORKFLOW_PROFILES: Record<ContentType, WorkflowProfile> = {
  music_video: {
    id: "music-video-v2",
    contentType: "music_video",
    label: "Music video",
    description: "Beat-driven cinematic video with visual anchors and generated shots.",
    steps: [
      { id: "intake", name: "Creative treatment" },
      { id: "composition", name: "Composition plan", dependsOn: ["intake"] },
      { id: "music", name: "Music", dependsOn: ["composition"] },
      { id: "beat_analysis", name: "Beat analysis", dependsOn: ["music"] },
      { id: "anchors", name: "Visual anchors", dependsOn: ["beat_analysis"] },
      { id: "storyboard", name: "Shot plan", dependsOn: ["anchors"] },
      { id: "generation", name: "Shot generation", dependsOn: ["storyboard"] },
      ...COMMON_END_STEPS,
    ],
  },
  explainer: {
    id: "explainer-v5",
    contentType: "explainer",
    label: "Faceless explainer",
    description: "Narrated teaching video built from supplied text, documents, and URLs.",
    steps: [
      { id: "intake", name: "Source intake" },
      { id: "source_processing", name: "Source processing", dependsOn: ["intake"] },
      { id: "editorial", name: "Teaching outline", dependsOn: ["source_processing"] },
      { id: "script", name: "Script", dependsOn: ["editorial"] },
      { id: "script_approval", name: "Script approval", dependsOn: ["script"] },
      { id: "storyboard", name: "Hybrid visual storyboard", dependsOn: ["script_approval"] },
      { id: "storyboard_approval", name: "Storyboard and spend approval", dependsOn: ["storyboard"] },
      ...EDITORIAL_DELIVERY_STEPS,
    ],
  },
  news_digest: {
    id: "news-digest-v6",
    contentType: "news_digest",
    label: "News and information",
    description: "Cited information video with a claim ledger and source-linked visuals.",
    steps: [
      { id: "intake", name: "Source intake" },
      { id: "source_processing", name: "Source processing", dependsOn: ["intake"] },
      { id: "research", name: "Claim ledger", dependsOn: ["source_processing"] },
      { id: "editorial", name: "Editorial selection", dependsOn: ["research"] },
      { id: "script", name: "Cited script", dependsOn: ["editorial"] },
      { id: "script_approval", name: "Cited script approval", dependsOn: ["script"] },
      { id: "storyboard", name: "Citation-linked storyboard", dependsOn: ["script_approval"] },
      { id: "storyboard_approval", name: "Storyboard and visual-source approval", dependsOn: ["storyboard"] },
      ...EDITORIAL_DELIVERY_STEPS,
    ],
  },
  product_social: {
    id: "product-social-v1",
    contentType: "product_social",
    label: "Product and social",
    description: "Brand-aware product story with channel-ready variants.",
    steps: [
      { id: "intake", name: "Product brief" },
      { id: "source_processing", name: "Brand and product assets", dependsOn: ["intake"] },
      { id: "editorial", name: "Benefit story", dependsOn: ["source_processing"] },
      { id: "plan_review", name: "Benefit story review", dependsOn: ["editorial"] },
      { id: "storyboard", name: "Variant storyboard", dependsOn: ["plan_review"] },
      { id: "generation", name: "Product visuals", dependsOn: ["storyboard"] },
      ...COMMON_END_STEPS,
    ],
  },
  custom: {
    id: "custom-v1",
    contentType: "custom",
    label: "Custom production",
    description: "A content-neutral production assembled from reusable workflow steps.",
    steps: [
      { id: "intake", name: "Brief" },
      { id: "source_processing", name: "Source processing", dependsOn: ["intake"] },
      { id: "editorial", name: "Production plan", dependsOn: ["source_processing"] },
      { id: "plan_review", name: "Production plan review", dependsOn: ["editorial"] },
      { id: "storyboard", name: "Storyboard", dependsOn: ["plan_review"] },
      { id: "generation", name: "Asset generation", dependsOn: ["storyboard"] },
      ...COMMON_END_STEPS,
    ],
  },
};

export function workflowProfileFor(contentType: ContentType): WorkflowProfile {
  return WORKFLOW_PROFILES[contentType];
}

export function initialWorkflowSteps(contentType: ContentType): WorkflowStep[] {
  return workflowProfileFor(contentType).steps.map((step) => ({
    id: step.id,
    name: step.name,
    state: "pending",
    dependsOn: step.dependsOn ?? [],
  }));
}

export function legacyVideoRequestForProduction(input: ProductionCreateRequest): VideoCreateRequest {
  return {
    prompt: input.brief,
    durationSeconds: Math.min(120, Math.max(60, input.targetDurationSeconds)),
    aspectRatio: input.aspectRatio,
    visualMode: "conceptual",
    autopilot: input.autopilot,
  };
}

export function compileMusicTimeline(input: {
  productionId: string;
  shots: GeneratedShot[];
  music: MusicTrack;
  beatGrid: BeatGrid;
  aspectRatio: AspectRatio;
  compiledAt?: string;
}): TimelineManifestV2 {
  const sortedShots = [...input.shots].sort((left, right) => {
    const leftStart = left.timelineStartMs ?? left.shotIndex;
    const rightStart = right.timelineStartMs ?? right.shotIndex;
    return leftStart - rightStart;
  });

  let cursorMs = 0;
  const videoSegments: TimelineSegment[] = sortedShots.map((shot) => {
    const startMs = shot.timelineStartMs ?? cursorMs;
    const actualDurationMs = Math.max(
      1,
      Math.round((shot.actualDurationSeconds ?? shot.probe?.durationSeconds ?? shot.durationSeconds) * 1_000),
    );
    const requestedDurationMs = Math.max(
      1,
      Math.round((shot.requestedDurationSeconds ?? shot.durationSeconds) * 1_000),
    );
    const desiredEndMs = shot.timelineEndMs ?? startMs + requestedDurationMs;
    const usableInMs = Math.round((shot.usableInSeconds ?? 0) * 1_000);
    const availableDurationMs = Math.max(1, actualDurationMs - usableInMs);
    const shortageMs = requestedDurationMs - availableDurationMs;
    const retimeLimitMs = Math.max(250, requestedDurationMs * 0.08);
    const renderableDurationMs = shortageMs <= retimeLimitMs ? requestedDurationMs : availableDurationMs;
    const endMs = Math.min(desiredEndMs, startMs + renderableDurationMs);
    cursorMs = endMs;
    return {
      id: `shot-${String(shot.shotIndex).padStart(2, "0")}`,
      trackId: "video-main",
      kind: "video",
      startMs,
      endMs: Math.max(startMs + 1, endMs),
      sourceUrl: shot.videoUrl,
      sourceInMs: usableInMs,
      sourceOutMs: shot.usableOutSeconds ? Math.round(shot.usableOutSeconds * 1_000) : actualDurationMs,
      requestedDurationMs,
      actualDurationMs,
      usableInMs,
      usableOutMs: shot.usableOutSeconds ? Math.round(shot.usableOutSeconds * 1_000) : actualDurationMs,
      handleInMs: 0,
      handleOutMs: 0,
      hold: false,
      transitionIn: { type: "cut", durationMs: 0 },
      transitionOut: { type: "cut", durationMs: 0 },
      provenance: shot.provenance,
      probe: shot.probe,
      metadata: { shotIndex: shot.shotIndex, seed: shot.seed },
    };
  });

  const durationMs = Math.min(
    Math.round(input.music.durationSeconds * 1_000),
    videoSegments.at(-1)?.endMs ?? Math.round(input.music.durationSeconds * 1_000),
  );
  const clippedVideoSegments = videoSegments
    .filter((segment) => segment.startMs < durationMs)
    .map((segment) => ({ ...segment, endMs: Math.min(segment.endMs, durationMs) }));

  return {
    version: 2,
    productionId: input.productionId,
    contentType: "music_video",
    durationMs: Math.max(1, durationMs),
    fps: 30,
    aspectRatio: input.aspectRatio,
    tracks: [
      { id: "video-main", kind: "video", segments: clippedVideoSegments },
      {
        id: "music-main",
        kind: "music",
        segments: [{
          id: "music-bed",
          trackId: "music-main",
          kind: "music",
          startMs: 0,
          endMs: Math.max(1, durationMs),
          sourceUrl: input.music.url,
          sourceInMs: 0,
          sourceOutMs: Math.max(1, durationMs),
          requestedDurationMs: Math.max(1, durationMs),
          actualDurationMs: Math.max(1, Math.round(input.music.durationSeconds * 1_000)),
          usableInMs: 0,
          usableOutMs: Math.max(1, durationMs),
          handleInMs: 0,
          handleOutMs: 0,
          hold: false,
          metadata: { beatCount: input.beatGrid.events.length },
        }],
      },
    ],
    compiledAt: input.compiledAt ?? new Date().toISOString(),
  };
}

export function validateTimeline(input: {
  timeline: TimelineManifestV2;
  sourceBundle?: SourceBundle;
  checkedAt?: string;
}): QAReport {
  const findings: QAReport["findings"] = [];
  const visualTracks = input.timeline.tracks.filter((track) =>
    (track.kind === "video" || track.kind === "graphics") && track.segments.length > 0
  );
  const segments = visualTracks
    .flatMap((track) => track.segments)
    .sort((left, right) => left.startMs - right.startMs || right.endMs - left.endMs);

  if (segments.length === 0) {
    findings.push(finding("timeline.no_visuals", "error", "The timeline has no visual segments."));
  }

  // Coverage is evaluated across the composite visual stack. Hybrid editorial
  // timelines intentionally place graphics over footage, so cross-track
  // overlaps are valid and a graphics segment may cover a gap in the video
  // layer.
  let cursorMs = 0;
  for (const segment of segments) {
    if (segment.startMs > cursorMs) {
      findings.push({
        ...finding("timeline.gap", "error", `Unexplained ${segment.startMs - cursorMs}ms timeline gap.`),
        segmentId: segment.id,
        startMs: cursorMs,
        endMs: segment.startMs,
      });
    }
    cursorMs = Math.max(cursorMs, segment.endMs);
  }

  // Overlap remains an error within an individual visual track unless the
  // segment declares a transition. This preserves strict edit integrity
  // without rejecting intentional compositing between tracks.
  for (const track of visualTracks) {
    let trackCursorMs = 0;
    for (const segment of [...track.segments].sort((left, right) => left.startMs - right.startMs)) {
      if (segment.startMs < trackCursorMs && (segment.transitionIn?.durationMs ?? 0) === 0) {
        findings.push({
          ...finding("timeline.overlap", "error", "Timeline segments overlap without a declared transition."),
          segmentId: segment.id,
          startMs: segment.startMs,
          endMs: trackCursorMs,
        });
      }
      trackCursorMs = Math.max(trackCursorMs, segment.endMs);
    }
  }

  // Measured-source checks apply to every video segment, regardless of which
  // track supplies continuous composite coverage.
  for (const segment of visualTracks.flatMap((track) => track.segments).filter((candidate) => candidate.kind === "video")) {
    const timelineDurationMs = segment.endMs - segment.startMs;
    const usableSourceMs = segment.actualDurationMs === undefined
      ? undefined
      : (segment.usableOutMs ?? segment.actualDurationMs) - segment.usableInMs;
    const shortageMs = usableSourceMs === undefined ? 0 : timelineDurationMs - usableSourceMs;
    const retimeLimitMs = Math.max(250, timelineDurationMs * 0.08);
    if (segment.kind === "video" && !segment.hold && shortageMs > retimeLimitMs) {
      findings.push({
        ...finding(
          "timeline.short_source",
          "error",
          "A video segment is longer than its measured usable source and would require a frozen tail.",
          true,
        ),
        segmentId: segment.id,
        startMs: segment.startMs,
        endMs: segment.endMs,
      });
    } else if (segment.kind === "video" && !segment.hold && shortageMs > 0) {
      findings.push({
        ...finding(
          "timeline.bounded_retime",
          "warning",
          `A ${shortageMs.toFixed(0)}ms source shortage will use bounded timestamp retiming.`,
        ),
        segmentId: segment.id,
        startMs: segment.startMs,
        endMs: segment.endMs,
      });
    }
  }

  if (Math.abs(cursorMs - input.timeline.durationMs) > 1_000 / input.timeline.fps) {
    findings.push(finding("timeline.duration_mismatch", "error", "Timeline coverage differs from its declared duration by more than one frame."));
  }

  if ((input.timeline.contentType === "news_digest" || input.timeline.contentType === "explainer") && (input.timeline.metadata?.measuredSpeechBounds?.length ?? 0) > 0) {
    const narration = input.timeline.tracks.filter((track) => track.kind === "narration").flatMap((track) => track.segments).sort((left, right) => left.startMs - right.startMs);
    const spokenMs = narration.reduce((sum, segment) => sum + segment.endMs - segment.startMs, 0);
    const spokenCoverage = spokenMs / input.timeline.durationMs;
    if (narration.length === 0) findings.push(finding("narration.missing", "error", "Narration-led production has no measured narration segments."));
    if (spokenCoverage < 0.75 || spokenCoverage > 0.92) findings.push(finding("narration.coverage", "error", `Measured spoken coverage is ${Math.round(spokenCoverage * 100)}%; required range is 75–92%.`));
    let speechCursor = 0;
    for (const segment of narration) {
      const gapMs = segment.startMs - speechCursor;
      if (gapMs > 1_500) findings.push({ ...finding("narration.unapproved_gap", "error", `Narration-free interval is ${gapMs}ms; the maximum is 1500ms.`), startMs: speechCursor, endMs: segment.startMs });
      speechCursor = Math.max(speechCursor, segment.endMs);
    }
    const endingGapMs = input.timeline.durationMs - speechCursor;
    if (endingGapMs > 1_500) findings.push({ ...finding("narration.unapproved_gap", "error", `Ending narration-free interval is ${endingGapMs}ms; the maximum is 1500ms.`), startMs: speechCursor, endMs: input.timeline.durationMs });

    for (const segment of input.timeline.tracks.filter((track) => track.kind === "graphics").flatMap((track) => track.segments)) {
      const motionCues = Array.isArray(segment.metadata.motionCues) ? segment.metadata.motionCues.filter((cue): cue is { atMs: number } => Boolean(cue) && typeof cue === "object" && typeof (cue as { atMs?: unknown }).atMs === "number") : [];
      const durationMs = segment.endMs - segment.startMs;
      const cueTimes = [0, ...motionCues.map((cue) => cue.atMs).filter((atMs) => atMs > 0 && atMs < durationMs), durationMs].sort((left, right) => left - right);
      const longestStateMs = cueTimes.slice(1).reduce((maximum, value, index) => Math.max(maximum, value - cueTimes[index]), 0);
      const isPdfEvidence = typeof segment.metadata.sourceVisual === "object" && segment.metadata.sourceVisual && ["pdf_page", "pdf_highlight_crop"].includes(String((segment.metadata.sourceVisual as { kind?: unknown }).kind));
      const fullScreenLimitMs = isPdfEvidence ? 4_000 : 3_000;
      if (segment.metadata.fullScreen === true && durationMs > fullScreenLimitMs) findings.push({ ...finding("motion.full_screen_too_long", "error", `An unchanged full-screen information composition exceeds ${fullScreenLimitMs / 1_000} seconds.`), segmentId: segment.id, startMs: segment.startMs, endMs: segment.endMs });
      if (longestStateMs > 1_500 && motionCues.length > 0) findings.push({ ...finding("motion.information_stasis", "error", `Information composition has no meaningful state change for ${longestStateMs}ms.`), segmentId: segment.id, startMs: segment.startMs, endMs: segment.endMs });
    }
  }

  if (input.timeline.contentType === "news_digest") {
    const claims = input.sourceBundle?.claims ?? [];
    const evidenceSources = input.sourceBundle?.inputs.filter((source) => source.kind === "url" || source.kind === "document") ?? [];
    if (evidenceSources.length < 2) {
      findings.push(finding("facts.corroboration_recommended", "warning", "Only one independent document or URL source is present; consider enabling web corroboration."));
    }
    for (const source of input.sourceBundle?.inputs ?? []) {
      if (source.kind !== "url") continue;
      if (!source.publishedAt) {
        findings.push(finding("facts.missing_source_date", "warning", `Publication date is missing for ${source.title ?? source.url}.`));
      } else {
        const ageMs = Date.now() - new Date(source.publishedAt).getTime();
        if (Number.isFinite(ageMs) && ageMs > 30 * 24 * 60 * 60 * 1_000) {
          findings.push(finding("facts.stale_source", "warning", `Source may be stale: ${source.title ?? source.url}.`));
        }
      }
    }
    if (claims.length === 0) {
      findings.push(finding(
        "facts.no_claim_ledger",
        "error",
        "News and information productions require a non-empty claim ledger before narration or rendering.",
        true,
      ));
    }
    for (const claim of claims) {
      if (claim.editorialStatus === "excluded") continue;
      if (claim.status !== "supported" || claim.sourceIds.length === 0 || claim.evidenceRefs.length === 0) {
        findings.push(finding("facts.unsupported_claim", "error", `Unsupported claim: ${claim.text}`, true));
      }
      const independentSources = new Set((claim.independenceGroup ?? "").split("|").filter(Boolean)).size;
      if (claim.breaking && independentSources < 2) {
        findings.push(finding("facts.insufficient_corroboration", "error", `Breaking claim needs two independent sources: ${claim.text}`, true));
      }
    }
  }

  return {
    version: 1,
    productionId: input.timeline.productionId,
    passed: findings.every((item) => item.severity !== "error"),
    findings,
    metrics: {
      durationMs: input.timeline.durationMs,
      videoSegmentCount: segments.length,
      errorCount: findings.filter((item) => item.severity === "error").length,
      warningCount: findings.filter((item) => item.severity === "warning").length,
    },
    checkedAt: input.checkedAt ?? new Date().toISOString(),
  };
}

export function chooseProviderCapability(input: {
  capabilities: ProviderCapability[];
  mediaKind: ProviderCapability["mediaKind"];
  qualityTier: QualityTier;
  durationSeconds?: number;
  requiredInputMode?: string;
}): ProviderCapability | undefined {
  const eligible = input.capabilities.filter((capability) => {
    if (capability.mediaKind !== input.mediaKind || capability.versionStatus === "deprecated") return false;
    if (input.durationSeconds && capability.maxDurationSeconds && capability.maxDurationSeconds < input.durationSeconds) return false;
    return !input.requiredInputMode || capability.inputModes.includes(input.requiredInputMode);
  });

  return eligible.sort((left, right) => providerScore(right, input.qualityTier) - providerScore(left, input.qualityTier))[0];
}

function providerScore(capability: ProviderCapability, tier: QualityTier) {
  const qualityWeight = tier === "premium" ? 0.65 : tier === "standard" ? 0.45 : 0.25;
  const reliabilityWeight = tier === "draft" ? 0.35 : 0.3;
  const costWeight = tier === "draft" ? 0.3 : tier === "standard" ? 0.2 : 0.05;
  const latencyWeight = tier === "draft" ? 0.1 : 0.05;
  const normalizedCost = 1 / (1 + capability.estimatedCostPerUnitUsd);
  const normalizedLatency = 1 / (1 + capability.estimatedLatencySeconds / 60);
  return (
    capability.qualityScore * qualityWeight +
    capability.reliabilityScore * reliabilityWeight +
    normalizedCost * costWeight +
    normalizedLatency * latencyWeight
  );
}

function finding(code: string, severity: "info" | "warning" | "error", message: string, retryable = false) {
  return {
    id: `${code}-${Math.abs(hashString(message))}`,
    category: code.startsWith("facts.") ? "factual" as const : "structural" as const,
    severity,
    code,
    message,
    retryable,
  };
}

function hashString(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return hash;
}
