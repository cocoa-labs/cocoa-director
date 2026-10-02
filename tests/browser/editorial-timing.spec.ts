import { expect, test } from "@playwright/test";

test("a measured narration overrun offers recovery instead of approval or a working spinner", async ({ page }, info) => {
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
  const durations = [6_032, 11_872, 9_364, 14_565, 10_049, 10_153];
  let cursor = 0;
  job.visualPlan.timingPlan = {
    version: 2, productionId: id, scriptVersionId, targetDurationMs: 60_000, compiledAt: new Date().toISOString(), pauses: [],
    scenes: job.storyboard.scenes.map((scene: { id: string }, index: number) => {
      const startMs = cursor; cursor += durations[index];
      return { sceneId: scene.id, startMs, speechStartMs: startMs, speechEndMs: cursor, endMs: cursor, measuredNarrationMs: durations[index], retimeRate: 1 };
    }),
    coverage: { version: 1, targetDurationMs: 60_000, spokenDurationMs: 62_035, spokenCoverage: 1.0339, longestUnapprovedGapMs: 0, passed: false, findings: [{ code: "narration.overrun", severity: "blocking", message: "Narration exceeds the selected duration." }] },
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
  await expect(page.getByRole("button", { name: "Condense to 1:00", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve script", exact: true })).toHaveCount(0);
  await expect(page.getByText("Script revision needed", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Working", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/103% measured spoken coverage/)).toBeVisible();
  await expect(page.getByText(/Recorded narration is 62.0 seconds/).first()).toBeVisible();
  await page.screenshot({ path: info.outputPath("measured-timing-recovery.png"), fullPage: true });
});
