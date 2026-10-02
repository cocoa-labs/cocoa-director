import { describe, expect, it } from "vitest";

import { applyValidatedLikenessRouting, buildHybridVisualPlan, narrationBudgetSummary } from "@/lib/hybrid-visuals";
import { NewsStoryboard, ProductionCreateRequest } from "@/lib/schemas";

const productionId = "10000000-0000-4000-8000-000000000001";

function storyboard(seconds: number, sceneCount: number) {
  const durationMs = seconds * 1_000;
  return NewsStoryboard.parse({
    version: 1,
    createdAt: "2026-07-29T00:00:00.000Z",
    scenes: Array.from({ length: sceneCount }, (_, index) => ({
      id: `scene-${String(index + 1).padStart(2, "0")}`,
      title: `Supported development ${index + 1}`,
      narration: "A supported development is explained with attributable context, evidence, and a clear consequence for the audience.",
      visual: "Combine dimensional evidence with atmospheric, authored cinema.",
      claimIds: [`claim-${index + 1}`],
      sourceIds: [`source-${index + 1}`],
      startMs: Math.round(durationMs * index / sceneCount),
      endMs: Math.round(durationMs * (index + 1) / sceneCount),
      visualKind: index === 0 ? "document" : "graphic",
      syntheticLabelRequired: false,
      citationLabels: [`source-${index + 1}`],
      beats: [],
    })),
  });
}

describe("hybrid cinematic editorial planning", () => {
  it("plans a 60-second Standard digest with the required cinematic and evidentiary mix", () => {
    const request = ProductionCreateRequest.parse({
      contentType: "news_digest",
      projectId: "20000000-0000-4000-8000-000000000002",
      brief: "Create a cited daily technology digest with cinematic visual continuity.",
      targetDurationSeconds: 60,
      aspectRatio: "16:9",
      qualityTier: "standard",
      visualStylePreset: "auto",
    });
    const plan = buildHybridVisualPlan({ productionId, request, storyboard: storyboard(60, 6), createdAt: "2026-07-29T00:00:00.000Z" });
    expect(plan).toBeDefined();
    expect(plan!.metrics.cinematicBeatCount).toBeGreaterThanOrEqual(4);
    expect(plan!.metrics.cinematicBeatCount).toBeLessThanOrEqual(8);
    expect(plan!.metrics.cinematicCoverage).toBeGreaterThanOrEqual(0.55);
    expect(plan!.metrics.cinematicCoverage).toBeLessThanOrEqual(0.65);
    expect(plan!.metrics.evidenceBeatCount).toBeGreaterThanOrEqual(2);
    expect(plan!.beats.every((beat) => beat.endMs - beat.startMs <= 6_000)).toBe(true);
    expect(plan!.beats.every((beat) => !beat.hold)).toBe(true);
  });

  it("keeps Premium in its 70–80% cinematic target while persisting reenactment disclosures", () => {
    const request = ProductionCreateRequest.parse({
      contentType: "news_digest",
      brief: "Create a breaking policy roundup in a premium documentary style.",
      targetDurationSeconds: 60,
      qualityTier: "premium",
      visualStylePreset: "prestige_documentary",
    });
    const source = storyboard(60, 6);
    source.scenes[1] = { ...source.scenes[1], narration: "The president announced and signed the supported policy change during the public briefing." };
    const plan = buildHybridVisualPlan({ productionId, request, storyboard: source, createdAt: "2026-07-29T00:00:00.000Z" })!;
    expect(plan.metrics.cinematicCoverage).toBeGreaterThanOrEqual(0.70);
    expect(plan.metrics.cinematicCoverage).toBeLessThanOrEqual(0.80);
    for (const beat of plan.beats.filter((candidate) => candidate.kind === "synthetic_reenactment")) {
      expect(beat.disclosure).toMatchObject({ required: true, persistent: true, label: "AI-GENERATED REENACTMENT" });
    }
  });

  it("reserves narration time before approval", () => {
    const summary = narrationBudgetSummary(Array.from({ length: 140 }, () => "word").join(" "), 60);
    expect(summary.budgetWords).toBe(110);
    expect(summary.withinBudget).toBe(false);
  });

  it("routes recognizable reenactments to people-free cinema when likeness capability is unvalidated", () => {
    const request = ProductionCreateRequest.parse({ contentType: "news_digest", brief: "Create a premium breaking-news documentary.", targetDurationSeconds: 60, qualityTier: "premium" });
    const source = storyboard(60, 6);
    source.scenes[1] = { ...source.scenes[1], narration: "The president announced and signed the supported policy change during the briefing." };
    const planned = buildHybridVisualPlan({ productionId, request, storyboard: source, createdAt: "2026-07-29T00:00:00.000Z" })!;
    const safe = applyValidatedLikenessRouting(planned, false);

    expect(safe.beats.some((beat) => beat.kind === "synthetic_reenactment")).toBe(false);
    expect(safe.beats.filter((beat) => beat.providerRoute.fallback === "approved_equivalent").every((beat) => beat.generationPrompt?.includes("No people"))).toBe(true);
  });

  it.each([
    [30, "16:9"],
    [60, "9:16"],
    [180, "1:1"],
    [300, "16:9"],
  ] as const)("keeps %is Standard fixtures inside the tier envelope at %s", (seconds, aspectRatio) => {
    const sceneCount = Math.max(6, Math.round(seconds / 10));
    const request = ProductionCreateRequest.parse({ contentType: "explainer", brief: "Explain the supported source with cinematic clarity and precise visual teaching.", targetDurationSeconds: seconds, aspectRatio, qualityTier: "standard" });
    const plan = buildHybridVisualPlan({ productionId, request, storyboard: storyboard(seconds, sceneCount), createdAt: "2026-07-29T00:00:00.000Z" })!;
    const clipsPerMinute = plan.metrics.cinematicBeatCount / (seconds / 60);
    expect(plan.metrics.cinematicCoverage).toBeGreaterThanOrEqual(0.55);
    expect(plan.metrics.cinematicCoverage).toBeLessThanOrEqual(0.65);
    expect(clipsPerMinute).toBeGreaterThanOrEqual(6);
    expect(clipsPerMinute).toBeLessThanOrEqual(8);
    expect(plan.metrics.evidenceBeatCount).toBeGreaterThanOrEqual(2);
  });

  it("builds V4 chapters, semantic graphic families, and globally varied shot language", () => {
    const request = ProductionCreateRequest.parse({ contentType: "news_digest", brief: "A three-minute technology roundup.", targetDurationSeconds: 180, aspectRatio: "16:9", qualityTier: "standard" });
    const plan = buildHybridVisualPlan({ productionId, request, storyboard: storyboard(180, 18), createdAt: "2026-07-29T00:00:00.000Z" })!;
    const graphicFamilies = new Set(plan.beats.map((beat) => beat.graphicSpec?.family).filter(Boolean));
    const shotSizes = new Set(plan.beats.map((beat) => beat.shotSpec?.size).filter(Boolean));
    const movements = new Set(plan.beats.map((beat) => beat.shotSpec?.cameraMovement).filter(Boolean));
    const patterns = new Set(plan.chapters.map((chapter) => chapter.sequencePattern));

    expect(plan.version).toBe(4);
    expect(plan.chapters).toHaveLength(6);
    expect(plan.metrics.cinematicBeatCount).toBeGreaterThanOrEqual(18);
    expect(plan.metrics.cinematicBeatCount).toBeLessThanOrEqual(24);
    expect(graphicFamilies.size).toBeGreaterThanOrEqual(5);
    expect(shotSizes.size).toBeGreaterThanOrEqual(4);
    expect(movements.size).toBeGreaterThanOrEqual(3);
    expect(patterns.size).toBeGreaterThanOrEqual(3);
    expect(plan.beats.every((beat) => beat.reusePolicy.mode === "unique")).toBe(true);
  });
});
