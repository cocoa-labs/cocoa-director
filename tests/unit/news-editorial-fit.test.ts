import { describe, expect, it } from "vitest";

import { narrationBudgetSummary } from "@/lib/hybrid-visuals";
import { spokenScriptText } from "@/lib/editorial-timing";
import { SourceBundle } from "@/lib/schemas";
import { fitOutlineToNarrationBudget } from "@/lib/server/news-editorial-ai";

describe("source-grounded editorial fit", () => {
  it("does not let scene headings and citation markers block a fitted script", () => {
    const narration = Array.from({ length: 52 }, () => "word").join(" ");
    const title = "An unusually long chapter heading containing fifteen extra unspoken words for this regression example";
    const script = `${title}\n${narration} [claim:source-1]`;
    expect(narrationBudgetSummary(script, 30).withinBudget).toBe(false);
    const spoken = spokenScriptText(script, [title.toUpperCase()]);
    const budget = narrationBudgetSummary(spoken, 30);
    expect(budget.words).toBe(52);
    expect(budget.withinBudget).toBe(true);
    expect(budget.predictedCoverage).toBeGreaterThanOrEqual(0.75);
    expect(spoken).toContain("[claim:source-1]");
  });

  it("expands an underfilled outline from cited evidence into the approval range", () => {
    const sourceBundle = SourceBundle.parse({
      inputs: [{ id: "source-1", kind: "text", title: "Technical report", text: "Supplied report text." }],
      claims: Array.from({ length: 5 }, (_, index) => ({
        id: `claim-${index + 1}`,
        text: `Supported finding ${index + 1} establishes the documented mechanism and its measured operational consequence for the organizations in the report.`,
        sourceIds: ["source-1"],
        confidence: 0.9,
        status: "supported",
        editorialStatus: "draft",
        evidence: [`The report explains that finding ${index + 1} developed through a sequence of verified technical events, affected a distinct part of the system, and produced an observable result that investigators recorded in the source material.`],
        evidenceRefs: [{
          sourceId: "source-1",
          section: `Finding ${index + 1}`,
          excerpt: `Investigators documented additional context for finding ${index + 1}, including how the mechanism operated, why it mattered to practitioners, and which evidence distinguished it from the other findings in the report.`,
          excerptHash: `${index + 1}`.padStart(64, "0"),
        }],
        breaking: false,
      })),
    });
    const outline = Array.from({ length: 4 }, (_, index) => ({
      id: `scene-${index + 1}`,
      title: `Chapter ${index + 1}`,
      narration: `This chapter introduces supported finding ${index + 1}.`,
      visual: "Layer the cited evidence over cinematic context.",
      claimIds: [`claim-${index + 1}`],
      sourceIds: ["source-1"],
    }));

    const fitted = fitOutlineToNarrationBudget(outline, sourceBundle, 90);
    const budget = narrationBudgetSummary(fitted.map((scene) => scene.narration).join(" "), 90);

    expect(budget.predictedCoverage).toBeGreaterThanOrEqual(0.75);
    expect(budget.withinBudget).toBe(true);
    expect(fitted.map((scene) => scene.narration).join(" ")).toContain("Investigators documented additional context");
  });

  it("does not invent filler when the evidence is insufficient", () => {
    const sourceBundle = SourceBundle.parse({
      inputs: [{ id: "source-1", kind: "text", title: "Short note", text: "One fact." }],
      claims: [{
        id: "claim-1",
        text: "One supported fact.",
        sourceIds: ["source-1"],
        confidence: 0.9,
        status: "supported",
        editorialStatus: "draft",
        evidence: ["One supported fact."],
        evidenceRefs: [],
        breaking: false,
      }],
    });
    const outline = [{
      id: "scene-1",
      title: "Fact",
      narration: "One supported fact.",
      visual: "Show the supplied evidence.",
      claimIds: ["claim-1"],
      sourceIds: ["source-1"],
    }];

    const fitted = fitOutlineToNarrationBudget(outline, sourceBundle, 90);
    expect(fitted[0].narration).toBe("One supported fact.");
    expect(narrationBudgetSummary(fitted[0].narration, 90).predictedCoverage).toBeLessThan(0.75);
  });
});
