import { expect, test } from "@playwright/test";

for (const recordingOnly of [false, true]) test(`a measured narration ${recordingOnly ? "near miss retains its recording" : "overrun offers script recovery"}`, async ({ page }, info) => {
  await page.request.post("/api/dev/reset-memory");
  const created = await page.request.post("/api/productions", {
    headers: { "Idempotency-Key": "browser-measured-narration" },
    data: {
      contentType: "explainer", brief: "Explain this fictional research report.", targetDurationSeconds: 60, qualityTier: "draft",
      sourceBundle: { inputs: [{ id: "report", kind: "text", title: "Research report", text: Array.from({ length: 8 }, (_, index) => `Finding ${index + 1} describes a documented mechanism and the measured outcome within its stated limitations. Investigators checked the result against the supplied evidence before drawing a conclusion.`).join(" ") }], claims: [] },
    },
  });
  expect(created.ok()).toBe(true);
  const { productionId: id } = await created.json();
  const snapshot = await (await page.request.get(`/api/videos/${id}`)).json();
  const job = snapshot.job;
  const scriptVersionId = job.workflowSteps.find((step: { id: string }) => step.id === "script").artifactVersionId;
  const narration = "This documented finding explains the mechanism through careful source analysis. The measured evidence supports this conclusion within the stated limitations.";
  job.storyboard.scenes = Array.from({ length: 6 }, (_, index) => ({ ...job.storyboard.scenes[0], id: `scene-${index}`, title: `Finding ${index}`, narration }));
  job.script = job.storyboard.scenes.map(() => narration).join("\n\n");
  const durations = recordingOnly ? [7_669, 9_000, 12_000, 8_261, 13_791, 7_135] : [6_032, 11_872, 9_364, 14_565, 10_049, 10_153];
  const totalMs = durations.reduce((sum, value) => sum + value, 0);
  const fitButton = recordingOnly ? "Fit recording to 1:00" : "Condense to 1:00";
  let cursor = 0;
  job.visualPlan.timingPlan = {
    version: 2, productionId: id, scriptVersionId, targetDurationMs: 60_000, compiledAt: new Date().toISOString(), pauses: [],
    scenes: job.storyboard.scenes.map((scene: { id: string }, index: number) => {
      const startMs = cursor; cursor += durations[index];
      return { sceneId: scene.id, startMs, speechStartMs: startMs, speechEndMs: cursor, endMs: cursor, measuredNarrationMs: durations[index], retimeRate: 1 };
    }),
    coverage: { version: 1, targetDurationMs: 60_000, spokenDurationMs: totalMs, spokenCoverage: totalMs / 60_000, longestUnapprovedGapMs: 0, passed: false, findings: [{ code: "narration.overrun", severity: "blocking", message: "Narration exceeds the selected duration." }] },
  };
  job.status = "awaiting_user";
  job.approvals = [];
  job.error = "Editorial timing requires script revision.";
  snapshot.state = "awaiting_user";
  snapshot.error = job.error;
  await page.route(`**/api/videos/${id}`, (route) => route.fulfill({ json: snapshot }));
  await page.goto(`/?production=${id}`);
  await page.getByRole("tablist", { name: "Creation sections" }).getByRole("tab", { name: /Review/ }).click();
  await expect(page.getByText("Measured narration", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: fitButton, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve script", exact: true })).toHaveCount(0);
  await expect(page.getByText(recordingOnly ? "Timing adjustment needed" : "Script revision needed", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Working", { exact: true })).toHaveCount(0);
  await expect(page.getByText(recordingOnly ? /96% measured spoken coverage/ : /103% measured spoken coverage/)).toBeVisible();
  await expect(page.getByText(recordingOnly ? /Recorded narration is 57.9 seconds/ : /Recorded narration is 62.0 seconds/).first()).toBeVisible();
  await page.screenshot({ path: info.outputPath("measured-timing-recovery.png"), fullPage: true });
  let releaseFit!: () => void;
  const fitPending = new Promise<void>((resolve) => { releaseFit = resolve; });
  await page.route(`**/api/productions/${id}/fit-editorial`, async (route) => {
    expect(route.request().headers()["idempotency-key"]).toBeTruthy();
    await fitPending;
    if (recordingOnly) {
      job.visualPlan.timingPlan.coverage = { ...job.visualPlan.timingPlan.coverage, passed: true, spokenDurationMs: 55_200, spokenCoverage: 0.92, findings: [] };
      job.visualPlan.timingPlan.scenes.forEach((scene: { retimeRate: number }) => { scene.retimeRate = totalMs / 55_200; });
    } else {
      job.visualPlan.timingPlan = undefined;
      job.visualPlan.narrationWordsPerSecond = 120 / 62.035;
      job.storyboard.scenes.forEach((scene: { narration: string }) => { scene.narration = scene.narration.split(" ").slice(0, 17).join(" "); });
      job.script = job.storyboard.scenes.map((scene: { narration: string }) => scene.narration).join("\n\n");
    }
    job.error = null;
    snapshot.error = null;
    await route.fulfill({ json: { fitted: true, productionId: id } });
  });
  await page.getByRole("button", { name: fitButton, exact: true }).click();
  await expect(page.getByRole("button", { name: recordingOnly ? "Fitting recording..." : "Fitting script...", exact: true })).toBeDisabled();
  await expect(page.getByRole("status").filter({ hasText: recordingOnly ? "Fitting the saved recording" : "Fitting the script to duration" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Starting|Staging/ })).toHaveCount(0);
  releaseFit();
  await expect(page.getByRole("button", { name: "Approve script", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Fitting script...", exact: true })).toHaveCount(0);
  await expect(page.getByText("Waiting for your approval", { exact: true }).first()).toBeVisible();
  if (recordingOnly) {
    await expect(page.getByText("Fitted narration", { exact: true })).toBeVisible();
    await expect(page.getByText(/Recorded 57.9 seconds; playback at 1.048× pace/)).toBeVisible();
    await expect(page.getByRole("textbox").first()).toHaveValue(job.script);
  }
});
