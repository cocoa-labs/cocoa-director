import { describe, expect, it } from "vitest";

import { buildHybridVisualPlan } from "@/lib/hybrid-visuals";
import { NewsStoryboard, ProductionCreateRequest, SourceBundle } from "@/lib/schemas";
import { attachAuthenticSourceVisuals, exactExcerptHash, validateGraphicPayload } from "@/lib/server/source-visuals";

describe("authentic editorial source visuals", () => {
  it("turns URL evidence into a publisher excerpt card with an exact hash", () => {
    const excerpt = "The cited report says the deployment will begin in September and includes an independently verified implementation milestone.";
    const bundle = SourceBundle.parse({
      inputs: [{ id: "source-1", kind: "url", title: "Verified deployment report", url: "https://example.com/report", canonicalUrl: "https://example.com/report", publishedAt: "2026-07-28T00:00:00.000Z", extractedText: excerpt }],
      claims: [{ id: "claim-1", text: "The deployment begins in September.", sourceIds: ["source-1"], status: "supported", confidence: 0.95, evidenceRefs: [{ sourceId: "source-1", fragmentId: "61000000-0000-4000-8000-000000000006", section: "Deployment", sourceUrl: "https://example.com/report", excerpt, excerptHash: exactExcerptHash(excerpt) }] }],
    });
    const storyboard = NewsStoryboard.parse({ version: 1, createdAt: "2026-07-29T00:00:00.000Z", scenes: [{ id: "scene-1", title: "Deployment", narration: "The cited deployment starts in September, with a verified implementation milestone.", visual: "Show exact evidence and cinematic application.", claimIds: ["claim-1"], sourceIds: ["source-1"], startMs: 0, endMs: 10_000, visualKind: "document", syntheticLabelRequired: false, citationLabels: ["example.com"], beats: [] }] });
    const request = ProductionCreateRequest.parse({ contentType: "news_digest", brief: "A concise evidence-led report.", sourceBundle: bundle, targetDurationSeconds: 30, qualityTier: "standard" });
    const initial = buildHybridVisualPlan({ productionId: "62000000-0000-4000-8000-000000000006", request, storyboard, createdAt: "2026-07-29T00:00:00.000Z" })!;
    const plan = attachAuthenticSourceVisuals(initial, bundle);
    const evidenceBeat = plan.beats.find((beat) => beat.sourceVisual);

    expect(evidenceBeat?.sourceVisual).toMatchObject({ kind: "url_excerpt_card", domain: "example.com", excerptHash: exactExcerptHash(excerpt), locator: "Deployment" });
    expect(evidenceBeat?.graphicSpec && "version" in evidenceBeat.graphicSpec ? evidenceBeat.graphicSpec.version : undefined).toBe(2);
    expect(evidenceBeat ? validateGraphicPayload(evidenceBeat) : undefined).toEqual({ valid: true });
  });

  it("rejects decorative quantitative graphics without cited units", () => {
    const beat = {
      id: "beat-1", sceneId: "scene-1", index: 0, startMs: 0, endMs: 2_500, kind: "data_visualization" as const,
      intent: "Show a number", evidenceIds: ["claim-1"], sourceIds: ["source-1"], motionDirection: "Reveal and emphasize",
      providerRoute: { fallback: "review_required" as const }, disclosure: { required: false, persistent: false, publicFigures: [], currentEvent: false },
      costEstimateCents: 0, locked: false, hold: false, assets: [], motionCues: [], fullScreen: true,
      graphicSpec: { version: 2 as const, family: "hero_number" as const, title: "A number", values: [{ label: "Reported", value: 12, evidenceId: "claim-1" }], overlayPlacement: "left" as const },
      reusePolicy: { mode: "unique" as const, approved: false, minimumSeparationMs: 30_000 },
    };
    expect(validateGraphicPayload(beat)).toMatchObject({ valid: false });
  });

  it("uses a cited quantitative payload only when the exact excerpt supplies a value and unit", () => {
    const excerpt = "The filing says revenue reached $12 billion, up 18 percent for the reporting period.";
    const bundle = SourceBundle.parse({
      inputs: [{ id: "source-data", kind: "url", title: "Filed results", url: "https://example.com/results", extractedText: excerpt }],
      claims: [{ id: "claim-data", text: "Revenue reached $12 billion.", sourceIds: ["source-data"], status: "supported", confidence: 0.95, evidenceRefs: [{ sourceId: "source-data", section: "Results", excerpt, excerptHash: exactExcerptHash(excerpt) }] }],
    });
    const storyboard = NewsStoryboard.parse({ version: 1, createdAt: "2026-07-29T00:00:00.000Z", scenes: [{ id: "scene-data", title: "Filed results", narration: excerpt, visual: "Show the cited magnitude.", claimIds: ["claim-data"], sourceIds: ["source-data"], startMs: 0, endMs: 10_000, visualKind: "graphic", syntheticLabelRequired: false, citationLabels: ["example.com"], beats: [] }] });
    const request = ProductionCreateRequest.parse({ contentType: "news_digest", brief: "Explain the cited results.", sourceBundle: bundle, targetDurationSeconds: 30, qualityTier: "standard" });
    const initial = buildHybridVisualPlan({ productionId: "62000000-0000-4000-8000-000000000006", request, storyboard, createdAt: "2026-07-29T00:00:00.000Z" })!;
    const directed = { ...initial, beats: initial.beats.map((beat, index) => index === 0 ? { ...beat, kind: "data_visualization" as const } : beat) };
    const plan = attachAuthenticSourceVisuals(directed, bundle);
    const dataBeat = plan.beats.find((beat) => beat.kind === "data_visualization");

    expect(dataBeat?.graphicSpec?.family).toBe("magnitude_comparison");
    expect(dataBeat?.fullScreen).toBe(false);
    expect(dataBeat ? validateGraphicPayload(dataBeat) : undefined).toEqual({ valid: true });
  });
});
