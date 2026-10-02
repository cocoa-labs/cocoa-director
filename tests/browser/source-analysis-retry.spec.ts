import { expect, test } from "@playwright/test";

test("a failed source analysis keeps sources and can create a draft on deliberate retry", async ({ page }, info) => {
  await page.request.post("/api/dev/reset-memory");
  await page.goto("/");
  await page.getByRole("button", { name: /Explainer Source-first/ }).click();
  await page.getByLabel("Production brief", { exact: true }).fill("Explain this study's method, findings and limitations.");
  await page.getByRole("button", { name: "Continue to sources", exact: true }).click();
  await page.getByPlaceholder("Text source title (optional)").fill("Saved research source");
  await page.locator("#source-text").fill(Array.from({ length: 6 }, (_, index) => `Finding ${index + 1} describes a documented mechanism and the measured outcome within its stated limitations. Investigators checked the result against the supplied evidence before drawing a conclusion.`).join("\n\n"));
  await page.getByRole("button", { name: "Add text source", exact: true }).click();
  await page.getByRole("button", { name: "Continue to direction", exact: true }).click();
  await page.getByRole("button", { name: "Continue to review", exact: true }).click();
  const requests: Array<{ key: string; sources: string[] }> = [];
  await page.route("**/api/productions", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.continue();
    requests.push({ key: request.headers()["idempotency-key"], sources: request.postDataJSON().sourceRecordIds });
    if (requests.length === 1) return route.fulfill({ status: 502, json: {
      code: "source_analysis_failed", error: "The article was read, but its source analysis could not be completed. Try Create Draft again. Your sources are saved.",
    } });
    return route.continue();
  });
  const create = page.getByRole("button", { name: /^Create Draft/ });
  await create.click();
  await expect(page.getByText(/Your sources are saved/)).toBeVisible();
  await expect(create).toBeEnabled();
  await create.click();
  await expect(page).toHaveURL(/production=/);
  await expect(page.getByRole("button", { name: /^(Approve script|Condense to|Fit to)/ })).toBeVisible();
  expect(requests).toHaveLength(2);
  expect(requests[1].key).not.toBe(requests[0].key);
  expect(requests[1].sources).toEqual(requests[0].sources);
  expect(requests[1].sources).toHaveLength(1);
  await expect(page.getByText(/Your sources are saved/)).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("recovered-source-draft.png"), fullPage: true });
});
