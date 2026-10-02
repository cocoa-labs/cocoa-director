import { describe, expect, it } from "vitest";

import { buildHybridVisualPlan } from "@/lib/hybrid-visuals";
import { NewsStoryboard, ProductionCreateRequest, type VideoJob } from "@/lib/schemas";
import { strengthenSemanticRecoveryDirections } from "@/lib/server/production-recovery";
import { evaluateVisualPlan } from "@/lib/server/visual-quality";

const productionId = "30000000-0000-4000-8000-000000000003";

describe("visual diversity quality gate", () => {
  it("blocks the supplied-film regression pattern where many records resolve to one asset", () => {
    const { job, plan } = fixture();
    const collisionHash = "a".repeat(64);
    const collided = {
      ...plan,
      beats: plan.beats.map((beat) => generatedBeat(beat) ? {
        ...beat,
        assets: [{ beatId: beat.id, kind: "video" as const, url: "https://assets.example/shared.mp4", status: "ready" as const, costCents: 0, contentSha256: collisionHash, semanticScore: 0.9 }],
      } : beat),
    };

    const report = evaluateVisualPlan(job, collided);

    expect(report.passed).toBe(false);
    expect(report.uniqueAssetRatio).toBeLessThan(0.1);
    expect(report.findings.some((finding) => finding.code === "visual.exact_asset_reuse" && finding.severity === "blocking")).toBe(true);
  });

  it("accepts distinct generation-bound assets with specific visual direction", () => {
    const { job, plan } = fixture();
    const distinct = {
      ...plan,
      beats: plan.beats.map((beat, index) => generatedBeat(beat) ? {
        ...beat,
        assets: [{
          beatId: beat.id,
          kind: "video" as const,
          url: `https://assets.example/${beat.id}.mp4`,
          status: "ready" as const,
          costCents: 0,
          immutableStorageKey: `projects/p/productions/${productionId}/generations/g-${index}/${beat.id}/video/attempt-1/video.mp4`,
          contentSha256: index.toString(16).padStart(64, "0"),
          semanticScore: 0.9,
        }],
      } : beat),
    };

    const report = evaluateVisualPlan(job, distinct);

    expect(report.uniqueAssetRatio).toBe(1);
    expect(report.findings.some((finding) => finding.code === "visual.exact_asset_reuse")).toBe(false);
  });

  it("does not charge for an endless retry when only the recovered prompt proxy remains inconclusive", () => {
    const { job, plan } = fixture();
    const distinct = {
      ...plan,
      beats: plan.beats.map((beat, index) => generatedBeat(beat) ? {
        ...beat,
        assets: [{
          beatId: beat.id,
          kind: "video" as const,
          url: `https://assets.example/recovered-${beat.id}.mp4`,
          status: "ready" as const,
          costCents: 0,
          immutableStorageKey: `recovered/${beat.id}`,
          contentSha256: (index + 100).toString(16).padStart(64, "0"),
          semanticScore: 0.62,
          recoveryReason: "retry_failed_beats",
        }],
      } : beat),
    };
    const report = evaluateVisualPlan(job, distinct);

    expect(report.findings.some((finding) => finding.code === "visual.semantic_mismatch")).toBe(false);
    expect(report.findings.some((finding) => finding.code === "visual.semantic_proxy_inconclusive" && finding.severity === "info")).toBe(true);
  });

  it("puts the approved subject and mechanism first in semantic recovery prompts", () => {
    const { plan } = fixture();
    const target = plan.beats.find((beat) => generatedBeat(beat))!;
    const flagged = {
      ...plan,
      qualityReport: {
        version: 1 as const,
        passed: false,
        state: "failed" as const,
        uniqueAssetRatio: 1,
        cinematicCoverage: 0.6,
        retainedBeatIds: [],
        rejectedBeatIds: [target.id],
        duplicateGroups: [],
        graphicFamilyMix: {},
        autoPolishAttempts: 0,
        findings: [{ code: "visual.semantic_mismatch", severity: "blocking" as const, message: "Mismatch", beatIds: [target.id] }],
        checkedAt: "2026-07-29T00:00:00.000Z",
      },
    };
    const strengthened = strengthenSemanticRecoveryDirections(flagged, [target.id]);
    const prompt = strengthened.beats.find((beat) => beat.id === target.id)?.generationPrompt ?? "";

    expect(prompt.startsWith("APPROVED SUBJECT:")).toBe(true);
    expect(prompt).toContain(target.shotSpec?.subject);
    expect(prompt).toContain("SUPPORTED ACTION OR MECHANISM:");
  });
});

function fixture() {
  const request = ProductionCreateRequest.parse({ contentType: "news_digest", brief: "Create a directed three-minute technology roundup.", targetDurationSeconds: 180, aspectRatio: "16:9", qualityTier: "standard" });
  const storyboard = NewsStoryboard.parse({
    version: 1,
    createdAt: "2026-07-29T00:00:00.000Z",
    scenes: Array.from({ length: 18 }, (_, index) => ({
      id: `scene-${String(index + 1).padStart(2, "0")}`,
      title: `Distinct supported story ${index + 1}`,
      narration: `The cited source reports development ${index + 1}, explaining its mechanism and consequence without adding unsupported facts.`,
      visual: `A unique environment and evidence treatment for development ${index + 1}.`,
      claimIds: [`claim-${index + 1}`],
      sourceIds: [`source-${index + 1}`],
      startMs: index * 10_000,
      endMs: (index + 1) * 10_000,
      visualKind: index % 5 === 0 ? "document" : "graphic",
      syntheticLabelRequired: false,
      citationLabels: [`Source ${index + 1}`],
      beats: [],
    })),
  });
  const plan = buildHybridVisualPlan({ productionId, request, storyboard, createdAt: "2026-07-29T00:00:00.000Z" })!;
  const job = { id: productionId, qualityTier: "standard" } as VideoJob;
  return { job, plan };
}

function generatedBeat(beat: { kind: string }) {
  return ["editorial_image", "cinematic_broll", "synthetic_reenactment", "composite"].includes(beat.kind);
}
