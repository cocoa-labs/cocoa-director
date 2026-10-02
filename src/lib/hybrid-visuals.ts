import type {
  HybridVisualPlanV2,
  GraphicFamily,
  NewsStoryboard,
  ProductionCreateRequest,
  QualityTier,
  StoryboardScene,
  VisualBeat,
  VisualBeatKind,
  VisualStylePreset,
  VisualSequencePattern,
} from "@/lib/schemas";
import { PROVIDER_PRICING } from "@/lib/provider-pricing";
import { buildMotionCues } from "@/lib/editorial-timing";
import { editorialMessageExposureMs, usesNaturalDuration } from "@/lib/editorial-duration";

// Technical narration includes acronyms, numbers and sentence pauses. Use a
// conservative first pass; a saved recording supplies the calibrated pace.
export const DEFAULT_NARRATION_WORDS_PER_SECOND = 2;
const NARRATION_RESERVE = 0.08;

const PRESETS = {
  prestige_documentary: {
    palette: ["#07110e", "#d9e3dd", "#75eaa5", "#d8a75d", "#24342f"],
    lighting: "motivated practical light, deep contrast, restrained warm highlights, documentary realism",
    lensLanguage: "measured wides, intimate macro inserts, slow dolly movement, shallow depth of field",
    texture: "fine 35mm grain, atmospheric haze, tactile paper and glass surfaces",
    motifs: ["luminous source lines", "layered documents", "slow parallax depth", "editorial light leaks"],
    transitionLanguage: "motivated match cuts, source-page wipes, short optical dissolves",
    graphicLanguage: "precise newsroom typography, elegant data marks, quiet lower thirds",
  },
  broadcast_energy: {
    palette: ["#06131f", "#f3f7f8", "#58d7ff", "#75eaa5", "#ffb45e"],
    lighting: "clean broadcast contrast, electric edge light, luminous information surfaces",
    lensLanguage: "confident push-ins, fast detail inserts, controlled aerial and lateral movement",
    texture: "polished glass, subtle scan lines, dimensional maps and signal fields",
    motifs: ["signal arcs", "moving grids", "headline bands", "data pulses"],
    transitionLanguage: "graphic matches, directional wipes, energetic but readable cuts",
    graphicLanguage: "high-clarity broadcast information design with dimensional charts and maps",
  },
  cinematic_social: {
    palette: ["#090b12", "#f6f4ee", "#9b7dff", "#64e7c3", "#ff6f91"],
    lighting: "bold cinematic color separation, luminous highlights, dramatic silhouettes",
    lensLanguage: "kinetic close-ups, sweeping reveals, expressive handheld and orbiting moves",
    texture: "rich bloom, glossy reflections, volumetric particles, premium campaign finish",
    motifs: ["light ribbons", "floating type planes", "hero silhouettes", "prismatic transitions"],
    transitionLanguage: "rhythmic match cuts, refractive wipes, fast scale transitions",
    graphicLanguage: "large kinetic type, striking numeric hits, compact mobile-safe citations",
  },
} as const;

export type NarrationPacing = { wordsPerSecond: number; sceneCount?: number };

export function narrationWordBudget(targetDurationSeconds: number, wordsPerSecond = DEFAULT_NARRATION_WORDS_PER_SECOND) {
  return Math.max(20, Math.floor(targetDurationSeconds * wordsPerSecond * (1 - NARRATION_RESERVE)));
}

export function predictedNarrationDurationMs(text: string, wordsPerSecond = DEFAULT_NARRATION_WORDS_PER_SECOND) {
  return Math.max(1_000, Math.round(wordCount(text) / wordsPerSecond * 1_000));
}

export function narrationBudgetSummary(text: string, targetDurationSeconds: number, pacing?: NarrationPacing) {
  const wordsPerSecond = pacing?.wordsPerSecond ?? DEFAULT_NARRATION_WORDS_PER_SECOND;
  const words = wordCount(text.replace(/\[claim:[^\]]+\]/g, ""));
  const budgetWords = narrationWordBudget(targetDurationSeconds, wordsPerSecond);
  const minimumSeconds = Math.max(targetDurationSeconds * 0.75, pacing?.sceneCount ? targetDurationSeconds - pacing.sceneCount * 1.5 : 0);
  const predictedDurationMs = predictedNarrationDurationMs(text.replace(/\[claim:[^\]]+\]/g, ""), wordsPerSecond);
  return {
    words,
    budgetWords,
    wordsPerSecond,
    predictedDurationMs,
    targetDurationMs: targetDurationSeconds * 1_000,
    withinBudget: words <= budgetWords,
    minimumWords: Math.ceil(minimumSeconds * wordsPerSecond),
    minimumCoverage: minimumSeconds / targetDurationSeconds,
    predictedCoverage: predictedDurationMs / (targetDurationSeconds * 1_000),
  };
}

export function buildHybridVisualPlan(input: {
  productionId: string;
  request: Pick<ProductionCreateRequest, "contentType" | "brief" | "qualityTier" | "visualStylePreset" | "targetDurationSeconds" | "aspectRatio">;
  storyboard: NewsStoryboard;
  createdAt: string;
  directionVersion?: 2 | 3 | 4;
}): HybridVisualPlanV2 | undefined {
  if (input.request.contentType !== "news_digest" && input.request.contentType !== "explainer") return undefined;
  const contentType = input.request.contentType;
  const resolvedPreset = resolvePreset(input.request.visualStylePreset, input.request.brief, input.request.aspectRatio);
  const continuityKit = PRESETS[resolvedPreset];
  const chapters = buildChapters(input.storyboard.scenes);
  const chapterByScene = new Map(chapters.flatMap((chapter) => chapter.sceneIds.map((sceneId) => [sceneId, chapter] as const)));
  const beats = input.storyboard.scenes.flatMap((scene, scenePosition) => buildSceneBeats({
    scene,
    scenePosition,
    sceneCount: input.storyboard.scenes.length,
    naturalDuration: usesNaturalDuration(input.request),
    targetDurationMs: input.request.targetDurationSeconds * 1_000,
    qualityTier: input.request.qualityTier,
    contentType,
    resolvedPreset,
    continuityKit,
    chapterId: chapterByScene.get(scene.id)?.id ?? "chapter-01",
    sequencePattern: chapterByScene.get(scene.id)?.sequencePattern ?? SEQUENCE_PATTERNS[scenePosition % SEQUENCE_PATTERNS.length],
  }));
  const targetDurationMs = input.request.targetDurationSeconds * 1_000;
  const cinematicKinds = new Set<VisualBeatKind>(["cinematic_broll", "synthetic_reenactment", "composite"]);
  const cinematicDurationMs = beats
    .filter((beat) => cinematicKinds.has(beat.kind))
    .reduce((sum, beat) => sum + beat.endMs - beat.startMs, 0);
  const staticDurationMs = beats.filter((beat) => beat.hold).reduce((sum, beat) => sum + beat.endMs - beat.startMs, 0);
  const predictedDurationMs = input.storyboard.scenes.reduce((sum, scene) => sum + predictedNarrationDurationMs(scene.narration), 0);
  return {
    version: input.directionVersion ?? 4,
    productionId: input.productionId,
    contentType,
    requestedPreset: input.request.visualStylePreset,
    resolvedPreset,
    qualityTier: input.request.qualityTier,
    continuityKit: {
      palette: [...continuityKit.palette],
      lighting: continuityKit.lighting,
      lensLanguage: continuityKit.lensLanguage,
      texture: continuityKit.texture,
      motifs: [...continuityKit.motifs],
      transitionLanguage: continuityKit.transitionLanguage,
      graphicLanguage: continuityKit.graphicLanguage,
    },
    beats,
    metrics: {
      cinematicCoverage: roundRatio(cinematicDurationMs / targetDurationMs),
      staticCoverage: roundRatio(staticDurationMs / targetDurationMs),
      cinematicBeatCount: beats.filter((beat) => cinematicKinds.has(beat.kind)).length,
      evidenceBeatCount: beats.filter((beat) => beat.kind === "documentary_source" || beat.kind === "document_excerpt" || beat.kind === "data_visualization").length,
      estimatedCostCents: beats.reduce((sum, beat) => sum + beat.costEstimateCents, 0),
      predictedNarrationDurationMs: predictedDurationMs,
      targetDurationMs,
    },
    createdAt: input.createdAt,
    chapters,
    noveltyLedger: buildNoveltyLedger(beats),
  };
}

export function attachVisualPlanToStoryboard(storyboard: NewsStoryboard, plan?: HybridVisualPlanV2): NewsStoryboard {
  if (!plan) return storyboard;
  return {
    ...storyboard,
    scenes: storyboard.scenes.map((scene) => {
      const beats = plan.beats.filter((beat) => beat.sceneId === scene.id);
      const visualKind = beats.some((beat) => isCinematicKind(beat.kind))
        ? "video" as const
        : beats.some((beat) => beat.kind === "editorial_image")
          ? "image" as const
          : scene.visualKind;
      return { ...scene, visualKind, beats };
    }),
  };
}

export function withUpdatedVisualBeat(plan: HybridVisualPlanV2, beatId: string, patch: Partial<VisualBeat>) {
  const beats = plan.beats.map((beat) => {
    if (beat.id !== beatId) return beat;
    const updated = { ...beat, ...patch, id: beat.id, sceneId: beat.sceneId };
    if (patch.kind) {
      updated.providerRoute = providerRouteFor(patch.kind, plan.qualityTier);
      updated.disclosure = patch.kind === "synthetic_reenactment"
        ? { required: true, persistent: true, label: "AI-GENERATED REENACTMENT", reason: "Synthetic current-event reconstruction; illustrative and not source evidence.", publicFigures: beat.disclosure.publicFigures, currentEvent: true }
        : { required: false, persistent: false, publicFigures: [], currentEvent: false };
      updated.generationPrompt = needsGeneratedAsset(patch.kind)
        ? updated.generationPrompt ?? `Cocoa Director ${plan.resolvedPreset.replaceAll("_", " ")} editorial visual. ${updated.intent} Lighting: ${plan.continuityKit.lighting}. Lens language: ${plan.continuityKit.lensLanguage}. Do not add text, quotations, logos, interfaces, or unsupported actions. This is editorial visualization, never source evidence.`
        : undefined;
      updated.assets = [];
    }
    return {
      ...updated,
      costEstimateCents: costForBeat(updated.kind, Math.max(4, Math.min(15, Math.ceil((updated.endMs - updated.startMs) / 1_000))), plan.qualityTier),
    };
  });
  return HybridPlanMetrics.recalculate({ ...plan, beats });
}

export function recalculateHybridVisualPlan(plan: HybridVisualPlanV2) {
  return HybridPlanMetrics.recalculate({
    ...plan,
    beats: plan.beats.map((beat) => ({
      ...beat,
      costEstimateCents: costForBeat(beat.kind, Math.max(4, Math.min(15, Math.ceil((beat.endMs - beat.startMs) / 1_000))), plan.qualityTier),
    })),
  });
}

export function applyValidatedLikenessRouting(plan: HybridVisualPlanV2, likenessRouteValidated: boolean) {
  if (likenessRouteValidated) return plan;
  return HybridPlanMetrics.recalculate({
    ...plan,
    beats: plan.beats.map((beat): VisualBeat => beat.kind === "synthetic_reenactment" ? {
      ...beat,
      kind: "cinematic_broll",
      intent: "Translate the supported claim into a conceptual, people-free cinematic editorial visualization",
      generationPrompt: [
        "Premium conceptual editorial visualization using environments, objects, architecture, documents, machines, maps, or abstract physical metaphors.",
        "No people, faces, bodies, hands, portraits, public figures, crowds, silhouettes, names, quotations, logos, captions, or interface text.",
        "Preserve the approved continuity palette, lighting, lens language, and atmosphere. Illustrative context only; never documentary evidence.",
      ].join(" "),
      disclosure: { required: false, persistent: false, publicFigures: [], currentEvent: false },
      providerRoute: { ...beat.providerRoute, fallback: "approved_equivalent" },
      assets: [],
    } : beat),
  });
}

const HybridPlanMetrics = {
  recalculate(plan: HybridVisualPlanV2): HybridVisualPlanV2 {
    const target = plan.metrics.targetDurationMs;
    const cinematic = plan.beats.filter((beat) => isCinematicKind(beat.kind));
    return {
      ...plan,
      metrics: {
        ...plan.metrics,
        cinematicCoverage: roundRatio(cinematic.reduce((sum, beat) => sum + beat.endMs - beat.startMs, 0) / target),
        staticCoverage: roundRatio(plan.beats.filter((beat) => beat.hold).reduce((sum, beat) => sum + beat.endMs - beat.startMs, 0) / target),
        cinematicBeatCount: cinematic.length,
        evidenceBeatCount: plan.beats.filter((beat) => ["documentary_source", "document_excerpt", "data_visualization"].includes(beat.kind)).length,
        estimatedCostCents: plan.beats.reduce((sum, beat) => sum + beat.costEstimateCents, 0),
      },
    };
  },
};

function buildSceneBeats(input: {
  naturalDuration?: boolean;
  scene: StoryboardScene;
  scenePosition: number;
  sceneCount: number;
  targetDurationMs: number;
  qualityTier: QualityTier;
  contentType: "news_digest" | "explainer";
  resolvedPreset: Exclude<VisualStylePreset, "auto">;
  continuityKit: (typeof PRESETS)[Exclude<VisualStylePreset, "auto">];
  chapterId: string;
  sequencePattern: VisualSequencePattern;
}) {
  const durationMs = input.scene.endMs - input.scene.startMs;
  const standardCinematicSceneCount = Math.min(input.sceneCount, Math.max(1, Math.round(input.targetDurationMs / 1_000 * 7 / 60)));
  const allowStandardCinema = input.qualityTier !== "standard" || input.scenePosition < standardCinematicSceneCount;
  const shortStandardScene = durationMs <= 6_000;
  const standardCount = shortStandardScene
    ? !allowStandardCinema ? 1 : input.scenePosition === standardCinematicSceneCount - 1 ? 2 : 1
    : !allowStandardCinema ? 2 : durationMs <= 9_000 ? 2 : durationMs <= 12_000 ? 3 : durationMs <= 18_000 ? 4 : 5;
  const premiumCount = durationMs <= 9_000 ? 2 : durationMs <= 14_000 ? 3 : durationMs <= 18_000 ? 4 : 5;
  const naturalCount = Math.max(1, Math.ceil(durationMs / 6_000), Math.min(Math.ceil(durationMs / 5_000), Math.floor(durationMs / editorialMessageExposureMs(input.scene.title))));
  const count = input.naturalDuration ? Math.min(400, naturalCount) : input.qualityTier === "draft" ? Math.min(2, Math.max(1, Math.ceil(durationMs / 5_000))) : input.qualityTier === "premium" ? premiumCount : standardCount;
  const weights = input.naturalDuration ? undefined : input.qualityTier === "premium"
    ? count === 2 ? [0.267, 0.733]
      : count === 3 ? [0.2, 0.4, 0.4]
        : count === 4 ? [0.15, 0.35, 0.35, 0.15]
          : [0.12, 0.2533, 0.2534, 0.2533, 0.12]
    : input.qualityTier === "standard"
      ? !allowStandardCinema ? count === 1 ? [1] : [0.5, 0.5]
        : count === 1 ? [1]
          : count === 2 ? [0.4, 0.6]
          : count === 3 ? [0.225, 0.55, 0.225]
            : count === 4 ? [0.2, 0.3, 0.3, 0.2]
              : [0.15, 0.2333, 0.2334, 0.2333, 0.15]
      : undefined;
  const frames = splitRange(input.scene.startMs, input.scene.endMs, count, weights);
  return frames.map(({ startMs, endMs }, index): VisualBeat => {
    const kind = directedBeatKind(input.scene, input.scenePosition, index, count, input.qualityTier, input.contentType, allowStandardCinema);
    const disclosure = disclosureFor(kind, input.scene);
    const durationSeconds = Math.max(4, Math.min(15, Math.ceil((endMs - startMs) / 1_000)));
    const providerRoute = providerRouteFor(kind, input.qualityTier);
    const shotSpec = isCinematicKind(kind) || kind === "editorial_image"
      ? shotSpecFor(input.scene, input.scenePosition, index, input.sequencePattern, kind)
      : undefined;
    const graphicSpec = isInformationKind(kind)
      ? graphicSpecFor(input.scene, input.scenePosition, index)
      : kind === "composite" ? graphicSpecFor(input.scene, input.scenePosition, index, true) : undefined;
    const basePrompt = needsGeneratedAsset(kind)
      ? generationPrompt(kind, input.scene, input.resolvedPreset, input.continuityKit, disclosure)
      : undefined;
    return {
      id: `${input.scene.id}-beat-${String(index + 1).padStart(2, "0")}`,
      sceneId: input.scene.id,
      index,
      startMs,
      endMs,
      kind,
      intent: visualIntent(kind, input.scene, index),
      evidenceIds: [...input.scene.claimIds],
      sourceIds: [...input.scene.sourceIds],
      generationPrompt: basePrompt && shotSpec
        ? `${basePrompt} Shot specification: ${shotSpec.size} at ${shotSpec.angle}; ${shotSpec.focalLength}; ${shotSpec.composition}; ${shotSpec.cameraMovement}; ${shotSpec.narrativeFunction}. The specific subject is ${shotSpec.subject}; the setting is ${shotSpec.setting}; the supported action is ${shotSpec.action}.`.slice(0, 1_990)
        : basePrompt,
      motionDirection: motionFor(kind, index, input.resolvedPreset),
      providerRoute,
      disclosure,
      costEstimateCents: costForBeat(kind, durationSeconds, input.qualityTier),
      locked: false,
      hold: false,
      assets: [],
      chapterId: input.chapterId,
      sequencePattern: input.sequencePattern,
      shotSpec,
      graphicSpec,
      sourceVisual: undefined,
      motionCues: buildMotionCues(endMs - startMs),
      fullScreen: isInformationKind(kind) && endMs - startMs <= 3_000,
      reusePolicy: { mode: "unique", approved: false, minimumSeparationMs: 30_000 },
    };
  });
}

function directedBeatKind(scene: StoryboardScene, scenePosition: number, index: number, count: number, tier: QualityTier, contentType: "news_digest" | "explainer", allowStandardCinema = true): VisualBeatKind {
  if (tier === "draft") {
    if (scene.visualKind === "document" && index === 0) return "document_excerpt";
    return scenePosition % 3 === 0 ? "document_excerpt" : scenePosition % 3 === 1 ? "data_visualization" : "editorial_image";
  }
  const informationKind = scene.visualKind === "document" || scenePosition % 5 === 0
    ? "document_excerpt" as const
    : scenePosition % 4 === 1 ? "data_visualization" as const
      : scenePosition % 4 === 2 ? "documentary_source" as const : "data_visualization" as const;
  if (tier === "standard") {
    if (count === 1) return allowStandardCinema ? "composite" : informationKind;
    const cinematicIndex = allowStandardCinema && (count === 2 ? index === 1 : index > 0 && index < count - 1);
    if (!cinematicIndex) return index === 0 ? informationKind : scene.visualKind === "document" ? "document_excerpt" : "documentary_source";
    if (contentType === "news_digest" && callsForReenactment(scene)) return "synthetic_reenactment";
    return "cinematic_broll";
  }
  if (index === 0 || (count >= 4 && index === count - 1)) return informationKind;
  if (index === 2 && scenePosition % 3 === 1) return "composite";
  if (contentType === "news_digest" && callsForReenactment(scene) && index === 0) return "synthetic_reenactment";
  return "cinematic_broll";
}

const SEQUENCE_PATTERNS: VisualSequencePattern[] = [
  "wide_evidence_detail_consequence",
  "process_cutin_mechanism_implication",
  "source_diagram_application",
  "comparison_contrast_synthesis",
  "hook_context_reveal",
];

const SHOT_SIZES = ["extreme_wide", "wide", "medium", "close", "insert", "extreme_close"] as const;
const CAMERA_MOVES = ["dolly", "track", "macro_drift", "orbit", "push_in", "crane", "handheld", "pull_out"] as const;
const TRANSITIONS = ["hard_cut", "cut_in", "match_cut", "source_wipe", "j_cut", "l_cut", "cut_out", "dissolve"] as const;
function buildChapters(scenes: StoryboardScene[]) {
  const desired = Math.max(1, Math.min(9, scenes.length >= 12 ? 6 : scenes.length));
  return Array.from({ length: desired }, (_, index) => {
    const start = Math.floor(index * scenes.length / desired);
    const end = Math.floor((index + 1) * scenes.length / desired);
    const chapterScenes = scenes.slice(start, Math.max(start + 1, end));
    return {
      id: `chapter-${String(index + 1).padStart(2, "0")}`,
      title: chapterScenes[0]?.title ?? `Chapter ${index + 1}`,
      sceneIds: chapterScenes.map((scene) => scene.id),
      sequencePattern: SEQUENCE_PATTERNS[index % SEQUENCE_PATTERNS.length],
    };
  });
}

function shotSpecFor(scene: StoryboardScene, scenePosition: number, beatIndex: number, pattern: VisualSequencePattern, kind: VisualBeatKind): VisualBeat["shotSpec"] {
  const offset = scenePosition + beatIndex * 2;
  const size = SHOT_SIZES[offset % SHOT_SIZES.length];
  const movement = CAMERA_MOVES[(offset + Math.floor(scenePosition / 2)) % CAMERA_MOVES.length];
  const transition = TRANSITIONS[(scenePosition + beatIndex * 2) % TRANSITIONS.length];
  return {
    size,
    angle: scenePosition % 7 === 3 ? "overhead" : scenePosition % 5 === 2 ? "low" : "eye_level",
    subject: scene.title,
    setting: scene.visual,
    action: scene.narration.split(/[.!?]/)[0]?.trim().slice(0, 380) || `Reveal the mechanism behind ${scene.title}`,
    composition: compositionFor(pattern, size),
    focalLength: size === "extreme_wide" || size === "wide" ? "24–35mm environmental perspective" : size === "close" || size === "extreme_close" || size === "insert" ? "85–100mm tactile detail" : "50mm natural perspective",
    cameraMovement: movement,
    transition,
    narrativeFunction: narrativeFunctionFor(pattern, beatIndex),
    evidenceBoundary: kind === "synthetic_reenactment" ? "reenactment" : kind === "editorial_image" ? "editorial_illustration" : "conceptual",
  };
}

function graphicSpecFor(scene: StoryboardScene, scenePosition: number, beatIndex: number, composite = false): VisualBeat["graphicSpec"] {
  const values = extractStructuredValues(scene.narration, scene.claimIds);
  const dataFamilies: GraphicFamily[] = ["hero_number", "magnitude_comparison", "change_over_time", "ranking", "part_to_whole"];
  const nonDataFamilies: GraphicFamily[] = scene.visualKind === "document"
    ? ["source_excerpt", "timeline", "process_flow", "relationship_network"]
    : ["process_flow", "relationship_network", "source_excerpt", "timeline", "geographic_map"];
  const candidates = values.length > 0 ? [...dataFamilies, ...nonDataFamilies] : nonDataFamilies;
  const family = candidates[(scenePosition + beatIndex * 3) % candidates.length];
  return {
    family,
    title: scene.title,
    values: dataFamilies.includes(family) ? values : [],
    sourceTreatment: values.length === 0 ? "Use cited labels and relationships; do not invent quantitative marks." : "Preserve cited units and contextual baseline.",
    overlayPlacement: composite ? (scenePosition % 2 === 0 ? "right" : "left") : (["left", "right", "bottom", "split"] as const)[scenePosition % 4],
  };
}

function extractStructuredValues(text: string, evidenceIds: string[]) {
  const matches = [...text.matchAll(/(?:\$|£|€)?\b\d[\d,.]*(?:\.\d+)?\s*(?:%|percent|million|billion|trillion|thousand|years?|months?|days?|hours?)?/gi)].slice(0, 4);
  return matches.map((match, index) => {
    const raw = match[0];
    const numeric = Number(raw.replace(/[^\d.]/g, ""));
    const unit = raw.replace(/[\d.,\s]/g, "").trim() || undefined;
    return {
      label: index === 0 ? "Reported figure" : `Reported figure ${index + 1}`,
      value: Number.isFinite(numeric) ? numeric : 0,
      unit,
      evidenceId: evidenceIds[Math.min(index, Math.max(0, evidenceIds.length - 1))] ?? "scene-evidence",
    };
  }).filter((value) => Number.isFinite(value.value));
}

function compositionFor(pattern: VisualSequencePattern, size: string) {
  if (pattern === "wide_evidence_detail_consequence") return size.includes("wide") ? "environment establishes scale with clear foreground, midground, and background" : "single tactile detail isolates the consequence";
  if (pattern === "process_cutin_mechanism_implication") return "directional composition follows the process from cause to mechanism";
  if (pattern === "source_diagram_application") return "source-inspired geometry creates negative space for verified overlays";
  if (pattern === "comparison_contrast_synthesis") return "balanced opposing visual fields converge toward a synthesis point";
  return "immediate visual hook resolves into legible context and a clean reveal";
}

function narrativeFunctionFor(pattern: VisualSequencePattern, beatIndex: number) {
  const functions: Record<VisualSequencePattern, string[]> = {
    wide_evidence_detail_consequence: ["establish scale", "ground in evidence", "reveal consequential detail"],
    process_cutin_mechanism_implication: ["orient the process", "cut into the mechanism", "show real-world implication"],
    source_diagram_application: ["establish the source", "explain structure", "show application"],
    comparison_contrast_synthesis: ["frame the comparison", "contrast the environments", "synthesize meaning"],
    hook_context_reveal: ["create the hook", "supply context", "deliver the reveal"],
  };
  return functions[pattern][beatIndex % functions[pattern].length];
}

function isInformationKind(kind: VisualBeatKind) {
  return kind === "documentary_source" || kind === "document_excerpt" || kind === "data_visualization";
}

function buildNoveltyLedger(beats: VisualBeat[]) {
  return {
    subjects: countValues(beats.map((beat) => beat.shotSpec?.subject)),
    settings: countValues(beats.map((beat) => beat.shotSpec?.setting)),
    shotSizes: countValues(beats.map((beat) => beat.shotSpec?.size)),
    cameraMoves: countValues(beats.map((beat) => beat.shotSpec?.cameraMovement)),
    graphicFamilies: countValues(beats.map((beat) => beat.graphicSpec?.family)),
    transitions: countValues(beats.map((beat) => beat.shotSpec?.transition)),
  };
}

function countValues(values: Array<string | undefined>) {
  return values.reduce<Record<string, number>>((counts, value) => {
    if (value) counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function resolvePreset(requested: VisualStylePreset, brief: string, aspectRatio: ProductionCreateRequest["aspectRatio"]): Exclude<VisualStylePreset, "auto"> {
  if (requested !== "auto") return requested;
  if (aspectRatio === "9:16" || /social|vertical|reel|short|viral/i.test(brief)) return "cinematic_social";
  if (/breaking|roundup|market|sports|election|live update/i.test(brief)) return "broadcast_energy";
  return "prestige_documentary";
}

function providerRouteFor(kind: VisualBeatKind, tier: QualityTier): VisualBeat["providerRoute"] {
  if (!needsGeneratedAsset(kind)) return { fallback: "review_required" };
  if (kind === "editorial_image") return { image: "gpt-image-2", fallback: "retry_same" };
  return {
    image: "gpt-image-2",
    video: tier === "premium" ? "bytedance/seedance-2.0/reference-to-video" : "bytedance/seedance-2.0/fast/reference-to-video",
    resolution: tier === "premium" ? "1080p" : "720p",
    tier: tier === "premium" ? "standard" : "fast",
    fallback: "review_required",
  };
}

function costForBeat(kind: VisualBeatKind, durationSeconds: number, tier: QualityTier) {
  if (!needsGeneratedAsset(kind)) return 0;
  if (kind === "editorial_image") return 8;
  const rate = tier === "premium"
    ? PROVIDER_PRICING.seedance.standard1080PerSecondUsd
    : PROVIDER_PRICING.seedance.fast720PerSecondUsd;
  return Math.round((0.08 + durationSeconds * rate) * 100);
}

function disclosureFor(kind: VisualBeatKind, scene: StoryboardScene): VisualBeat["disclosure"] {
  if (kind !== "synthetic_reenactment") return { required: false, persistent: false, publicFigures: [], currentEvent: false };
  const publicFigures = extractLikelyPublicFigures(`${scene.title} ${scene.narration}`);
  return {
    required: true,
    label: "AI-GENERATED REENACTMENT",
    persistent: true,
    reason: "Synthetic depiction of a named person or current event; it is illustrative and not source footage.",
    publicFigures,
    currentEvent: true,
  };
}

function callsForReenactment(scene: StoryboardScene) {
  return /\b(said|announced|met|signed|launched|acquired|agreed|testified|spoke|president|minister|ceo|founder|senator|candidate)\b/i.test(`${scene.title} ${scene.narration}`);
}

function extractLikelyPublicFigures(text: string) {
  const candidates = text.match(/\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,}){1,2}\b/g) ?? [];
  const excluded = /^(Cocoa News|United States|Artificial Intelligence|Power Pressure|Funding Roundup)$/;
  return [...new Set(candidates.filter((candidate) => !excluded.test(candidate)))].slice(0, 6);
}

function generationPrompt(
  kind: VisualBeatKind,
  scene: StoryboardScene,
  preset: Exclude<VisualStylePreset, "auto">,
  continuityKit: (typeof PRESETS)[Exclude<VisualStylePreset, "auto">],
  disclosure: VisualBeat["disclosure"],
) {
  const evidenceBoundary = "Create editorial illustration, never documentary evidence. Do not add words, captions, logos, quotations, interfaces, or unverifiable actions inside the generated image.";
  const reenactment = kind === "synthetic_reenactment"
    ? `This is a clearly disclosed synthetic reenactment. ${disclosure.publicFigures.length > 0 ? `Depict ${disclosure.publicFigures.join(", ")} recognizably but respectfully, without invented speech or sensational conduct.` : "Use a respectful reconstructed current-event scene."}`
    : "Use metaphor, environment, objects, and cinematic human activity to illuminate the subject.";
  return [
    `Cocoa Director ${preset.replaceAll("_", " ")} visual for: ${scene.title}.`,
    `Narrative context: ${scene.narration}`,
    `Visual direction: ${scene.visual}`,
    reenactment,
    `Lighting: ${continuityKit.lighting}. Lens language: ${continuityKit.lensLanguage}. Texture: ${continuityKit.texture}.`,
    `Motifs: ${continuityKit.motifs.join(", ")}. Premium cinematic composition, atmospheric depth, coherent subject scale, no baked-in text.`,
    evidenceBoundary,
  ].join(" ").slice(0, 1_980);
}

function visualIntent(kind: VisualBeatKind, scene: StoryboardScene, index: number) {
  const labels: Record<VisualBeatKind, string> = {
    documentary_source: "Ground the narration in cleared documentary source material",
    document_excerpt: "Reveal the source document as tactile evidence with restrained parallax",
    data_visualization: "Turn the supported claim into a dimensional, readable information graphic",
    editorial_image: "Create a coherent editorial key visual with cinematic depth",
    cinematic_broll: "Build emotional context through atmospheric cinematic motion",
    synthetic_reenactment: "Illustrate the supported event as a persistently labeled synthetic reconstruction",
    composite: "Layer cinema and factual information in the same authored frame",
  };
  return `${labels[kind]} for “${scene.title}” (visual beat ${index + 1}).`;
}

function motionFor(kind: VisualBeatKind, index: number, preset: Exclude<VisualStylePreset, "auto">) {
  if (kind === "data_visualization") return "Animate data marks in evidence order; use a slow dimensional push without obscuring labels.";
  if (kind === "document_excerpt" || kind === "documentary_source") return "Use shallow parallax, a controlled source highlight, and a gentle lateral camera drift.";
  if (kind === "editorial_image") return "Use layered 2.5D parallax, atmospheric particles, and a restrained 6% push-in.";
  const camera = preset === "cinematic_social" ? "kinetic orbit and expressive close detail" : preset === "broadcast_energy" ? "confident lateral track and fast detail reveal" : "measured dolly with intimate inserts";
  return `${camera}; preserve subject coherence and finish on a clean editorial composition${index % 2 ? " with a subtle rack focus" : ""}.`;
}

function needsGeneratedAsset(kind: VisualBeatKind) {
  return kind === "editorial_image" || kind === "cinematic_broll" || kind === "synthetic_reenactment" || kind === "composite";
}

function isCinematicKind(kind: VisualBeatKind) {
  return kind === "cinematic_broll" || kind === "synthetic_reenactment" || kind === "composite";
}

function splitRange(startMs: number, endMs: number, count: number, weights?: number[]) {
  const duration = endMs - startMs;
  if (weights?.length === count) {
    const total = weights.reduce((sum, value) => sum + value, 0);
    let cursor = startMs;
    return weights.map((weight, index) => {
      const end = index === weights.length - 1 ? endMs : Math.round(cursor + duration * weight / total);
      const range = { startMs: cursor, endMs: end };
      cursor = end;
      return range;
    });
  }
  return Array.from({ length: count }, (_, index) => ({
    startMs: Math.round(startMs + duration * index / count),
    endMs: Math.round(startMs + duration * (index + 1) / count),
  }));
}

function wordCount(text: string) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function roundRatio(value: number) {
  return Number(Math.max(0, Math.min(1, value)).toFixed(3));
}
