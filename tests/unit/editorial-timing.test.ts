import { describe, expect, it } from "vitest";

import { applyTimingPlan, compileEditorialTimingPlan, detectBriefDurationSeconds, normalizeEditorialVisualBeats } from "@/lib/editorial-timing";
import { buildHybridVisualPlan } from "@/lib/hybrid-visuals";
import { EditorialTimingPlan, NewsStoryboard, ProductionCreateRequest } from "@/lib/schemas";

const productionId = "51000000-0000-4000-8000-000000000005";

describe("editorial timing V2", () => {
  it.each([
    { totalMs: 47_917, targetSpeechMs: 51_000 },
    { totalMs: 57_856, targetSpeechMs: 55_200 },
    { totalMs: 46_920, targetSpeechMs: 51_000 },
    { totalMs: 59_616, targetSpeechMs: 55_200 },
  ])("fits a $totalMs ms take without rewriting or leaving rounding gaps", ({ totalMs, targetSpeechMs }) => {
    const storyboard = fixtureStoryboard();
    const timing = compileEditorialTimingPlan({ productionId, storyboard,
      narration: storyboard.scenes.map((scene, index) => ({ sceneId: scene.id, durationMs: Math.floor(totalMs / 6) + (index < totalMs % 6 ? 1 : 0) })),
      targetDurationMs: 60_000, compiledAt: "2026-10-02T00:00:00.000Z" });
    expect(EditorialTimingPlan.parse(timing).coverage.passed).toBe(true);
    expect(timing.coverage.spokenDurationMs).toBe(targetSpeechMs);
    expect(timing.scenes.at(-1)?.endMs).toBe(60_000);
    expect(timing.scenes.every((scene) => scene.retimeRate >= 0.92 && scene.retimeRate <= 1.08)).toBe(true);
    expect(timing.pauses.every((pause) => pause.durationMs <= 1_500)).toBe(true);
    expect(timing.scenes.reduce((sum, scene) => sum + scene.measuredNarrationMs, 0)).toBe(totalMs);
  });

  it.each([42_000, 62_035])("still blocks a $totalMs ms take outside the pacing limit", (totalMs) => {
    const storyboard = fixtureStoryboard();
    const timing = compileEditorialTimingPlan({ productionId, storyboard,
      narration: storyboard.scenes.map((scene, index) => ({ sceneId: scene.id, durationMs: Math.floor(totalMs / 6) + (index < totalMs % 6 ? 1 : 0) })),
      targetDurationMs: 60_000, compiledAt: "2026-10-02T00:00:00.000Z" });
    expect(timing.coverage.passed).toBe(false);
    expect(timing.scenes.every((scene) => scene.retimeRate === 1)).toBe(true);
  });

  it("keeps the selected duration authoritative while detecting brief hints", () => {
    expect(detectBriefDurationSeconds("Create a short 60-second explainer.")).toBe(60);
    expect(detectBriefDurationSeconds("Make this 1:30 with a calm close.")).toBe(90);
    expect(detectBriefDurationSeconds("Explain this clearly.")).toBeUndefined();
  });

  it("compiles measured narration into explicit sub-1.5 second pauses without scene padding", () => {
    const storyboard = fixtureStoryboard();
    const request = ProductionCreateRequest.parse({ contentType: "explainer", brief: "Create a 60-second source-led explainer.", targetDurationSeconds: 60, qualityTier: "standard" });
    const plan = buildHybridVisualPlan({ productionId, request, storyboard, createdAt: "2026-07-29T00:00:00.000Z" })!;
    const timing = compileEditorialTimingPlan({
      productionId,
      storyboard,
      narration: storyboard.scenes.map((scene) => ({ sceneId: scene.id, durationMs: 8_800 })),
      targetDurationMs: 60_000,
      compiledAt: "2026-07-29T00:01:00.000Z",
    });
    const timed = applyTimingPlan(storyboard, plan, timing);

    expect(timing.coverage.passed).toBe(true);
    expect(timing.coverage.spokenCoverage).toBe(0.88);
    expect(timing.pauses.every((pause) => pause.durationMs <= 1_500)).toBe(true);
    expect(timing.scenes.at(-1)?.endMs).toBe(60_000);
    expect(timed.storyboard.scenes.every((scene, index) => scene.startMs === timing.scenes[index].startMs && scene.endMs === timing.scenes[index].endMs)).toBe(true);
    expect(timed.plan.version).toBe(4);
    expect(timed.plan.beats.every((beat) => beat.motionCues.every((cue, index, cues) => index === 0 || cue.atMs - cues[index - 1].atMs <= 1_500))).toBe(true);
  });

  it("blocks the supplied-render regression shape instead of inflating scenes", () => {
    const storyboard = fixtureStoryboard();
    const timing = compileEditorialTimingPlan({
      productionId,
      storyboard,
      narration: storyboard.scenes.map((scene, index) => ({ sceneId: scene.id, durationMs: [4_900, 6_800, 5_100, 4_500, 6_100, 5_400][index] })),
      targetDurationMs: 180_000,
      compiledAt: "2026-07-29T00:01:00.000Z",
    });

    expect(timing.coverage.passed).toBe(false);
    expect(timing.coverage.spokenCoverage).toBeLessThan(0.2);
    expect(timing.coverage.findings.some((finding) => finding.code === "narration.underfill")).toBe(true);
  });

  it("reports the supplied 180-second regression as 37% speech with eight long post-narration gaps", () => {
    const gaps = [9_600, 10_800, 12_000, 13_200, 14_400, 15_600, 18_000, 19_400];
    const storyboard = NewsStoryboard.parse({
      version: 1,
      createdAt: "2026-07-29T00:00:00.000Z",
      scenes: gaps.map((_, index) => ({
        id: `legacy-${index + 1}`,
        title: `Legacy scene ${index + 1}`,
        narration: "Supported narration.",
        visual: "Legacy plate.",
        claimIds: [], sourceIds: [], startMs: index * 22_500, endMs: (index + 1) * 22_500,
        visualKind: "graphic", syntheticLabelRequired: false, citationLabels: [], beats: [],
      })),
    });
    const timing = compileEditorialTimingPlan({
      productionId,
      storyboard,
      narration: storyboard.scenes.map((scene, index) => ({ sceneId: scene.id, durationMs: 22_500 - gaps[index] })),
      targetDurationMs: 180_000,
      compiledAt: "2026-07-29T00:01:00.000Z",
    });
    const gapFindings = timing.coverage.findings.filter((finding) => finding.code === "narration.legacy_padding_removed");
    expect(timing.coverage.spokenCoverage).toBeCloseTo(0.3722, 4);
    expect(gapFindings).toHaveLength(8);
    expect(gapFindings.every((finding) => finding.severity === "review")).toBe(true);
    expect(timing.coverage.longestUnapprovedGapMs).toBeLessThanOrEqual(1_500);
  });

  it("removes uneven legacy scene padding without rejecting otherwise valid measured narration", () => {
    const storyboard = NewsStoryboard.parse({
      version: 1,
      createdAt: "2026-07-29T00:00:00.000Z",
      scenes: Array.from({ length: 6 }, (_, index) => ({
        id: `scene-${String(index + 1).padStart(2, "0")}`,
        title: `Scene ${index + 1}`,
        narration: "Supported measured narration for this scene.",
        visual: "Layer cinematic context with source evidence.",
        claimIds: [], sourceIds: [], startMs: index * 10_000, endMs: (index + 1) * 10_000,
        visualKind: "graphic", syntheticLabelRequired: false, citationLabels: [], beats: [],
      })),
    });
    const durations = [10_000, 6_000, 10_000, 7_200, 7_300, 12_000];
    const timing = compileEditorialTimingPlan({
      productionId,
      storyboard,
      narration: storyboard.scenes.map((scene, index) => ({ sceneId: scene.id, durationMs: durations[index] })),
      targetDurationMs: 60_000,
      compiledAt: "2026-07-29T00:01:00.000Z",
    });

    expect(timing.coverage.spokenCoverage).toBe(0.875);
    expect(timing.coverage.passed).toBe(true);
    expect(timing.scenes.at(-1)?.endMs).toBe(60_000);
    expect(timing.coverage.longestUnapprovedGapMs).toBe(1_250);
    expect(timing.coverage.findings.filter((finding) => finding.code === "narration.legacy_padding_removed")).toHaveLength(3);
    expect(timing.coverage.findings.some((finding) => finding.severity === "blocking")).toBe(false);
  });

  it("reflows measured scenes into 2–6 second beats and layers long information treatments", () => {
    const storyboard = fixtureStoryboard();
    const request = ProductionCreateRequest.parse({ contentType: "explainer", brief: "A sourced explainer.", targetDurationSeconds: 60, qualityTier: "standard" });
    const plan = buildHybridVisualPlan({ productionId, request, storyboard, createdAt: "2026-07-29T00:00:00.000Z" })!;
    const firstSceneBeats = plan.beats.filter((beat) => beat.sceneId === "scene-1");
    expect(firstSceneBeats).toHaveLength(3);

    const short = normalizeEditorialVisualBeats(plan, [{ id: "scene-1", startMs: 0, endMs: 4_800 }]);
    const shortBeats = short.beats.filter((beat) => beat.sceneId === "scene-1");
    expect(shortBeats).toHaveLength(2);
    expect(shortBeats.every((beat) => beat.endMs - beat.startMs >= 2_000 && beat.endMs - beat.startMs <= 6_000)).toBe(true);
    expect(shortBeats.some((beat) => ["documentary_source", "document_excerpt", "data_visualization"].includes(beat.kind))).toBe(true);
    expect(shortBeats.some((beat) => ["cinematic_broll", "synthetic_reenactment", "composite"].includes(beat.kind))).toBe(true);

    const long = normalizeEditorialVisualBeats(plan, [{ id: "scene-1", startMs: 0, endMs: 14_700 }]);
    const longBeats = long.beats.filter((beat) => beat.sceneId === "scene-1");
    expect(longBeats).toHaveLength(3);
    expect(longBeats.every((beat) => beat.endMs - beat.startMs >= 2_000 && beat.endMs - beat.startMs <= 6_000)).toBe(true);
    expect(longBeats.filter((beat) => ["cinematic_broll", "synthetic_reenactment", "composite"].includes(beat.kind)).every((beat) => beat.endMs - beat.startMs === 6_000)).toBe(true);
    expect(longBeats.filter((beat) => ["documentary_source", "document_excerpt", "data_visualization"].includes(beat.kind)).every((beat) => beat.fullScreen === false)).toBe(true);
    expect(longBeats.every((beat) => beat.motionCues.every((cue, index, cues) => index === 0 || cue.atMs - cues[index - 1].atMs <= 1_500))).toBe(true);
  });
});

function fixtureStoryboard() {
  return NewsStoryboard.parse({
    version: 1,
    createdAt: "2026-07-29T00:00:00.000Z",
    scenes: Array.from({ length: 6 }, (_, index) => ({
      id: `scene-${index + 1}`,
      title: `Supported chapter ${index + 1}`,
      narration: "This supported explanation provides enough sourced context to make the mechanism and consequence clear to the intended audience.",
      visual: "Layer cinematic context with exact source evidence.",
      claimIds: [`claim-${index + 1}`],
      sourceIds: [`source-${index + 1}`],
      startMs: index * 10_000,
      endMs: (index + 1) * 10_000,
      visualKind: index === 0 ? "document" : "graphic",
      syntheticLabelRequired: false,
      citationLabels: [`Source ${index + 1}`],
      beats: [],
    })),
  });
}
