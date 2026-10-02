import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as recover } from "@/app/api/productions/[id]/recovery/route";
import { buildHybridVisualPlan } from "@/lib/hybrid-visuals";
import { initialWorkflowSteps, workflowProfileFor } from "@/lib/production";
import { ProductionCreateRequest, VideoCreateRequest } from "@/lib/schemas";
import * as config from "@/lib/server/config";
import { productionBudgetSnapshot, reserveBudget, reserveProviderAttempt } from "@/lib/server/budget-ledger";
import { prepareHybridVisualBeat } from "@/lib/server/hybrid-assets";
import { latestFailedVisuals } from "@/lib/server/production-recovery";
import { getStore, resetInMemoryStoreForDev } from "@/lib/server/store";
import { buildSourceFirstDraft } from "@/workflow/source-first";

const { resumeHook, start, generateMedia } = vi.hoisted(() => ({ resumeHook: vi.fn(), start: vi.fn(), generateMedia: vi.fn() }));
vi.mock("workflow/api", () => ({ resumeHook, start }));
vi.mock("@/lib/server/media", () => ({ createProjectMediaGeneration: generateMedia, pollProjectMediaGenerations: vi.fn() }));
const owner = { id: "image-recovery-owner", email: "recovery@example.test", planTier: "dev" as const, dailyBudgetCents: 10_000 };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.stubEnv("PROVIDER_MODE", "mock");
  vi.stubEnv("PROVIDER_CALLS_ENABLED", "true");
  vi.stubEnv("DATABASE_URL", "");
  vi.stubEnv("REQUIRE_AUTH", "false");
  vi.stubEnv("DISABLE_BETA_AUTH", "true");
  vi.stubEnv("HYBRID_SAFE_RECOVERY_ENABLED", "true");
  vi.stubEnv("DAILY_BUDGET_CAP_USD_GLOBAL", "100");
  vi.spyOn(config, "assertLiveEnvironmentReady").mockImplementation(() => {});
  resetInMemoryStoreForDev();
  resumeHook.mockReset(); start.mockReset(); generateMedia.mockReset();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("draft image recovery through the HTTP endpoint", () => {
  it.each(["complete", "pending"] as const)("resumes the budget-blocked image with narration marked %s and retains approved work", async (narrationState) => {
    const { job, failed, ready, token } = await fixture(narrationState);
    const beforeMedia = await getStore().listJobMedia(job.id);
    const key = randomUUID();
    const response = await recover(request(job.id, [failed.controls.visualBeatId as string], key), { params: Promise.resolve({ id: job.id }) });
    expect(await response.clone().json()).toMatchObject({ resumed: true });
    expect(response.status).toBe(202);
    expect(resumeHook).toHaveBeenCalledExactlyOnceWith(token, { action: "safe_retry", beatIds: [failed.controls.visualBeatId] });
    expect(start).not.toHaveBeenCalled();
    const recovered = (await getStore().getJob(job.id))!;
    expect(recovered.approvals).toEqual(job.approvals);
    expect(recovered.workflowVersion).toBe(job.workflowVersion);
    expect(recovered.workflowSteps?.find((step) => step.id === "narration")?.state).toBe("complete");
    expect(await getStore().listJobMedia(job.id)).toEqual(beforeMedia);
    expect(beforeMedia.assets).toHaveLength(4);
    expect(recovered.visualPlan?.timingPlan).toEqual(job.visualPlan?.timingPlan);
    expect(ready).toHaveLength(3);
    expect(await productionBudgetSnapshot(job.id)).toEqual({ authorizedCents: 257, committedCents: 195, remainingCents: 62 });
    const replay = await recover(request(job.id, [failed.controls.visualBeatId as string], key), { params: Promise.resolve({ id: job.id }) });
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect(resumeHook).toHaveBeenCalledTimes(1);
  });

  it("leaves all saved work intact when the remaining recovery exceeds the daily cap", async () => {
    const { job, failed } = await fixture();
    vi.stubEnv("DAILY_BUDGET_CAP_USD_GLOBAL", "2.50");
    const before = await getStore().getJob(job.id);
    const response = await recover(request(job.id, [failed.controls.visualBeatId as string], randomUUID(), true), { params: Promise.resolve({ id: job.id }) });
    expect(response.status).toBe(429);
    expect(await getStore().getJob(job.id)).toEqual(before);
    expect(resumeHook).not.toHaveBeenCalled();
  });

  it("rejects an already successful or unknown selection before changing the job or allowance", async () => {
    const { job, ready } = await fixture();
    const before = await getStore().getJob(job.id);
    const budget = await productionBudgetSnapshot(job.id);
    for (const beatId of [ready[0].controls.visualBeatId as string, "scene-unknown-beat-01"]) {
      const response = await recover(request(job.id, [beatId], randomUUID(), true), { params: Promise.resolve({ id: job.id }) });
      expect(response.status).toBe(409);
      expect(await getStore().getJob(job.id)).toEqual(before);
      expect(await productionBudgetSnapshot(job.id)).toEqual(budget);
    }
    expect(resumeHook).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("submits a fresh image attempt on retry and does not regenerate a successful image", async () => {
    const { job, failed, ready } = await fixture();
    const beatId = failed.controls.visualBeatId as string;
    generateMedia.mockImplementation(async (_projectId, input) => {
      const generation = await getStore().createMediaGeneration({ projectId: job.projectId, videoJobId: job.id, kind: "image", provider: "mock", model: "mock-image", status: generateMedia.mock.calls.length === 1 ? "failed" : "success", prompt: input.prompt, controls: input.controls, inputAssetIds: [], outputUrls: {}, metadata: { idempotencyKey: input.idempotencyKey }, costCents: 0 });
      return { generation, assets: [] };
    });
    vi.advanceTimersByTime(1);
    const retry = await prepareHybridVisualBeat(job.id, beatId, { retryFailed: true, attempt: 2, recoveryOfGenerationId: failed.id });
    expect(retry?.status).toBe("failed");
    expect(generateMedia).toHaveBeenCalledTimes(1);
    expect(generateMedia.mock.calls[0][1].idempotencyKey).toBe(`${job.id}:visual:${beatId}:image:v1:retry:r2`);
    expect(retry?.metadata.recoveryOfGenerationId).toBe(failed.id);
    vi.advanceTimersByTime(1);
    const result = await prepareHybridVisualBeat(job.id, beatId, { retryFailed: true, attempt: 3, recoveryOfGenerationId: retry!.id });
    expect(result?.status).toBe("success");
    expect(generateMedia.mock.calls[1][1].idempotencyKey).toBe(`${job.id}:visual:${beatId}:image:v1:retry:r3`);
    await prepareHybridVisualBeat(job.id, ready[0].controls.visualBeatId as string, { retryFailed: true, attempt: 2 });
    expect(generateMedia).toHaveBeenCalledTimes(2);
    expect(latestFailedVisuals((await getStore().listJobMedia(job.id)).generations)).toEqual([]);
  });
});

function request(id: string, beatIds: string[], key: string, confirmSpend = false) {
  return new Request(`http://localhost/api/productions/${id}/recovery`, { method: "POST", headers: { "x-user-id": owner.id, "Idempotency-Key": key, "Content-Type": "application/json" }, body: JSON.stringify({ action: "safe_retry", beatIds, confirmSpend }) });
}

async function fixture(narrationState: "complete" | "pending" = "complete") {
  const store = getStore();
  const base = await store.createJob(VideoCreateRequest.parse({ prompt: "Explain the supplied synthetic research report.", durationSeconds: 60 }), owner);
  const outline = Array.from({ length: 6 }, (_, index) => ({ id: `scene-${index + 1}`, title: `Finding ${index + 1}`, narration: "The documented experiment shows a measured result within the stated conditions and preserves the limitations of its evidence.", visual: "Show an evidence-linked editorial diagram.", claimIds: [`claim-${index + 1}`], sourceIds: ["report"] }));
  const request = ProductionCreateRequest.parse({ contentType: "explainer", brief: base.prompt, qualityTier: "draft", targetDurationSeconds: 60, sourceBundle: { inputs: [{ id: "report", kind: "text", text: outline.map((scene) => scene.narration).join(" ") }], claims: outline.map((scene) => ({ id: scene.claimIds[0], text: scene.narration, sourceIds: ["report"], confidence: 1, status: "supported", evidence: [scene.narration], evidenceRefs: [{ sourceId: "report", excerpt: scene.narration, excerptHash: "a".repeat(64) }] })) } });
  const draft = buildSourceFirstDraft(base.id, request, new Date().toISOString(), outline);
  const visualPlan = buildHybridVisualPlan({ productionId: base.id, request, storyboard: draft.storyboard, createdAt: new Date().toISOString(), directionVersion: 4 });
  if (!visualPlan) throw new Error("Expected an explainer visual plan.");
  const versions = { script: randomUUID(), storyboard: randomUUID() };
  const now = new Date().toISOString();
  visualPlan.timingPlan = { version: 2, productionId: base.id, scriptVersionId: versions.script, targetDurationMs: 60_000, compiledAt: now, pauses: [], scenes: draft.storyboard.scenes.map((scene, index) => ({ sceneId: scene.id, startMs: index * 10_000, speechStartMs: index * 10_000, speechEndMs: index * 10_000 + 8_733, endMs: (index + 1) * 10_000, measuredNarrationMs: 8_733, retimeRate: 1 })), coverage: { version: 1, targetDurationMs: 60_000, spokenDurationMs: 52_398, spokenCoverage: 0.8733, longestUnapprovedGapMs: 1267, passed: true, findings: [] } };
  const job = await store.updateJob(base.id, { ...draft, visualPlan, contentType: "explainer", qualityTier: "draft", status: "awaiting_user", workflowVersion: workflowProfileFor("explainer").id, recoveryBudgetCents: 8, recoverySpentCents: 0, workflowSteps: initialWorkflowSteps("explainer").map((step) => ({ ...step, state: step.id === "generation" ? "awaiting_user" : step.id === "narration" ? narrationState : "complete", ...((step.id === "script" || step.id === "storyboard") ? { artifactVersionId: versions[step.id] } : {}) })), approvals: ["script", "storyboard"].map((gate) => ({ gate: gate as "script" | "storyboard", artifactVersionId: versions[gate as keyof typeof versions], approvedBy: owner.id, approvedAt: now })) });
  const beats = job.visualPlan!.beats.filter((beat) => beat.kind === "editorial_image");
  expect(beats).toHaveLength(4);
  const generations = [];
  for (const [index, beat] of beats.entries()) {
    generations.push(await store.createMediaGeneration({ projectId: job.projectId, videoJobId: job.id, kind: "image", provider: "mock", model: "mock-image", status: index === 0 ? "failed" : "success", prompt: beat.intent, controls: { visualBeatId: beat.id }, inputAssetIds: [], outputUrls: {}, metadata: { idempotencyKey: `${job.id}:visual:${beat.id}:image:v1` }, costCents: 0, error: index === 0 ? "This production's reserved budget is exhausted." : undefined }));
    if (index > 0) await store.createMediaAsset({ projectId: job.projectId, videoJobId: job.id, generationId: generations[index].id, kind: "image", role: "visual_beat", url: `https://example.test/${generations[index].id}.png`, mimeType: "image/png", metadata: { visualBeatId: beat.id } });
  }
  await store.createMediaAsset({ projectId: job.projectId, videoJobId: job.id, kind: "music", role: "narration_scene", url: "https://example.test/narration.wav", mimeType: "audio/wav", metadata: { scriptVersion: versions.script } });
  const token = `production-recovery:${job.id}:1`;
  await store.createProductionWorkflowRun({ productionId: job.id, runId: `run-${job.id}`, kind: "main", workflowVersion: workflowProfileFor("explainer").id, state: "awaiting_user", recoveryToken: token, metadata: {}, startedAt: now, heartbeatAt: now });
  await reserveBudget({ user: owner, scope: "create", videoJobId: job.id, estimatedCostCents: 257 });
  vi.stubEnv("PROVIDER_MODE", "live");
  await reserveProviderAttempt({ videoId: job.id, scope: "existing-work", costCents: 195 });
  vi.stubEnv("PROVIDER_MODE", "mock");
  return { job, failed: generations[0], ready: generations.slice(1), token };
}
