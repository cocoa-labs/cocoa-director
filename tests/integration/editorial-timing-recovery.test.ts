import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { editorialNarrationTiming, editorialReviewStatus } from "@/lib/editorial-narration";
import { narrationBudgetSummary, buildHybridVisualPlan } from "@/lib/hybrid-visuals";
import { initialWorkflowSteps } from "@/lib/production";
import { EditorialTimingPlan, ProductionCreateRequest, SourceBundle, VideoCreateRequest, type VideoJob } from "@/lib/schemas";
import { assertNarrationFits, reconcileEditorialTiming } from "@/lib/server/news-delivery";
import { approveNewsGate, updateNewsDraft } from "@/lib/server/news-editorial";
import { fitProductionEditorialDraft } from "@/lib/server/productions";
import { getStore, resetInMemoryStoreForDev } from "@/lib/server/store";
import { buildSourceFirstDraft } from "@/workflow/source-first";

const user = { id: "timing-regression", email: "timing@example.com", planTier: "dev" as const, dailyBudgetCents: 10_000 };
const scriptVersion = "51000000-0000-4000-8000-000000000001";
const recordedDurations = [6_032, 11_872, 9_364, 14_565, 10_049, 10_153];

describe("measured editorial timing recovery", () => {
  beforeEach(() => {
    vi.stubEnv("PROVIDER_MODE", "mock");
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("EDITORIAL_TIMING_V2_ENABLED", "true");
    resetInMemoryStoreForDev();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("recovers the 62-second narration without reapproving or reusing its old audio", async () => {
    const draft = await fixture();
    expect(narrationBudgetSummary(draft.script!, 60).predictedDurationMs).toBe(51_064);
    await addMeasurements(draft, recordedDurations);
    const result = await reconcileEditorialTiming(draft.id);
    expect(result.requiresScriptRevision).toBe(true);
    const blocked = (await getStore().getJob(draft.id))!;
    expect(EditorialTimingPlan.parse(blocked.visualPlan!.timingPlan).coverage.spokenCoverage).toBe(1.0339);
    expect(editorialNarrationTiming(blocked)).toMatchObject({ measured: true, durationMs: 62_035, requiresRevision: true });
    expect(editorialReviewStatus(blocked)?.title).toBe("Script revision needed");
    expect(blocked.approvals).toEqual([]);
    await expect(approveNewsGate({ job: blocked, user, gate: "script", artifactVersionId: scriptVersion })).rejects.toThrow("Recorded narration");

    const fitted = await fitProductionEditorialDraft(blocked, user);
    const timing = editorialNarrationTiming(fitted);
    expect(timing).toMatchObject({ measured: false, requiresRevision: false });
    expect(timing.budget.words).toBeLessThan(120);
    expect(timing.budget.wordsPerSecond).toBeCloseTo(120 / 62.035);
    expect(timing.coverage).toBeGreaterThanOrEqual(0.85);
    expect(timing.coverage).toBeLessThanOrEqual(0.92);
    expect(fitted.visualPlan?.timingPlan).toBeUndefined();
    expect(fitted.approvals).toEqual([]);
    expect(fitted.storyboard?.scenes.every((scene) => scene.claimIds.length && scene.sourceIds.length)).toBe(true);
    const revisedVersion = fitted.workflowSteps!.find((step) => step.id === "script")!.artifactVersionId!;
    expect(revisedVersion).not.toBe(scriptVersion);
    await expect(approveNewsGate({ job: fitted, user, gate: "script", artifactVersionId: scriptVersion })).rejects.toThrow("stale");
    const approved = await approveNewsGate({ job: fitted, user, gate: "script", artifactVersionId: revisedVersion });
    expect(approved.status).toBe("awaiting_user");
    expect(approved.workflowSteps?.find((step) => step.id === "storyboard_approval")?.state).toBe("awaiting_user");
    // The old assets remain durable, but cannot satisfy a new script version.
    await expect(reconcileEditorialTiming(fitted.id)).rejects.toThrow("Measured narration is missing");
    await addMeasurements(fitted, fitted.storyboard!.scenes.map((scene) => Math.round(scene.narration.split(/\s+/).length / timing.budget.wordsPerSecond * 1_000)));
    expect((await reconcileEditorialTiming(fitted.id)).timingPlan?.coverage.passed).toBe(true);
  });

  it("accepts measured narration that fits with the permitted small speed adjustment", async () => {
    const draft = await fixture();
    await addMeasurements(draft, Array(6).fill(9_300));
    expect((await reconcileEditorialTiming(draft.id)).timingPlan?.coverage.passed).toBe(true);
    const measured = (await getStore().getJob(draft.id))!;
    expect(editorialNarrationTiming(measured).requiresRevision).toBe(false);
    await expect(approveNewsGate({ job: measured, user, gate: "script", artifactVersionId: scriptVersion })).resolves.toBeDefined();
  });

  it("keeps measured timing authoritative at delivery for a faster recorded voice", async () => {
    const draft = await fixture();
    const storyboard = { ...draft.storyboard!, scenes: draft.storyboard!.scenes.map((scene) => ({ ...scene, narration: `${scene.narration} ${scene.narration}` })) };
    const updated = await getStore().updateJob(draft.id, { storyboard, script: storyboard.scenes.map((scene) => scene.narration).join("\n\n") });
    await addMeasurements(updated, Array(6).fill(9_000));
    expect((await reconcileEditorialTiming(updated.id)).timingPlan?.coverage.passed).toBe(true);
    const measured = (await getStore().getJob(updated.id))!;
    const assets = measured.storyboard!.scenes.map((scene) => ({
      targetDurationMs: scene.endMs - scene.startMs,
      narration: { audio: Buffer.alloc(0), durationMs: 9_000, contentType: "audio/mpeg", costCents: 0, words: scene.narration.split(/\s+/).map((text, index) => ({ text, startMs: index * 200, endMs: index * 200 + 200 })) },
    }));
    expect(narrationBudgetSummary(measured.script!, 60).withinBudget).toBe(false);
    expect(() => assertNarrationFits(measured, assets)).not.toThrow();
    expect(() => assertNarrationFits(measured, [{ ...assets[0], targetDurationMs: 2_000 }])).toThrow("will not truncate narration");
  });

  it("supports already-saved timing reports and preserves calibration after manual edits", async () => {
    const draft = await fixture();
    await addMeasurements(draft, recordedDurations);
    await reconcileEditorialTiming(draft.id);
    const blocked = (await getStore().getJob(draft.id))!;
    const legacyPlan = { ...blocked.visualPlan!, narrationWordsPerSecond: undefined, timingPlan: { ...blocked.visualPlan!.timingPlan!, scriptVersionId: undefined } };
    const legacy = await getStore().updateJob(draft.id, { visualPlan: legacyPlan });
    expect(editorialNarrationTiming(legacy).measured).toBe(true);
    const paragraphs = legacy.storyboard!.scenes.map((scene, index) => index < 2 ? scene.narration.split(/(?<=[.!?])\s+/)[0] : scene.narration);
    const edited = await updateNewsDraft({ job: legacy, script: paragraphs.join("\n\n") });
    expect(editorialNarrationTiming(edited)).toMatchObject({ measured: false, requiresRevision: false });
    expect(edited.visualPlan?.narrationWordsPerSecond).toBeCloseTo(120 / 62.035);
    expect(edited.visualPlan?.timingPlan).toBeUndefined();
    // A stale report may not override a newer script's estimate.
    const stale = { ...edited, visualPlan: { ...edited.visualPlan!, timingPlan: blocked.visualPlan!.timingPlan } };
    expect(editorialNarrationTiming(stale).measured).toBe(false);
    expect(editorialReviewStatus({ ...blocked, contentType: "music_video" })).toBeUndefined();
  });
});

async function fixture() {
  const store = getStore();
  const job = await store.createJob(VideoCreateRequest.parse({ prompt: "Explain the supplied research.", durationSeconds: 60 }), user);
  const outline = Array.from({ length: 6 }, (_, index) => ({
    id: `scene-${index + 1}`, title: `Finding ${index + 1}`,
    narration: "This documented finding explains the mechanism through careful source analysis. The measured evidence supports this conclusion within the stated limitations.",
    visual: "Show the cited evidence with a clear explanatory diagram.", claimIds: [`claim-${index + 1}`], sourceIds: ["source-1"],
  }));
  const sourceBundle = SourceBundle.parse({
    inputs: [{ id: "source-1", kind: "text", title: "Research report", text: outline.map((scene) => scene.narration).join(" ") }],
    claims: outline.map((scene) => ({ id: scene.claimIds[0], text: scene.narration, sourceIds: scene.sourceIds, confidence: 1, status: "supported", editorialStatus: "draft", evidence: [scene.narration], evidenceRefs: [{ sourceId: "source-1", excerpt: scene.narration, excerptHash: "a".repeat(64) }], breaking: false })),
  });
  const request = ProductionCreateRequest.parse({ contentType: "explainer", brief: job.prompt, targetDurationSeconds: 60, qualityTier: "draft", sourceBundle });
  const createdAt = "2026-01-01T00:00:00.000Z";
  const draft = buildSourceFirstDraft(job.id, request, createdAt, outline);
  const visualPlan = buildHybridVisualPlan({ productionId: job.id, request, storyboard: draft.storyboard, createdAt, directionVersion: 4 });
  return store.updateJob(job.id, {
    ...draft, visualPlan, contentType: "explainer", qualityTier: "draft", status: "running",
    artifactVersions: [{ id: scriptVersion, scope: "script", label: "Script v1", payload: draft.script, urls: {}, createdAt }],
    workflowSteps: initialWorkflowSteps("explainer").map((step) => ({ ...step, state: "complete", ...(step.id === "script" ? { artifactVersionId: scriptVersion } : {}) })),
    approvals: [{ gate: "script", artifactVersionId: scriptVersion, approvedBy: user.id, approvedAt: createdAt }],
  });
}

async function addMeasurements(job: VideoJob, durations: number[]) {
  const version = job.workflowSteps!.find((step) => step.id === "script")!.artifactVersionId;
  for (const [index, scene] of job.storyboard!.scenes.entries()) {
    await getStore().createMediaAsset({ projectId: job.projectId, videoJobId: job.id, kind: "music", role: "narration_scene", url: `https://example.com/narration-${version}-${index}.mp3`, mimeType: "audio/mpeg", metadata: { sceneId: scene.id, scriptVersion: version, durationMs: durations[index] } });
  }
}
