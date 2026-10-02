import { describe, expect, it } from "vitest";
import { makeDurationPlan, outsideDurationTolerance, resolveDurationPlan, sourceCoverageOutline, usesNaturalDuration } from "@/lib/editorial-duration";
import { compileNaturalEditorialTiming } from "@/lib/editorial-timing";
import { EditorialTimingPlan, ProductionCreateRequest, SourceBundle } from "@/lib/schemas";
import { buildSourceFirstDraft } from "@/workflow/source-first";
import { readableEditorialMessage, fitCompleteEditorialText } from "@/lib/server/editorial-graphics";
import { editorialScoreFilters } from "@/lib/editorial-score";

const id = "51000000-0000-4000-8000-000000000005";
const now = "2026-10-02T00:00:00.000Z";
const text = "The method measures actual transactions. It collects data across regions and checks each result. Insufficient evidence limits the conclusion.";
function bundle(count: number, words = 12) {
  return SourceBundle.parse({ inputs: [{ id: "source", kind: "text", title: "Supplied paper", text }], claims: Array.from({ length: count }, (_, index) => ({ id: `claim-${index}`, text: `Finding ${index} ${"documented mechanism and evidence ".repeat(Math.ceil(words / 4)).trim()}.`, status: "supported", sourceIds: ["source"], evidence: [text] })) });
}

describe("content-led duration", () => {
  it.each([["short notes", 2, 6], ["substantial article", 27, 18], ["technical paper", 50, 30], ["over ten minutes", 80, 40]])("preserves coverage before runtime for %s", (_, count, words) => {
    const sourceBundle = bundle(count, words);
    const request = ProductionCreateRequest.parse({ contentType: "explainer", durationMode: "auto", targetDurationSeconds: 60, brief: "Explain all the central ideas in this source.", sourceBundle });
    const draft = buildSourceFirstDraft(id, request, now);
    const plan = makeDurationPlan({ request, sourceBundle, scenes: draft.outline, now });
    expect(plan.coverage.filter((point) => point.included)).toHaveLength(count);
    expect(new Set(draft.outline.flatMap((scene) => scene.claimIds)).size).toBe(count);
    expect(plan.estimatedDurationSeconds).toBe(draft.timeline.durationMs / 1000);
    if (count >= 50) expect(plan.scopeTooLong).toBe(true);
    expect(draft.outline.length).toBeLessThanOrEqual(40);
  });

  it("makes approximate length a proposal without cutting or padding", () => {
    const sourceBundle = bundle(27, 18);
    const request = ProductionCreateRequest.parse({ contentType: "news_digest", durationMode: "target", targetDurationSeconds: 60, brief: "Explain the supplied article.", sourceBundle });
    const draft = buildSourceFirstDraft(id, request, now);
    const plan = makeDurationPlan({ request, sourceBundle, scenes: draft.outline, now });
    expect(plan.requestedTargetSeconds).toBe(60);
    expect(plan.estimatedDurationSeconds).toBeGreaterThan(72);
    expect(plan.rationale).toContain("outside");
    expect(plan.coverage.every((point) => point.included)).toBe(true);
    expect(outsideDurationTolerance(48, 60)).toBe(false);
    expect(outsideDurationTolerance(72, 60)).toBe(false);
    expect(outsideDurationTolerance(73, 60)).toBe(true);
  });

  it("records reasons for unsupported and duplicate omissions", () => {
    const source = bundle(2);
    source.claims[1].text = source.claims[0].text;
    source.claims.push({ ...source.claims[0], id: "rejected", text: "An unsupported claim.", status: "rejected" });
    expect(sourceCoverageOutline(source).filter((point) => !point.included).map((point) => point.reason)).toEqual([expect.stringContaining("Repeated"), expect.stringContaining("supported")]);
  });

  it.each([47_917, 57_856, 62_035])("keeps every millisecond of a %i recording at normal speed", (total) => {
    const request = ProductionCreateRequest.parse({ contentType: "explainer", durationMode: "auto", brief: "Explain the supplied source.", sourceBundle: bundle(6) });
    const draft = buildSourceFirstDraft(id, request, now);
    const count = draft.storyboard.scenes.length;
    const timing = EditorialTimingPlan.parse(compileNaturalEditorialTiming({ productionId: id, storyboard: draft.storyboard, narration: draft.storyboard.scenes.map((scene, i) => ({ sceneId: scene.id, durationMs: Math.floor(total / count) + (i < total % count ? 1 : 0) })), compiledAt: now }));
    expect(timing.scenes.every((scene) => scene.retimeRate === 1)).toBe(true);
    expect(timing.coverage.spokenDurationMs).toBe(total);
    expect(timing.targetDurationMs - timing.scenes.at(-1)!.speechEndMs).toBeGreaterThanOrEqual(3000);
    expect(timing.coverage.passed).toBe(true);
  });

  it("pauses changed scope and cost against the approved proposal", () => {
    const request = ProductionCreateRequest.parse({ durationMode: "auto", brief: "Explain this source." });
    const plan = { ...makeDurationPlan({ request, sourceBundle: bundle(1), scenes: [{ title: "Key idea", narration: text, claimIds: ["claim-0"] }], now }), approvedDurationSeconds: 60, approvedCostCents: 200 };
    expect(resolveDurationPlan(plan, 65, 180, now).needsReview).toBe(false);
    expect(resolveDurationPlan(plan, 73, 180, now).needsReview).toBe(true);
    expect(resolveDurationPlan(plan, 65, 201, now).needsReview).toBe(true);
    expect(resolveDurationPlan(plan, 601, 180, now).scopeTooLong).toBe(true);
  });

  it("keeps absent policy fixed and music behavior unchanged", () => {
    const request = ProductionCreateRequest.parse({ brief: "A cinematic music video." });
    expect(request.durationMode).toBe("fixed");
    expect(usesNaturalDuration({ ...request, durationMode: "auto" })).toBe(false);
    expect(usesNaturalDuration({ contentType: "explainer" })).toBe(false);
  });

  it("uses complete quotations or a concise paraphrase without changing source text", () => {
    const excerpt = "This very detailed source paragraph requires more exposure than a rapid card can provide for comfortable reading and accurate understanding.";
    const message = readableEditorialMessage("Evidence has limits", excerpt, 2000);
    expect(message).toMatchObject({ text: "Evidence has limits", kind: "paraphrase" });
    expect(readableEditorialMessage("Evidence has limits", "Results remain uncertain.", 2000).kind).toBe("quotation");
    expect(() => readableEditorialMessage("This headline is much too long for this very brief exposure", excerpt, 1000)).toThrow("exposure");
    expect(fitCompleteEditorialText(excerpt, 600, 42, 4).truncated).toBe(false);
    expect(editorialScoreFilters("[0:a]", 120, 600).filter((filter) => filter.includes("acrossfade"))).toHaveLength(5);
  });
});
