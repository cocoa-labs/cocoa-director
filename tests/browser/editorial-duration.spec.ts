import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

test("new editorial length defaults are distinct from restored fixed projects", async ({ page }, info) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Explainer Source-first/ }).click();
  await page.getByRole("tablist", { name: "Creation sections" }).getByRole("tab", { name: /Direction/ }).click();
  await expect(page.getByLabel("Video length", { exact: true })).toHaveValue("auto");
  await expect(page.getByRole("slider", { name: "Duration", exact: true })).toHaveCount(0);
  await page.getByLabel("Video length", { exact: true }).selectOption("target");
  await expect(page.getByText(/approximate target allows ±20%/)).toBeVisible();
  await expect(page.getByRole("slider", { name: "Duration", exact: true })).toHaveAttribute("max", "600");
  await page.screenshot({ path: info.outputPath("approximate-length.png"), fullPage: true });
  const created = await page.request.post("/api/productions", { headers: { "Idempotency-Key": randomUUID() }, data: { contentType: "explainer", brief: "Explain this supplied source clearly.", targetDurationSeconds: 60, qualityTier: "draft", sourceBundle: { inputs: [{ id: "notes", kind: "text", text: "The index measures observed prices. The methodology records completed transactions rather than advertised offers. Data gaps limit its coverage." }], claims: [] } } });
  expect(created.ok()).toBe(true);
  const { productionId } = await created.json();
  await page.goto(`/?production=${productionId}`);
  await page.getByRole("tablist", { name: "Creation sections" }).getByRole("tab", { name: /Direction/ }).click();
  await expect(page.getByLabel("Video length", { exact: true })).toHaveValue("fixed");
  await expect(page.getByRole("slider", { name: "Duration", exact: true })).toHaveValue("60");
});

test("the editorial clock follows native playback and seeking", async ({ page }) => {
  const created = await page.request.post("/api/productions", { headers: { "Idempotency-Key": randomUUID() }, data: { contentType: "explainer", durationMode: "auto", brief: "Explain this supplied source clearly.", qualityTier: "draft", sourceBundle: { inputs: [{ id: "notes", kind: "text", text: "The method measures actual transactions. It records observed prices for each region and preserves the stated limitations." }], claims: [] } } });
  expect(created.ok()).toBe(true);
  const { productionId: id } = await created.json();
  const snapshot = await (await page.request.get(`/api/videos/${id}`)).json();
  snapshot.job.status = "complete";
  snapshot.job.finalVideoUrl = "/api/demo/media?kind=video&duration=10";
  snapshot.job.durationSeconds = 60; // Deliberately differs from the selected media.
  snapshot.state = "complete";
  await page.route(`**/api/videos/${id}`, (route) => route.fulfill({ json: snapshot }));
  await page.goto(`/?production=${id}`);
  const video = page.locator(".preview-stage video");
  await expect(video).toBeVisible();
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThan(0);
  await expect(page.getByLabel("Playback position", { exact: true })).toHaveText("0:00");
  await video.evaluate((element: HTMLVideoElement) => { element.currentTime = 3; });
  await expect(page.getByLabel("Playback position", { exact: true })).toHaveText("0:03");
  const duration = await video.evaluate((element: HTMLVideoElement) => element.duration);
  const width = await page.locator(".transport-track > div").evaluate((element: HTMLElement) => element.style.width);
  expect(parseFloat(width)).toBeCloseTo(3 / duration * 100, 0);
});
