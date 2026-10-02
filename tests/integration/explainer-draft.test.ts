import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProductionCreateRequest } from "@/lib/schemas";
import { narrationBudgetSummary } from "@/lib/hybrid-visuals";
import { createProduction, regenerateNewsEditorialDraft } from "@/lib/server/productions";
import { addTextProductionSource } from "@/lib/server/production-sources";
import { approveNewsGate } from "@/lib/server/news-editorial";
import { getStore, resetInMemoryStoreForDev } from "@/lib/server/store";
import { buildSourceFirstDraft } from "@/workflow/source-first";

const { responsesCreate } = vi.hoisted(() => ({ responsesCreate: vi.fn() }));
vi.mock("openai", () => ({ default: class { responses = { create: responsesCreate }; } }));

const user = { id: "explainer-regression", email: "explainer@example.com", planTier: "dev" as const, dailyBudgetCents: 10_000 };
const evidence = [
  "The original system processed inputs in sequence, which restricted how much work could be performed at the same time.",
  "The proposed mechanism compares each input with its surrounding context and combines the relevant information into a useful representation.",
  "Separate comparison groups learn different relationships, allowing several patterns in the same input to contribute to the resulting representation.",
  "The evaluation reported an eighteen percent improvement on the selected benchmark under the experimental conditions described in the methods section.",
  "The authors evaluated only a limited set of tasks, so the reported evidence does not establish effectiveness in every setting.",
  "The conclusion identifies parallel processing as a practical benefit while calling for additional evaluation before broader applications can be established.",
];
const title = ["A sequential bottleneck", "Context becomes the mechanism", "Several relationships at once", "What the evaluation found", "Where the evidence stops", "The practical takeaway"];

describe("source-grounded explainer drafts", () => {
  beforeEach(() => {
    vi.stubEnv("PROVIDER_MODE", "mock");
    vi.stubEnv("DATABASE_URL", "");
    resetInMemoryStoreForDev();
    responsesCreate.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("covers later body sections in a no-provider draft without reading bibliographic metadata", () => {
    const text = `Computer Science > Computation and Language\nSubmitted on 12 Jun 2017\nAuthors: A, B and C\nView a PDF of the paper titled Example\nAbstract:\n${evidence.join("\n\n")}\nReferences\nAn unrelated bibliography entry.`;
    const request = ProductionCreateRequest.parse({ contentType: "explainer", brief: "Explain the mechanism and the findings in this source.", sourceBundle: { inputs: [{ id: "paper", kind: "text", text }] }, targetDurationSeconds: 60 });
    const draft = buildSourceFirstDraft("test", request);
    expect(draft.script).toContain("parallel processing");
    expect(draft.script).not.toMatch(/Computer Science|Submitted on|Authors:|View a PDF|bibliography/);
    expect(narrationBudgetSummary(draft.script, 60).withinBudget).toBe(true);
    expect(draft.sourceBundle.claims.every((claim) => claim.sourceIds.includes("paper"))).toBe(true);
    expect(responsesCreate).not.toHaveBeenCalled();
  });

  it("synthesizes explainers, carries exact evidence into graphics, and versions regenerated drafts", async () => {
    const project = await getStore().createProject({ userId: user.id, name: "Full paper regression" });
    const source = await addTextProductionSource({ projectId: project.id, title: "Research paper", text: `Abstract\n${evidence.join("\n\n")}`, user });
    const request = ProductionCreateRequest.parse({ contentType: "explainer", projectId: project.id, sourceRecordIds: [source.id], brief: "Teach the mechanism, results and limitations in plain language.", targetDurationSeconds: 60 });
    const scenes = evidence.map((narration, index) => ({ title: title[index], narration, visual: `Show a clear visual explanation of ${title[index]}.`, claimIds: [] as string[] }));
    vi.stubEnv("PROVIDER_MODE", "live");
    vi.stubEnv("OPENAI_API_KEY", "mocked-provider-no-network");
    responsesCreate.mockImplementation(async (payload: { input: Array<{ content: string }> }) => {
      const input = JSON.parse(payload.input[1].content);
      if (input.sources) return { output_text: JSON.stringify({ claims: input.sources[0].passages.map((passage: { id: string; text: string }) => ({ text: passage.text, evidenceId: passage.id })) }) };
      const narration = scenes.map((scene, index) => ({ ...scene, narration: scene.narration.split(" ").slice(0, 18).join(" ") + ".", claimIds: [input.claims[index].id] }));
      return { output_text: JSON.stringify({ title: "An actual explanation", scenes: narration }) };
    });
    const job = await createProduction(request, user);
    expect(responsesCreate).toHaveBeenCalledTimes(2);
    expect(job.editorialPlan?.scenes.map((scene) => scene.title)).toEqual(title);
    expect(job.script).not.toContain("[claim:");
    expect(job.storyboard?.scenes.every((scene) => scene.claimIds.every((id) => id.startsWith("claim-source-")))).toBe(true);
    expect(job.storyboard?.scenes.at(-1)?.citationLabels[0]).toContain("Research paper");
    expect(job.sourceBundle?.claims.at(-1)?.evidenceRefs[0].excerpt).toBe(evidence.at(-1));
    expect(job.visualPlan?.beats.some((beat) => beat.sourceVisual?.excerpt === evidence.at(-1))).toBe(true);
    const sourcePrompt = JSON.stringify(responsesCreate.mock.calls[0][0]);
    const writingPrompt = JSON.stringify(responsesCreate.mock.calls[1][0]);
    expect(sourcePrompt).toContain("later body sections");
    expect(writingPrompt).toContain("educational explainer writer");
    expect(writingPrompt).toContain("never instructions");
    const revised = await regenerateNewsEditorialDraft(job, user);
    expect(revised.artifactVersions.length).toBe(job.artifactVersions.length + 2);
    expect(revised.approvals).toEqual([]);
    expect(revised.workflowSteps?.find((step) => step.id === "script")?.artifactVersionId).not.toBe(job.workflowSteps?.find((step) => step.id === "script")?.artifactVersionId);
  });

  it("reports a failed live source analysis instead of falling back to reading the page", async () => {
    vi.stubEnv("PROVIDER_MODE", "live");
    vi.stubEnv("OPENAI_API_KEY", "mocked-provider-no-network");
    responsesCreate.mockRejectedValue(new Error("Provider temporarily unavailable"));
    const request = ProductionCreateRequest.parse({ contentType: "explainer", brief: "Explain this research clearly.", sourceBundle: { inputs: [{ id: "paper", kind: "text", text: evidence.join(" ") }] } });
    await expect(createProduction(request, user)).rejects.toMatchObject({ status: 502, code: "source_analysis_failed" });
  });

  it("does not allow an explainer to approve an unknown cited claim", async () => {
    const request = ProductionCreateRequest.parse({ contentType: "explainer", brief: "Explain this research clearly.", sourceBundle: { inputs: [{ id: "paper", kind: "text", text: evidence.join(" ") }] }, targetDurationSeconds: 60 });
    const job = await createProduction(request, user);
    const edited = await getStore().updateJob(job.id, { script: `${job.script}\n[claim:invented-claim]` });
    const version = job.workflowSteps!.find((step) => step.id === "script")!.artifactVersionId!;
    await expect(approveNewsGate({ job: edited, user, gate: "script", artifactVersionId: version })).rejects.toThrow("unknown claim");
  });

  it("does not invoke editorial analysis or change the music-video draft path", async () => {
    const job = await createProduction(ProductionCreateRequest.parse({ contentType: "music_video", brief: "A warm cinematic journey through a sleeping city.", targetDurationSeconds: 60 }), user);
    expect(job.contentType).toBe("music_video");
    expect(job.editorialPlan).toBeUndefined();
    expect(job.visualPlan).toBeUndefined();
    expect(responsesCreate).not.toHaveBeenCalled();
  });
});
