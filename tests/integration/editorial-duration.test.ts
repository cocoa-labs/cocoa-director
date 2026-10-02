import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProductionCreateRequest, type VideoJob } from "@/lib/schemas";
import { createProduction, regenerateNewsEditorialDraft } from "@/lib/server/productions";
import { getStore, resetInMemoryStoreForDev } from "@/lib/server/store";
import { approveNewsGate, updateNewsDraft } from "@/lib/server/news-editorial";
import { generateNarrationScene, narrationFingerprint, reconcileEditorialTiming } from "@/lib/server/news-delivery";
import { reserveBudget, productionBudgetSnapshot } from "@/lib/server/budget-ledger";
import { getUserContext } from "@/lib/server/auth";
import { POST as regenerate } from "@/app/api/productions/[id]/regenerate-editorial/route";

const { start } = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock("@/workflow/news", () => ({ runNewsProductionWorkflow: start, runNewsProductionWorkflowLegacy: start }));
const text = "The index measures actual rental transactions rather than listed prices. It records price and quantity for each hardware type. Each observation includes its region and timestamp. Weights reflect observed capacity across providers. Extreme observations receive a documented adjustment. The result updates every hour. Data gaps can suspend publication. These limitations matter when interpreting the reference.";

beforeEach(() => {
  vi.stubEnv("PROVIDER_MODE", "mock"); vi.stubEnv("DATABASE_URL", ""); vi.stubEnv("REQUIRE_AUTH", "false"); vi.stubEnv("DISABLE_BETA_AUTH", "true");
  vi.stubEnv("PROVIDER_CALLS_ENABLED", "true"); vi.stubEnv("DAILY_BUDGET_CAP_USD_GLOBAL", "1000"); vi.stubEnv("DAILY_BUDGET_CAP_USD_PER_USER", "1000");
  resetInMemoryStoreForDev(); start.mockReset();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function fixture() {
  const user = await getUserContext(new Request("http://localhost/api/productions"));
  const job = await createProduction(ProductionCreateRequest.parse({ contentType: "explainer", durationMode: "auto", targetDurationSeconds: 60, brief: "Explain the index and its important limitations.", qualityTier: "draft", sourceBundle: { inputs: [{ id: "source", kind: "text", title: "Index methodology", text }], claims: [] } }), user);
  return { user, job };
}
async function measurements(job: VideoJob, total = 62_035) {
  const scenes = job.storyboard!.scenes;
  const scriptVersion = job.workflowSteps!.find((step) => step.id === "script")!.artifactVersionId!;
  for (const [index, scene] of scenes.entries()) await getStore().createMediaAsset({ projectId: job.projectId, videoJobId: job.id, kind: "music", role: "narration_scene", url: `https://example.test/${index}.wav`, mimeType: "audio/wav", metadata: { sceneId: scene.id, scriptVersion, durationMs: Math.floor(total / scenes.length) + (index < total % scenes.length ? 1 : 0), narrationFingerprint: narrationFingerprint(scene.narration) } });
}

describe("natural runtime approvals and recovery", () => {
  it("shows coverage and a priced proposal before media, then requires explicit runtime acceptance", async () => {
    const { job, user } = await fixture();
    expect(job.durationPlan?.coverage.filter((point) => !point.included)).toHaveLength(0);
    expect(job.durationPlan).toMatchObject({ mode: "auto", needsReview: true });
    expect((await getStore().listJobMedia(job.id)).assets).toHaveLength(0);
    const script = job.workflowSteps!.find((step) => step.id === "script")!.artifactVersionId!;
    const storyboard = job.workflowSteps!.find((step) => step.id === "storyboard")!.artifactVersionId!;
    await approveNewsGate({ job, user, gate: "script", artifactVersionId: script });
    await expect(approveNewsGate({ job, user, gate: "storyboard", artifactVersionId: storyboard, confirmSpend: true })).rejects.toThrow("runtime");
    await approveNewsGate({ job, user, gate: "storyboard", artifactVersionId: storyboard, confirmSpend: true, acceptedDurationSeconds: job.durationSeconds });
    expect(start).toHaveBeenCalledOnce();
    expect((await getStore().getJob(job.id))!.durationPlan?.needsReview).toBe(false);
  });

  it("changes duration idempotently without rewriting the script or buying another take", async () => {
    const { job } = await fixture();
    await measurements(job);
    await getStore().updateJob(job.id, { durationPlan: { ...job.durationPlan!, approvedDurationSeconds: 65, approvedCostCents: 500, needsReview: false } });
    await reconcileEditorialTiming(job.id);
    const before = (await getStore().getJob(job.id))!;
    const key = randomUUID();
    const request = (target = 90) => new Request(`http://localhost/api/productions/${job.id}/regenerate-editorial`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify({ durationMode: "target", targetDurationSeconds: target, preserveScript: true }) });
    const response = await regenerate(request(), { params: Promise.resolve({ id: job.id }) });
    expect(response.status).toBe(200);
    const changed = (await getStore().getJob(job.id))!;
    expect(changed.script).toBe(before.script);
    expect(changed.durationPlan).toMatchObject({ mode: "target", requestedTargetSeconds: 90, needsReview: true });
    expect(changed.visualPlan?.timingPlan?.coverage.spokenDurationMs).toBe(62_035);
    expect(changed.visualPlan?.timingPlan?.scenes.every((scene) => scene.retimeRate === 1)).toBe(true);
    expect(changed.workflowSteps!.find((step) => step.id === "script")!.artifactVersionId).toBe(before.workflowSteps!.find((step) => step.id === "script")!.artifactVersionId);
    const mediaBefore = await getStore().listJobMedia(job.id);
    for (const scene of changed.storyboard!.scenes) await generateNarrationScene(job.id, scene.id);
    expect(await getStore().listJobMedia(job.id)).toEqual(mediaBefore);
    const replay = await regenerate(request(), { params: Promise.resolve({ id: job.id }) });
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect((await getStore().getJob(job.id))!.artifactVersions).toEqual(changed.artifactVersions);
    expect((await regenerate(request(120), { params: Promise.resolve({ id: job.id }) })).status).toBe(409);
  });

  it("rejects a scope change disguised as a duration-only revision", async () => {
    const { job } = await fixture();
    const request = new Request(`http://localhost/api/productions/${job.id}/regenerate-editorial`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID() }, body: JSON.stringify({ durationMode: "auto", preserveScript: true, excludedClaimIds: [job.sourceBundle!.claims[0].id] }) });
    const response = await regenerate(request, { params: Promise.resolve({ id: job.id }) });
    expect(response.status).toBe(400);
    expect((await getStore().getJob(job.id))!.artifactVersions).toEqual(job.artifactVersions);
  });

  it("pauses before further media on a changed measured scope or exhausted allowance", async () => {
    const { job, user } = await fixture();
    await measurements(job, 110_000);
    await getStore().updateJob(job.id, { durationPlan: { ...job.durationPlan!, approvedDurationSeconds: 60, approvedCostCents: 200, needsReview: false } });
    await reserveBudget({ user, scope: "test-runtime", key: "allowance", estimatedCostCents: 1, videoJobId: job.id, metadata: { videoJobId: job.id } });
    const before = await productionBudgetSnapshot(job.id);
    expect((await reconcileEditorialTiming(job.id)).requiresScriptRevision).toBe(true);
    const paused = (await getStore().getJob(job.id))!;
    expect(paused.status).toBe("awaiting_user");
    expect(paused.durationPlan?.rationale).toContain("allowance");
    expect(paused.visualPlan?.timingPlan?.coverage.spokenDurationMs).toBe(110_000);
    expect(await productionBudgetSnapshot(job.id)).toEqual(before);
    expect(start).not.toHaveBeenCalled();
  });

  it("preserves the full outline and saved visual assets when recorded narration exceeds ten minutes", async () => {
    const { job } = await fixture();
    await measurements(job, 610_000);
    const before = await getStore().listJobMedia(job.id);
    await reconcileEditorialTiming(job.id);
    const paused = (await getStore().getJob(job.id))!;
    expect(paused.durationPlan).toMatchObject({ scopeTooLong: true, needsReview: true });
    expect(paused.storyboard!.scenes.map((scene) => scene.narration)).toEqual(job.storyboard!.scenes.map((scene) => scene.narration));
    expect(paused.visualPlan!.beats).toHaveLength(job.visualPlan!.beats.length);
    expect(await getStore().listJobMedia(job.id)).toEqual(before);
    expect(start).not.toHaveBeenCalled();
  });

  it("records deliberate omissions when the user narrows scope", async () => {
    const { job, user } = await fixture();
    const excluded = job.sourceBundle!.claims.slice(2).map((claim) => claim.id);
    const narrowed = await regenerateNewsEditorialDraft(job, user, { durationMode: "auto", excludedClaimIds: excluded });
    expect(narrowed.durationPlan!.coverage.filter((point) => !point.included).map((point) => point.claimId)).toEqual(excluded);
    expect(narrowed.durationSeconds).toBeLessThan(job.durationSeconds);
    expect(narrowed.sourceBundle!.claims).toHaveLength(job.sourceBundle!.claims.length);
  });

  it("changes visual identities when the source scope changes while keeping duration-only edits stable", async () => {
    const { job, user } = await fixture();
    const revised = await regenerateNewsEditorialDraft(job, user, { durationMode: "target", targetDurationSeconds: 90, preserveScript: true });
    const originalIds = new Set(job.visualPlan!.beats.map((beat) => beat.id));
    expect(revised.visualPlan!.beats.filter((beat) => !beat.id.includes("-natural-")).every((beat) => originalIds.has(beat.id))).toBe(true);
    const narrowed = await regenerateNewsEditorialDraft(revised, user, { durationMode: "auto", excludedClaimIds: job.sourceBundle!.claims.slice(1).map((claim) => claim.id) });
    const retainedScene = narrowed.storyboard!.scenes[0];
    const originalScene = job.storyboard!.scenes.find((scene) => scene.id === retainedScene.id)!;
    if (retainedScene.narration !== originalScene.narration) expect(narrowed.visualPlan!.beats.every((beat) => !originalIds.has(beat.id))).toBe(true);
    expect(narrowed.approvals).toHaveLength(0);
  });

  it("invalidates duration approval on script edits and preserves the narrator fingerprint only for identical voice settings", async () => {
    const { job } = await fixture();
    const approved = await getStore().updateJob(job.id, { durationPlan: { ...job.durationPlan!, approvedDurationSeconds: job.durationSeconds, approvedCostCents: 500, needsReview: false } });
    const edited = await updateNewsDraft({ job: approved, script: `${job.script}\n\nThe reference has stated limitations.` });
    expect(edited.durationPlan?.needsReview).toBe(true);
    expect(edited.durationPlan?.approvedDurationSeconds).toBeUndefined();
    expect(edited.approvals).toHaveLength(0);
    expect(narrationFingerprint(text, "voice-one")).not.toBe(narrationFingerprint(text, "voice-two"));
    expect(narrationFingerprint(` ${text}  `, "voice-one")).toBe(narrationFingerprint(text, "voice-one"));
  });
});
