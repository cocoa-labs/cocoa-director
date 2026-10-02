import { expect, test } from "@playwright/test";

test("an approved production exposes budget recovery while visual QA is still pending", async ({ page }, info) => {
  await page.request.post("/api/dev/reset-memory");
  const created = await page.request.post("/api/productions", {
    headers: { "Idempotency-Key": "browser-budget-recovery" },
    data: {
      contentType: "explainer", brief: "Explain the fictional study.", targetDurationSeconds: 60, qualityTier: "draft",
      sourceBundle: { inputs: [{ id: "study", kind: "text", text: Array.from({ length: 8 }, (_, index) => `Finding ${index + 1} describes a documented mechanism and the measured outcome within its stated limitations. Investigators checked the result against the supplied evidence before drawing a conclusion.`).join(" ") }], claims: [] },
    },
  });
  expect(created.ok()).toBe(true);
  const { productionId: id } = await created.json();
  const snapshot = await (await page.request.get(`/api/videos/${id}`)).json();
  const progress = await (await page.request.get(`/api/productions/${id}/progress`)).json();
  const job = snapshot.job;
  const scriptVersionId = job.workflowSteps.find((step: { id: string }) => step.id === "script").artifactVersionId;
  job.approvals = ["script", "storyboard"].map((gate) => ({ gate, artifactVersionId: job.workflowSteps.find((step: { id: string }) => step.id === gate).artifactVersionId, approvedBy: job.userId, approvedAt: new Date().toISOString() }));
  job.visualPlan.timingPlan = {
    version: 2, productionId: id, scriptVersionId, targetDurationMs: 60_000, compiledAt: new Date().toISOString(), pauses: [],
    scenes: job.storyboard.scenes.map((scene: { id: string }, index: number, scenes: unknown[]) => ({ sceneId: scene.id, startMs: index * 60_000 / scenes.length, speechStartMs: index * 60_000 / scenes.length, speechEndMs: (index * 60_000 + 52_398) / scenes.length, endMs: (index + 1) * 60_000 / scenes.length, measuredNarrationMs: 52_398 / scenes.length, retimeRate: 1 })),
    coverage: { version: 1, targetDurationMs: 60_000, spokenDurationMs: 52_398, spokenCoverage: 0.8733, longestUnapprovedGapMs: 1267, passed: true, findings: [] },
  };
  job.status = "awaiting_user";
  job.error = "This production's reserved budget is exhausted. Review its cost before recovery.";
  snapshot.state = "awaiting_user";
  snapshot.error = job.error;
  const beat = job.visualPlan.beats[0];
  beat.costEstimateCents = 8;
  Object.assign(progress, {
    state: "needs_attention", recoverable: true, nextAction: "resume_safe_recovery", activeStageId: "visuals", activeStageLabel: "Visuals and score",
    units: [{ id: `image:${beat.id}`, stageId: "visuals", label: "Unfinished image", kind: "image", state: "failed", attempt: 1, error: job.error, updatedAt: new Date().toISOString() }],
    costs: { ...progress.costs, maximumAuthorizedCents: 200, actualCents: 62, committedCents: 195, remainingAuthorizedCents: 5 },
    visualQuality: { state: "not_started", retainedAssetCount: 3, rejectedAssetCount: 0, rejectedBeatIds: [], autoPolishAttempts: 0, duplicateGroupCount: 0, findings: [], nextAction: "continue" },
  });
  await page.route(`**/api/videos/${id}`, (route) => route.fulfill({ json: snapshot }));
  await page.route(`**/api/productions/${id}/progress`, (route) => route.fulfill({ json: progress }));
  await page.goto(`/?production=${id}`);
  await page.getByRole("tablist", { name: "Creation sections" }).getByRole("tab", { name: /Review/ }).click();
  await expect(page.getByText("Production needs attention", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Waiting for your approval", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Script approved", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Storyboard approved", exact: true })).toBeDisabled();
  await expect(page.getByText(/Remaining allowance: \$0.05/)).toBeVisible();
  let recoveryRequests = 0;
  await page.route(`**/api/productions/${id}/recovery`, async (route) => { recoveryRequests += 1; await route.fulfill({ json: { resumed: true } }); });
  page.once("dialog", async (dialog) => { expect(dialog.message()).toContain("Authorize up to $0.62"); await dialog.dismiss(); });
  await page.getByRole("button", { name: "Review and resume unfinished visuals", exact: true }).click();
  expect(recoveryRequests).toBe(0);
  await page.screenshot({ path: info.outputPath("budget-recovery.png"), fullPage: true });

  job.status = "failed";
  snapshot.state = "failed";
  progress.activeStageLabel = "Render";
  progress.units = [];
  await page.reload();
  page.once("dialog", async (dialog) => { expect(dialog.message()).toContain("Authorize up to $0.50"); await dialog.dismiss(); });
  await page.getByRole("button", { name: "Resume from Render", exact: true }).click();
  expect(recoveryRequests).toBe(0);
});
