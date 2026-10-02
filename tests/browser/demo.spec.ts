import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

async function workspace(page: Page, name: string) {
  const mobile = page.getByRole("button", { name: "Open studio navigation", exact: true });
  if (await mobile.isVisible()) await mobile.click();
  await page.getByRole("navigation", { name: "Studio", exact: true }).getByRole("button", { name, exact: true }).click();
}

test.beforeEach(async ({ page }) => {
  const response = await page.request.post("/api/dev/reset-memory");
  expect(response.ok()).toBe(true);
});

test("music autopilot, playback, artifact download and project recovery", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto("/");
  await expect(page.getByText(/Demo mode · Synthetic media/)).toBeVisible();
  await expect(page.getByRole("textbox", { name: /access code/i })).toHaveCount(0);
  await page.getByLabel("Prompt / concept").fill("A paper lantern sails into the city at sunrise. Hopeful electronic soul and warm cinematic light.");
  await page.getByRole("button", { name: "Continue to direction" }).click();
  await page.getByRole("slider", { name: "Duration", exact: true }).focus();
  await page.keyboard.press("Home");
  await page.getByRole("button", { name: "Continue to review" }).click();
  const submitted = page.waitForResponse((response) => response.url().endsWith("/api/videos") && response.request().method() === "POST");
  await page.getByRole("button", { name: /^Make Video/ }).click();
  expect((await submitted).ok()).toBe(true);
  await expect(page).toHaveURL(/production=/);
  const id = new URL(page.url()).searchParams.get("production")!;
  const status = await (await page.request.get(`/api/videos/${id}`)).json();
  expect(status.job.status).toBe("complete");
  const player = page.locator("video").first();
  await expect.poll(() => player.evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(2);
  expect(await player.evaluate((video: HTMLVideoElement) => video.duration)).toBeCloseTo(60, 0);
  await page.getByRole("button", { name: "Play preview", exact: true }).click();
  await expect.poll(() => player.evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(0.2);
  const download = await page.request.get(`/api/videos/${id}/download`);
  expect(download.ok()).toBe(true);
  expect(download.headers()["content-disposition"]).toContain("attachment");
  expect((await download.body()).subarray(4, 8).toString()).toBe("ftyp");
  const artifact = await page.request.get(`/api/videos/${id}/artifacts/treatment`);
  expect(artifact.ok()).toBe(true);
  await page.screenshot({ path: info.outputPath("music-desktop.png"), fullPage: true });
  await page.reload();
  await expect(page.getByRole("button", { name: "Play preview", exact: true })).toBeEnabled();
  await workspace(page, "Projects");
  await expect(page.getByRole("button", { name: /Music video.*complete/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test("standalone image, video and music versions, restore and file export", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.request.post("/api/projects", { data: { name: "Media demo" } });
  await page.goto("/");
  await workspace(page, "Media Lab");
  for (const kind of ["image", "video", "music"]) {
    await page.locator(".workspace-command-strip").getByRole("button", { name: new RegExp(kind, "i") }).click();
    await page.getByRole("button", { name: "Stage from controls", exact: true }).click();
    await page.getByRole("button", { name: "Confirm generate", exact: true }).click();
    await expect(page.getByRole("button", { name: "Export current", exact: true })).toBeEnabled();
    const downloaded = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export current", exact: true }).click();
    const file = await downloaded;
    expect(await file.failure()).toBeNull();
    const body = await readFile((await file.path())!);
    expect(body.length).toBeGreaterThan(100);
    if (kind === "image") {
      expect(body.subarray(1, 4).toString()).toBe("PNG");
      await page.getByRole("button", { name: "Stage from controls", exact: true }).click();
      await page.getByRole("button", { name: "Confirm generate", exact: true }).click();
      await expect(page.locator(".session-meta-row").getByText("2 versions", { exact: true })).toBeVisible();
      const restored = page.waitForResponse((response) => response.url().endsWith("/restore"));
      await page.getByRole("button", { name: "Restore", exact: true }).last().click();
      expect((await restored).ok()).toBe(true);
      await expect(page.locator(".session-meta-row").getByText("2 versions", { exact: true })).toBeVisible();
    }
  }
  expect(errors).toEqual([]);
});

test("narrow layout, keyboard navigation, upload, library curation and error recovery", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const nav = page.getByRole("button", { name: "Open studio navigation", exact: true });
  await nav.focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("navigation", { name: "Studio", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(nav).toHaveAttribute("aria-expanded", "false");
  await workspace(page, "Projects");
  await page.getByRole("textbox", { name: "Project name", exact: true }).fill("Narrow demo project");
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await workspace(page, "Library");
  const png = await (await page.request.get("/api/demo/media?kind=image")).body();
  await page.locator('input[type="file"]').setInputFiles({ name: "demo-reference.png", mimeType: "image/png", buffer: png });
  await expect(page.getByLabel("Library asset name", { exact: true })).toBeVisible();
  await page.getByLabel("Library asset name", { exact: true }).fill("Golden reference");
  await page.getByLabel("Library asset tags", { exact: true }).fill("synthetic, release");
  await page.getByRole("button", { name: "Save details", exact: true }).click();
  await page.getByRole("button", { name: "Favorite", exact: true }).click();
  await expect(page.getByRole("button", { name: "Favorited", exact: true })).toBeVisible();
  await page.getByLabel("New reference pack", { exact: true }).fill("Demo pack");
  await page.getByRole("button", { name: "Create pack", exact: true }).click();
  await expect(page.getByRole("button", { name: "Demo pack", exact: true })).toBeVisible();
  await page.getByLabel("Media URL", { exact: true }).fill("http://127.0.0.1/private.png");
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await expect(page.getByText(/public.*(URL|network)|private.*(network|address)|not allowed|not permitted|blocked/i).first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(2);
  await page.screenshot({ path: info.outputPath("library-narrow.png"), fullPage: true });
});

test("editorial text and PDF sources, versioned approvals, captions and citations", async ({ page }, info) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("button", { name: /News digest Claim-linked/ }).click();
  await page.getByLabel("Production brief", { exact: true }).fill("Explain the supplied fictional community garden report with clearly attributed sources.");
  await page.getByRole("button", { name: "Continue to sources", exact: true }).click();
  await page.getByPlaceholder("Text source title (optional)").fill("Garden report");
  await page.locator("#source-text").fill(Array.from({ length: 16 }, (_, i) => `Report item ${i + 1}: the fictional neighborhood garden recorded more volunteer visits and additional plant beds this season. These are synthetic demonstration notes.`).join(" "));
  await page.getByRole("button", { name: "Add text source", exact: true }).click();
  await expect(page.getByText("Garden report", { exact: true }).first()).toBeVisible();
  await page.locator('input[type="file"][accept="application/pdf,.pdf"]').setInputFiles({ name: "garden.pdf", mimeType: "application/pdf", buffer: demoPdf() });
  await expect(page.getByText("garden.pdf", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Continue to direction", exact: true }).click();
  await page.getByRole("slider", { name: "Duration", exact: true }).focus(); await page.keyboard.press("Home");
  await page.getByLabel("Quality tier", { exact: true }).selectOption("draft");
  await page.getByRole("button", { name: "Continue to review", exact: true }).click();
  await page.getByRole("button", { name: /^Create Draft/ }).click();
  await page.getByRole("button", { name: "Approve script", exact: true }).click();
  await page.getByRole("button", { name: "Approve storyboard & generate", exact: true }).click();
  const id = new URL(page.url()).searchParams.get("production")!;
  await expect.poll(async () => (await (await page.request.get(`/api/productions/${id}`)).json()).state, { timeout: 150_000 }).toBe("complete");
  const output = await (await page.request.get(`/api/productions/${id}`)).json();
  expect(output.job.approvals.length).toBeGreaterThanOrEqual(2);
  for (const key of ["srt", "vtt", "sourceManifestJson", "claimLedger"]) {
    const result = await page.request.get(output.delivery.urls[key]);
    expect(result.ok()).toBe(true); expect((await result.body()).length).toBeGreaterThan(20);
  }
  expect((await page.request.get(`/api/videos/${id}/download`)).ok()).toBe(true);
  await page.screenshot({ path: info.outputPath("editorial-desktop.png"), fullPage: true });
  expect(errors).toEqual([]);
});

function demoPdf() {
  const text = "Synthetic garden report. Volunteers planted forty beds. The demonstration source describes community participation and seasonal planting plans. This document contains no private information.";
  const stream = `BT /F1 12 Tf 40 740 Td (${text}) Tj ET`;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 2000 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf = "%PDF-1.4\n"; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
