import { describe, expect, it } from "vitest";

import type { HybridVisualPlanV2, MediaGeneration } from "@/lib/schemas";
import { rebalanceGraphicFamilies, selectSalvageGeneration } from "@/lib/server/production-recovery";

describe("Editorial Direction V3 visual salvage", () => {
  it("reuses the paid scene clip when the cinematic beat moves within the scene", () => {
    const source = generation("scene-03-beat-02");

    expect(selectSalvageGeneration([source], { id: "scene-03-beat-01", sceneId: "scene-03" })?.id).toBe(source.id);
    expect(selectSalvageGeneration([source], { id: "scene-04-beat-01", sceneId: "scene-04" })).toBeUndefined();
  });

  it("corrects a dominant graphic family without inventing quantitative charts", () => {
    const families = [
      "process_flow", "timeline", "geographic_map", "source_excerpt", "relationship_network",
      "process_flow", "timeline", "geographic_map", "source_excerpt", "process_flow",
    ] as const;
    const plan = {
      version: 3,
      beats: families.map((family, index) => ({
        id: `scene-${String(index + 1).padStart(2, "0")}-beat-01`,
        sceneId: `scene-${String(index + 1).padStart(2, "0")}`,
        index: 0,
        startMs: index * 5_000,
        endMs: (index + 1) * 5_000,
        kind: "data_visualization",
        intent: "Explain a supported relationship",
        evidenceIds: ["claim-1"],
        sourceIds: ["source-1"],
        providerRoute: { fallback: "review_required" },
        disclosure: { required: false, persistent: false, publicFigures: [], currentEvent: false },
        costEstimateCents: 0,
        locked: false,
        hold: false,
        assets: [],
        graphicSpec: { family, title: `Graphic ${index + 1}`, values: [], overlayPlacement: "left" },
        reusePolicy: { mode: "unique", approved: false, minimumSeparationMs: 30_000 },
      })),
    } as unknown as HybridVisualPlanV2;

    const rebalanced = rebalanceGraphicFamilies(plan, ["scene-01-beat-01", "scene-06-beat-01", "scene-10-beat-01"]);
    const counts = rebalanced.beats.reduce<Record<string, number>>((result, beat) => {
      if (beat.graphicSpec) result[beat.graphicSpec.family] = (result[beat.graphicSpec.family] ?? 0) + 1;
      return result;
    }, {});

    expect(Math.max(...Object.values(counts))).toBeLessThanOrEqual(2);
    expect(rebalanced.beats.filter((beat) => beat.graphicSpec && "values" in beat.graphicSpec && beat.graphicSpec.values.length === 0)
      .every((beat) => !["hero_number", "magnitude_comparison", "change_over_time", "ranking", "part_to_whole"].includes(beat.graphicSpec!.family))).toBe(true);
  });
});

function generation(beatId: string) {
  return {
    id: "20000000-0000-4000-8000-000000000001",
    projectId: "20000000-0000-4000-8000-000000000002",
    videoJobId: "20000000-0000-4000-8000-000000000003",
    kind: "video",
    provider: "fal",
    model: "seedance-2.0",
    status: "success",
    prompt: "Specific editorial scene",
    controls: { visualBeatId: beatId },
    inputAssetIds: [],
    outputUrls: { video: "https://example.com/distinct-provider-result.mp4" },
    metadata: {},
    costCents: 0,
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
  } as MediaGeneration;
}
