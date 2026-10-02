import type {
  EditorialTimingPlan,
  HybridVisualPlanV2,
  NarrationCoverageReport,
  NewsStoryboard,
  VisualBeat,
} from "@/lib/schemas";

const MIN_COVERAGE = 0.75;
const MAX_COVERAGE = 0.92;
const DEFAULT_PAUSE_MS = 600;
const CHAPTER_PAUSE_MS = 1_100;
const MAX_PAUSE_MS = 1_500;
const MAX_RETIME_DELTA = 0.03;
const MIN_VISUAL_BEAT_MS = 2_000;
const MAX_VISUAL_BEAT_MS = 6_000;
const MAX_FULL_SCREEN_INFORMATION_MS = 3_000;
const MAX_FULL_SCREEN_PDF_MS = 4_000;
const CINEMATIC_KINDS = new Set(["cinematic_broll", "synthetic_reenactment", "composite"]);
const INFORMATION_KINDS = new Set(["documentary_source", "document_excerpt", "data_visualization"]);

export type MeasuredNarration = {
  sceneId: string;
  durationMs: number;
};

/** Scene headings are presentation metadata, not words the narrator speaks. */
export function spokenScriptText(script: string, sceneTitles: string[]) {
  const titles = new Set(sceneTitles.map((title) => title.trim().toLowerCase()));
  return script.split(/\n+/).map((line) => line.trim())
    .filter((line) => line && !titles.has(line.toLowerCase())).join(" ");
}

export function detectBriefDurationSeconds(brief: string): number | undefined {
  const normalized = brief.toLowerCase().replace(/[–—]/g, "-");
  const clock = normalized.match(/\b(\d{1,2}):(\d{2})\b/);
  if (clock) {
    const seconds = Number(clock[1]) * 60 + Number(clock[2]);
    return seconds >= 15 && seconds <= 600 ? seconds : undefined;
  }
  const rangedMinutes = normalized.match(/\b(\d+(?:\.\d+)?)\s*(?:-|to)\s*(\d+(?:\.\d+)?)\s*(?:minutes?|mins?)\b/);
  if (rangedMinutes) return boundedSeconds(Number(rangedMinutes[1]) * 60);
  const minutes = normalized.match(/\b(\d+(?:\.\d+)?)\s*-?\s*(?:minutes?|mins?)\b/);
  if (minutes) return boundedSeconds(Number(minutes[1]) * 60);
  const seconds = normalized.match(/\b(\d+)\s*-?\s*(?:seconds?|secs?)\b/);
  if (seconds) return boundedSeconds(Number(seconds[1]));
  return undefined;
}

function boundedSeconds(value: number) {
  const rounded = Math.round(value);
  return rounded >= 15 && rounded <= 600 ? rounded : undefined;
}

export function compileEditorialTimingPlan(input: {
  productionId: string;
  storyboard: NewsStoryboard;
  narration: MeasuredNarration[];
  targetDurationMs: number;
  compiledAt: string;
}): EditorialTimingPlan {
  const narrationByScene = new Map(input.narration.map((item) => [item.sceneId, item.durationMs]));
  const missing = input.storyboard.scenes.filter((scene) => !narrationByScene.has(scene.id));
  if (missing.length > 0) throw new Error(`Measured narration is missing for ${missing.map((scene) => scene.id).join(", ")}.`);

  const spokenDurationMs = input.storyboard.scenes.reduce((sum, scene) => sum + (narrationByScene.get(scene.id) ?? 0), 0);
  const rawCoverage = spokenDurationMs / input.targetDurationMs;
  const retimeRate = rawCoverage > MAX_COVERAGE && rawCoverage <= MAX_COVERAGE * (1 + MAX_RETIME_DELTA)
    ? rawCoverage / MAX_COVERAGE
    : 1;
  if (retimeRate > 1 + MAX_RETIME_DELTA) throw new Error("Narration exceeds the selected duration by more than the permitted 3% retiming range. Revise and reapprove the script.");

  const adjustedDurations = input.storyboard.scenes.map((scene) => Math.round((narrationByScene.get(scene.id) ?? 0) / retimeRate));
  const adjustedSpokenMs = adjustedDurations.reduce((sum, duration) => sum + duration, 0);
  const sceneCount = input.storyboard.scenes.length;
  const availablePauseMs = input.targetDurationMs - adjustedSpokenMs;
  const maximumPauseCapacity = sceneCount * MAX_PAUSE_MS;
  const findings: NarrationCoverageReport["findings"] = [];
  const legacySceneGaps = input.storyboard.scenes.map((scene) => ({
    sceneId: scene.id,
    startMs: scene.startMs + (narrationByScene.get(scene.id) ?? 0),
    endMs: scene.endMs,
    durationMs: Math.max(0, scene.endMs - scene.startMs - (narrationByScene.get(scene.id) ?? 0)),
  })).filter((gap) => gap.durationMs > MAX_PAUSE_MS);
  for (const gap of legacySceneGaps) findings.push({
    code: "narration.legacy_padding_removed",
    severity: "review",
    message: `${gap.sceneId} contained ${(gap.durationMs / 1_000).toFixed(1)} seconds of legacy layout padding; V2 removed it while rebuilding the scene from measured narration.`,
    sceneId: gap.sceneId,
    startMs: gap.startMs,
    endMs: gap.endMs,
  });
  if (availablePauseMs < 0) findings.push({ code: "narration.overrun", severity: "blocking", message: "Measured narration exceeds the selected duration after the maximum permitted retiming." });
  if (availablePauseMs > maximumPauseCapacity) findings.push({ code: "narration.underfill", severity: "blocking", message: `Supported narration leaves ${(availablePauseMs / 1_000).toFixed(1)} seconds unfilled. Shorten the selected duration or add sourced context and reapprove the script.` });

  const coverage = adjustedSpokenMs / input.targetDurationMs;
  if (coverage < MIN_COVERAGE) findings.push({ code: "narration.coverage_low", severity: "blocking", message: `Predicted spoken coverage is ${(coverage * 100).toFixed(1)}%; narration-led output requires at least 75%.` });
  if (coverage > MAX_COVERAGE) findings.push({ code: "narration.coverage_high", severity: "blocking", message: `Predicted spoken coverage is ${(coverage * 100).toFixed(1)}%; reserve brief transitions by condensing the script.` });

  const pauses: EditorialTimingPlan["pauses"] = [];
  const sceneTimings: EditorialTimingPlan["scenes"] = [];
  let cursor = 0;
  let remainingPauseMs = Math.max(0, availablePauseMs);
  for (let index = 0; index < input.storyboard.scenes.length; index += 1) {
    const scene = input.storyboard.scenes[index];
    const measuredNarrationMs = narrationByScene.get(scene.id) ?? 1;
    const narrationMs = adjustedDurations[index];
    const speechStartMs = cursor;
    const speechEndMs = speechStartMs + narrationMs;
    const chapterBoundary = index < input.storyboard.scenes.length - 1 && isChapterBoundary(input.storyboard.scenes[index], input.storyboard.scenes[index + 1]);
    const desired = chapterBoundary ? CHAPTER_PAUSE_MS : DEFAULT_PAUSE_MS;
    const remainingScenes = sceneCount - index;
    const fairShare = Math.round(remainingPauseMs / Math.max(1, remainingScenes));
    const pauseMs = Math.min(MAX_PAUSE_MS, remainingPauseMs, Math.max(Math.min(desired, remainingPauseMs), fairShare));
    const pauseId = pauseMs > 0 ? `pause-${scene.id}` : undefined;
    if (pauseId) pauses.push({
      id: pauseId,
      afterSceneId: scene.id,
      startMs: speechEndMs,
      endMs: speechEndMs + pauseMs,
      durationMs: pauseMs,
      kind: chapterBoundary ? "chapter" : "transition",
      reason: chapterBoundary ? "Approved chapter transition" : "Narration transition breath",
      approved: chapterBoundary,
    });
    cursor = speechEndMs + pauseMs;
    remainingPauseMs -= pauseMs;
    sceneTimings.push({ sceneId: scene.id, startMs: speechStartMs, speechStartMs, speechEndMs, endMs: cursor, measuredNarrationMs, retimeRate, pauseAfterId: pauseId });
  }

  const report: NarrationCoverageReport = {
    version: 1,
    targetDurationMs: input.targetDurationMs,
    spokenDurationMs: adjustedSpokenMs,
    spokenCoverage: round(coverage),
    longestUnapprovedGapMs: pauses
      .filter((pause) => !pause.approved)
      .reduce((max, pause) => Math.max(max, pause.durationMs), 0),
    passed: findings.every((finding) => finding.severity !== "blocking") && cursor === input.targetDurationMs,
    findings,
  };
  if (cursor !== input.targetDurationMs) report.findings.push({ code: "timeline.unallocated_duration", severity: "blocking", message: `${Math.abs(input.targetDurationMs - cursor)}ms cannot be allocated without exceeding the explicit pause policy.` });
  report.passed = report.findings.every((finding) => finding.severity !== "blocking") && cursor === input.targetDurationMs;
  return { version: 2, productionId: input.productionId, targetDurationMs: input.targetDurationMs, scenes: sceneTimings, pauses, coverage: report, compiledAt: input.compiledAt };
}

export function applyTimingPlan(storyboard: NewsStoryboard, plan: HybridVisualPlanV2, timing: EditorialTimingPlan) {
  const timings = new Map(timing.scenes.map((scene) => [scene.sceneId, scene]));
  const scenes = storyboard.scenes.map((scene) => {
    const measured = timings.get(scene.id);
    if (!measured) return scene;
    return { ...scene, startMs: measured.startMs, endMs: measured.endMs };
  });
  const normalized = normalizeEditorialVisualBeats({ ...plan, version: 4 as const }, scenes);
  return {
    storyboard: { ...storyboard, scenes },
    plan: {
      ...normalized,
      timingPlan: timing,
      metrics: { ...normalized.metrics, predictedNarrationDurationMs: timing.coverage.spokenDurationMs },
    },
  };
}

/**
 * Reflows approved beats into measured scene windows without changing their
 * editorial intent or generated assets. Timing is deterministic work: it must
 * not become a provider-regeneration request merely because TTS changed a
 * scene's duration.
 */
export function normalizeEditorialVisualBeats(
  plan: HybridVisualPlanV2,
  scenes: Array<{ id: string; startMs: number; endMs: number }>,
): HybridVisualPlanV2 {
  const sceneIds = new Set(scenes.map((scene) => scene.id));
  const normalized: VisualBeat[] = [];

  for (const scene of scenes) {
    const candidates = plan.beats
      .filter((beat) => beat.sceneId === scene.id)
      .sort((left, right) => left.startMs - right.startMs || left.index - right.index);
    if (candidates.length === 0) continue;
    const durationMs = Math.max(1, scene.endMs - scene.startMs);
    const minimumCount = Math.max(1, Math.ceil(durationMs / MAX_VISUAL_BEAT_MS));
    const maximumCount = Math.max(1, Math.floor(durationMs / MIN_VISUAL_BEAT_MS));
    const targetCount = Math.min(candidates.length, Math.max(minimumCount, Math.min(maximumCount, candidates.length)));
    const selected = selectEditorialBeats(candidates, targetCount);
    const durations = allocateVisualBeatDurations(selected, durationMs);
    let cursor = scene.startMs;

    for (let index = 0; index < selected.length; index += 1) {
      const beat = selected[index];
      const endMs = index === selected.length - 1 ? scene.endMs : cursor + durations[index];
      const beatDurationMs = endMs - cursor;
      const fullScreenLimitMs = isPdfVisual(beat) ? MAX_FULL_SCREEN_PDF_MS : MAX_FULL_SCREEN_INFORMATION_MS;
      normalized.push({
        ...beat,
        index,
        startMs: cursor,
        endMs,
        fullScreen: beat.fullScreen && beatDurationMs <= fullScreenLimitMs,
        motionCues: buildMotionCues(beatDurationMs),
      });
      cursor = endMs;
    }
  }

  normalized.push(...plan.beats.filter((beat) => !sceneIds.has(beat.sceneId)));
  normalized.sort((left, right) => left.startMs - right.startMs || left.index - right.index);
  const targetDurationMs = Math.max(1, plan.metrics.targetDurationMs);
  const cinematic = normalized.filter((beat) => CINEMATIC_KINDS.has(beat.kind));
  return {
    ...plan,
    beats: normalized,
    metrics: {
      ...plan.metrics,
      cinematicCoverage: round(cinematic.reduce((sum, beat) => sum + beat.endMs - beat.startMs, 0) / targetDurationMs),
      staticCoverage: round(normalized.filter((beat) => beat.hold).reduce((sum, beat) => sum + beat.endMs - beat.startMs, 0) / targetDurationMs),
      cinematicBeatCount: cinematic.length,
      evidenceBeatCount: normalized.filter((beat) => INFORMATION_KINDS.has(beat.kind)).length,
      estimatedCostCents: normalized.reduce((sum, beat) => sum + beat.costEstimateCents, 0),
    },
  };
}

function selectEditorialBeats(beats: VisualBeat[], count: number) {
  if (count >= beats.length) return beats;
  const selected = new Set<number>();
  const cinematicIndex = beats.findIndex((beat) => CINEMATIC_KINDS.has(beat.kind));
  const informationIndex = beats.findIndex((beat) => INFORMATION_KINDS.has(beat.kind) || Boolean(beat.sourceVisual));
  if (informationIndex >= 0) selected.add(informationIndex);
  if (cinematicIndex >= 0 && selected.size < count) selected.add(cinematicIndex);
  if (count === 1 && cinematicIndex >= 0) return [beats[cinematicIndex]];
  for (let slot = 0; selected.size < count && slot < count; slot += 1) {
    selected.add(count === 1 ? 0 : Math.round(slot * (beats.length - 1) / (count - 1)));
  }
  for (let index = 0; selected.size < count && index < beats.length; index += 1) selected.add(index);
  return [...selected].sort((left, right) => left - right).slice(0, count).map((index) => beats[index]);
}

function allocateVisualBeatDurations(beats: VisualBeat[], durationMs: number) {
  const durations = beats.map(() => MIN_VISUAL_BEAT_MS);
  let remainingMs = durationMs - durations.reduce((sum, value) => sum + value, 0);
  const cinematicIndexes = beats.map((beat, index) => CINEMATIC_KINDS.has(beat.kind) ? index : -1).filter((index) => index >= 0);
  for (const index of cinematicIndexes) {
    if (remainingMs <= 0) break;
    const addition = Math.min(remainingMs, MAX_VISUAL_BEAT_MS - durations[index]);
    durations[index] += addition;
    remainingMs -= addition;
  }
  while (remainingMs > 0) {
    const expandable = durations.map((value, index) => value < MAX_VISUAL_BEAT_MS ? index : -1).filter((index) => index >= 0);
    if (expandable.length === 0) break;
    const share = Math.max(1, Math.floor(remainingMs / expandable.length));
    for (const index of expandable) {
      if (remainingMs <= 0) break;
      const addition = Math.min(remainingMs, share, MAX_VISUAL_BEAT_MS - durations[index]);
      durations[index] += addition;
      remainingMs -= addition;
    }
  }
  if (remainingMs > 0) durations[durations.length - 1] += remainingMs;
  return durations;
}

function isPdfVisual(beat: VisualBeat) {
  return beat.sourceVisual?.kind === "pdf_page" || beat.sourceVisual?.kind === "pdf_highlight_crop";
}

export function buildMotionCues(durationMs: number) {
  const cues: Array<{ kind: "reveal" | "highlight" | "track" | "cut_in" | "comparison" | "emphasis" | "exit"; atMs: number; durationMs: number }> = [];
  const safeDuration = Math.max(500, durationMs);
  cues.push({ kind: "reveal", atMs: 0, durationMs: Math.min(600, safeDuration) });
  for (let atMs = 1_200; atMs < safeDuration - 500; atMs += 1_300) cues.push({ kind: cues.length % 2 === 0 ? "highlight" : "emphasis", atMs, durationMs: Math.min(500, safeDuration - atMs) });
  if (safeDuration > 1_000) cues.push({ kind: "exit", atMs: Math.max(0, safeDuration - 500), durationMs: 500 });
  return cues;
}

function isChapterBoundary(current: NewsStoryboard["scenes"][number], next: NewsStoryboard["scenes"][number]) {
  return current.sourceIds.join("|") !== next.sourceIds.join("|") || /outlook|conclusion|what happens next|next story/i.test(next.title);
}

function round(value: number) {
  return Math.round(value * 10_000) / 10_000;
}
