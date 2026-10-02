import type {
  EditorialPlan,
  NewsStoryboard,
  ProductionCreateRequest,
  QAReport,
  SourceBundle,
  TimelineManifestV2,
} from "@/lib/schemas";
import { isExplicitBreakingClaim } from "@/lib/news-claims";
import { narrationWordBudget } from "@/lib/hybrid-visuals";
import { validateTimeline } from "@/lib/production";
import { isSourceMetadata, selectExplainerUnits, sourceSentences } from "@/lib/source-content";
import { estimateNaturalSeconds, sourceCoverageOutline, usesNaturalDuration } from "@/lib/editorial-duration";

export type SourceFirstDraft = {
  sourceBundle: SourceBundle;
  outline: Array<{ id: string; title: string; narration: string; visual: string; claimIds: string[]; sourceIds: string[] }>;
  script: string;
  editorialPlan: EditorialPlan;
  storyboard: NewsStoryboard;
  timeline: TimelineManifestV2;
  qaReport: QAReport;
};

export type SourceFirstOutlineScene = SourceFirstDraft["outline"][number];

function groupCoverageUnits<T extends { sentence: string; claimId?: string }>(units: T[], coverage: ReturnType<typeof sourceCoverageOutline>) {
  const roles = new Map(coverage.map((point) => [point.claimId, point.role]));
  const groups: T[][] = [];
  for (const unit of units) {
    const last = groups.at(-1);
    const sameConcept = last && roles.get(last[0].claimId ?? "") === roles.get(unit.claimId ?? "");
    if (last && ((sameConcept && last.reduce((n, item) => n + item.sentence.split(/\s+/).length, 0) < 80) || groups.length >= 40)) last.push(unit);
    else groups.push([unit]);
  }
  return groups;
}

export function buildSourceFirstDraft(
  productionId: string,
  input: ProductionCreateRequest,
  now = new Date().toISOString(),
  preferredOutline?: SourceFirstOutlineScene[],
  wordsPerSecond?: number,
): SourceFirstDraft {
  const natural = usesNaturalDuration(input);
  const coverage = natural ? sourceCoverageOutline(input.sourceBundle, input.excludedClaimIds) : [];
  const supportedClaims = input.sourceBundle.claims.filter((claim) => natural ? coverage.some((point) => point.claimId === claim.id && point.included) : claim.status === "supported" && claim.editorialStatus !== "excluded");
  if (natural && coverage.length > 0 && supportedClaims.length === 0) throw new Error("Select at least one supported source point for the outline.");
  const sourceUnits: Array<{ sentence: string; sourceId: string; kind: string; claimId?: string; sourceIds?: string[] }> = (input.contentType === "explainer" || natural) && supportedClaims.length
    ? supportedClaims.map((claim) => ({ sentence: claim.text, sourceId: claim.sourceIds[0], sourceIds: claim.sourceIds, kind: "text", claimId: claim.id }))
    : input.sourceBundle.inputs.flatMap((source) => {
    const text = source.kind === "text" ? source.text : source.extractedText;
    if (!text) return [];
    return (input.contentType === "explainer" ? sourceSentences(text) : splitSentences(text)).map((sentence) => ({ sentence, sourceId: source.id, kind: source.kind }));
  });
  if (sourceUnits.length === 0) {
    if (input.contentType === "explainer" && input.sourceBundle.inputs.length > 0) throw new Error("The supplied sources contain no readable article body. Paste the full text or upload a PDF.");
    sourceUnits.push({ sentence: input.brief, sourceId: "brief", kind: "text" });
  }

  const targetWords = narrationWordBudget(input.targetDurationSeconds);
  const selected = natural ? sourceUnits : input.contentType === "explainer" ? selectExplainerUnits(sourceUnits, targetWords) : selectToWordBudget(sourceUnits, targetWords);
  if (!selected.length) throw new Error("The source cannot form a complete narration within this duration. Supply concise notes or increase the duration.");
  const sceneCount = Math.min(40, Math.max(input.contentType === "news_digest" ? 6 : 3, Math.round(input.targetDurationSeconds / 10)));
  // Keep conceptual chapters together. Runtime never determines their count.
  const grouped = natural ? groupCoverageUnits(selected, coverage) : partition(selected, Math.min(sceneCount, selected.length));
  const outline = preferredOutline ?? grouped.map((group, index) => {
    const narration = group.map((unit) => unit.sentence).join(" ");
    const id = `scene-${String(index + 1).padStart(2, "0")}`;
    return {
      id,
      title: natural ? naturalSceneTitle(narration, coverage.find((point) => point.claimId === group[0]?.claimId)?.role) : sceneTitle(narration, index),
      narration,
      visual: visualTreatmentFor(narration, index),
      claimIds: group.every((unit) => unit.claimId) ? group.map((unit) => unit.claimId!) : splitSentences(narration).map((_, sentenceIndex) => `claim-${id}-${sentenceIndex + 1}`),
      sourceIds: [...new Set(group.flatMap((unit) => unit.sourceIds ?? [unit.sourceId]))],
    };
  });
  const script = outline.map((scene) => scene.narration).join("\n\n");
  const durationMs = (natural ? estimateNaturalSeconds(outline, wordsPerSecond) : input.targetDurationSeconds) * 1_000;
  const timeline = buildGraphicsTimeline(productionId, input, outline, durationMs, now);
  const sourceBundle = withDerivedClaims(input.sourceBundle, input.contentType, outline, now);
  const qaReport = validateTimeline({ timeline, sourceBundle, checkedAt: now });
  const editorialPlan: EditorialPlan = {
    version: 1,
    digestMode: input.digestMode,
    title: outline[0]?.title ?? "News digest",
    dek: input.brief.slice(0, 500),
    scenes: outline,
    createdAt: now,
  };
  const graphics = timeline.tracks.find((track) => track.kind === "graphics")?.segments ?? [];
  const inputKinds = new Map(input.sourceBundle.inputs.map((source) => [source.id, source.kind]));
  const storyboard: NewsStoryboard = {
    version: 1,
    scenes: outline.map((scene, index) => ({
      ...scene,
      startMs: graphics[index]?.startMs ?? 0,
      endMs: graphics[index]?.endMs ?? durationMs,
      visualKind: scene.sourceIds.some((sourceId) => inputKinds.get(sourceId) === "document") ? "document" : "graphic",
      sourceVisualId: scene.sourceIds.find((sourceId) => inputKinds.get(sourceId) === "document"),
      syntheticLabelRequired: false,
      citationLabels: scene.sourceIds.filter((sourceId) => sourceId !== "brief"),
      beats: [],
    })),
    createdAt: now,
  };
  return { sourceBundle, outline, script, editorialPlan, storyboard, timeline, qaReport };
}

function buildGraphicsTimeline(
  productionId: string,
  input: ProductionCreateRequest,
  outline: SourceFirstDraft["outline"],
  durationMs: number,
  compiledAt: string,
): TimelineManifestV2 {
  const weights = outline.map((scene) => Math.max(1, scene.narration.split(/\s+/).length));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const baseDuration = Math.floor(durationMs / outline.length);
  let cursor = 0;
  const graphics = outline.map((scene, index) => {
    const endMs = index === outline.length - 1 ? durationMs : cursor + (usesNaturalDuration(input) ? Math.floor(durationMs * weights[index] / totalWeight) : baseDuration);
    const segment = {
      id: scene.id,
      trackId: "graphics-main",
      kind: "graphic" as const,
      startMs: cursor,
      endMs,
      sourceInMs: 0,
      usableInMs: 0,
      handleInMs: index === 0 ? 0 : 180,
      handleOutMs: index === outline.length - 1 ? 0 : 180,
      hold: false,
      transitionIn: {
        type: (index === 0 ? "cut" : "graphic_match") as "cut" | "graphic_match",
        durationMs: index === 0 ? 0 : 180,
      },
      transitionOut: { type: "cut" as const, durationMs: 0 },
      metadata: {
        title: scene.title,
        narration: scene.narration,
        visual: scene.visual,
        sourceIds: scene.sourceIds,
      },
    };
    cursor = endMs;
    return segment;
  });
  const captions = outline.map((scene, index) => ({
    id: `caption-${scene.id}`,
    trackId: "captions-main",
    kind: "caption" as const,
    startMs: graphics[index].startMs,
    endMs: graphics[index].endMs,
    sourceInMs: 0,
    usableInMs: 0,
    hold: false,
    metadata: { text: scene.narration, sourceIds: scene.sourceIds },
  }));
  return {
    version: 2,
    productionId,
    contentType: input.contentType,
    durationMs,
    fps: 30,
    aspectRatio: input.aspectRatio,
    tracks: [
      { id: "graphics-main", kind: "graphics", segments: graphics },
      { id: "captions-main", kind: "captions", segments: captions },
    ],
    compiledAt,
  };
}

function withDerivedClaims(
  sourceBundle: SourceBundle,
  contentType: ProductionCreateRequest["contentType"],
  outline: SourceFirstDraft["outline"],
  asOf: string,
): SourceBundle {
  if (!["news_digest", "explainer"].includes(contentType) || sourceBundle.claims.length > 0) return sourceBundle;
  const sourceKinds = new Map(sourceBundle.inputs.map((source) => [source.id, source.kind]));
  return {
    ...sourceBundle,
    asOf: sourceBundle.asOf ?? asOf,
    claims: outline.flatMap((scene) => splitSentences(scene.narration).map((sentence, sentenceIndex) => {
      const evidenceSourceIds = scene.sourceIds.filter((sourceId) => {
        const source = sourceBundle.inputs.find((input) => input.id === sourceId);
        const text = source?.kind === "text" ? source.text : source?.extractedText;
        return text?.replace(/\s+/g, " ").includes(sentence.replace(/\s+/g, " "));
      });
      const independentlySourced = evidenceSourceIds.some((sourceId) => sourceId !== "brief" && sourceKinds.has(sourceId));
      const breaking = isExplicitBreakingClaim(sentence);
      const sufficientlyCorroborated = !breaking || new Set(evidenceSourceIds).size >= 2;
      return {
        id: `claim-${scene.id}-${sentenceIndex + 1}`,
        text: sentence,
        sourceIds: evidenceSourceIds,
        asOf,
        confidence: independentlySourced && sufficientlyCorroborated ? 0.75 : 0.35,
        status: independentlySourced && sufficientlyCorroborated ? "supported" as const : breaking && independentlySourced ? "contested" as const : "unverified" as const,
        evidence: independentlySourced ? [sentence.slice(0, 1_000)] : [],
        evidenceRefs: independentlySourced ? evidenceSourceIds
          .filter((sourceId) => sourceId !== "brief")
          .map((sourceId) => ({
            sourceId,
            excerpt: sentence.slice(0, 1_000),
            excerptHash: deterministicExcerptHash(sentence),
          })) : [],
        editorialStatus: "draft" as const,
        independenceGroup: evidenceSourceIds.join("|"),
        breaking,
      };
    })),
  };
}

function deterministicExcerptHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0).toString(16).padStart(16, "0");
}

function selectToWordBudget<T extends { sentence: string }>(units: T[], targetWords: number): T[] {
  const selected: T[] = [];
  let words = 0;
  for (const unit of units) {
    selected.push(unit);
    words += unit.sentence.split(/\s+/).filter(Boolean).length;
    if (words >= targetWords) break;
  }
  return selected;
}

function splitSentences(value: string) {
  return value
    .split(/\n+|(?<=[.!?])\s+/)
    .map((sentence) => sentence.replace(/\s+/g, " ").trim())
    .filter((sentence) => sentence.length > 0 && !isPageChrome(sentence));
}

function isPageChrome(value: string) {
  return isSourceMetadata(value);
}

function partition<T>(items: T[], groupCount: number): T[][] {
  const groups: T[][] = [];
  for (let index = 0; index < groupCount; index += 1) {
    const start = Math.floor((index * items.length) / groupCount);
    const end = Math.floor(((index + 1) * items.length) / groupCount);
    groups.push(items.slice(start, Math.max(start + 1, end)));
  }
  return groups.filter((group) => group.length > 0);
}

function naturalSceneTitle(narration: string, role?: string) {
  const sentences = sourceSentences(narration);
  const concise = sentences.find((sentence) => sentence.split(/\s+/).length <= 7);
  if (concise) return concise;
  return role === "mechanism" ? "How the method works" : role === "evidence" ? "What the evidence shows"
    : role === "limitation" ? "Limits of the findings" : role === "core" ? "The central idea" : "Supporting context";
}

function sceneTitle(narration: string, index: number) {
  const words = narration.replace(/[^\p{L}\p{N}\s'-]/gu, "").split(/\s+/).filter(Boolean);
  const title = words.slice(0, 7).join(" ");
  return title || `Scene ${index + 1}`;
}

function visualTreatmentFor(narration: string, index: number) {
  if (/\b(percent|percentage|rate|increase|decrease|data|number|million|billion)\b/i.test(narration)) {
    return "Animated data comparison with a single highlighted measure";
  }
  if (/\b(before|after|first|then|finally|history|timeline|year)\b/i.test(narration)) {
    return "Progressive timeline with one focal milestone at a time";
  }
  if (/\b(versus|compared|difference|while|but|however)\b/i.test(narration)) {
    return "Side-by-side comparison that resolves into one takeaway";
  }
  return index === 0
    ? "Kinetic title and visual thesis reveal"
    : "Diagram-led scene with paced typography and restrained supporting motion";
}
