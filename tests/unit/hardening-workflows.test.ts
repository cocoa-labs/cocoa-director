import { outlineEditorialText, renderFontFiles } from "@/lib/server/render-fonts";
import sharp from "sharp";
import { compositeEditorialThumbnail, fitEditorialDocumentPage } from "@/lib/server/news-delivery";
import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { ProductionCreateRequest, MediaGenerationCreateRequest, MusicPlan } from "@/lib/schemas";
import { createProduction, fitProductionEditorialDraft } from "@/lib/server/productions";
import { approveNewsGate, updateNewsDraft } from "@/lib/server/news-editorial";
import { validateGraphicPayload } from "@/lib/server/source-visuals";
import { narrationBudgetSummary } from "@/lib/hybrid-visuals";
import { getStore, resetInMemoryStoreForDev } from "@/lib/server/store";
import { createProjectMediaGeneration } from "@/lib/server/media";

beforeEach(() => {
  delete process.env.DATABASE_URL;
  process.env.PROVIDER_MODE = "mock";
  process.env.PROVIDER_CALLS_ENABLED = "true";
  resetInMemoryStoreForDev();
});

describe("browser-discovered workflow regressions", () => {
  it("fits an overlong explainer and retains valid source graphics while rejecting stale approvals", async () => {
    const owner = { id: randomUUID(), email: "test@example.test", planTier: "dev" as const, dailyBudgetCents: 5000 };
    const text = "A rain garden is a shallow planted basin that receives runoff from a roof, driveway, or path. Rainwater enters the basin during a storm and spreads over the planted surface. The temporary pool gives water time to soak into the soil. Plant roots help maintain spaces in the soil, while stems and leaves slow the moving water. A rain garden needs a safe overflow route for storms larger than its designed capacity. Overflow directs excess water away during storms.";
    const job = await createProduction(ProductionCreateRequest.parse({ contentType: "explainer", brief: "Explain a rain garden using only the supplied teaching notes.", targetDurationSeconds: 30, sourceBundle: { inputs: [{ id: "notes", kind: "text", title: "Teaching notes", text }] } }), owner);
    const previousVersion = job.workflowSteps!.find((step) => step.id === "script")!.artifactVersionId!;
    const fitted = await fitProductionEditorialDraft(job, owner);
    const budget = narrationBudgetSummary(fitted.script!, 30);
    expect(budget.withinBudget).toBe(true);
    expect(budget.predictedCoverage).toBeGreaterThanOrEqual(0.75);
    const information = fitted.visualPlan!.beats.filter((beat) => ["documentary_source", "document_excerpt", "data_visualization"].includes(beat.kind));
    expect(information.length).toBeGreaterThan(0);
    expect(information.every((beat) => validateGraphicPayload(beat).valid)).toBe(true);
    await expect(approveNewsGate({ job: fitted, user: owner, gate: "script", artifactVersionId: previousVersion })).rejects.toThrow("stale");
    expect(fitted.artifactVersions.length).toBeGreaterThan(job.artifactVersions.length);
  });

  it("uses edited script text for narration and versions the synchronized storyboard", async () => {
    const owner = { id: randomUUID(), email: "test@example.test", planTier: "dev" as const, dailyBudgetCents: 5000 };
    const text = "A rain garden is a shallow planted basin. It receives stormwater runoff from roofs and paths. Water spreads across the basin and slowly soaks into the soil. Plant roots keep channels open, while leaves slow the flow. A safe overflow route carries excess stormwater away. The garden uses plants suited to soil and climate. It needs weeding and care while young plants establish themselves.";
    const job = await createProduction(ProductionCreateRequest.parse({ contentType: "explainer", brief: "Explain the supplied rain garden notes.", targetDurationSeconds: 30, sourceBundle: { inputs: [{ id: "notes", kind: "text", title: "Notes", text }] } }), owner);
    const script = "A rain garden is a shallow planted basin. It receives stormwater runoff from roofs and paths.\n\nWater spreads across the basin and slowly soaks into the soil. Plant roots keep channels open, while leaves slow the flow.\n\nA safe overflow route carries excess stormwater away. The garden uses plants suited to soil and climate.";
    const updated = await updateNewsDraft({ job, script });
    expect(updated.storyboard!.scenes.map((scene) => scene.narration).join("\n\n")).toBe(script);
    expect(updated.workflowSteps!.find((step) => step.id === "storyboard")!.artifactVersionId).not.toBe(job.workflowSteps!.find((step) => step.id === "storyboard")!.artifactVersionId);
    expect(updated.approvals).toEqual([]);
    expect(updated.visualPlan?.timingPlan).toBeUndefined();
    const approved = await approveNewsGate({ job: updated, user: owner, gate: "script", artifactVersionId: updated.workflowSteps!.find((step) => step.id === "script")!.artifactVersionId! });
    expect(approved.approvals).toHaveLength(1);
  });

  it("honors short standalone music duration with explicit genre controls", async () => {
    const project = await getStore().createProject({ userId: randomUUID(), name: "Short music" });
    const result = await createProjectMediaGeneration(project.id, MediaGenerationCreateRequest.parse({ kind: "music", prompt: "A quiet ambient instrumental for a rain garden.", execute: true, controls: { durationSeconds: 12, musicControls: { genre: "ambient", vocals: "instrumental", tempo: "slow", intensity: "low" } } }));
    expect(result.generation.status).toBe("success");
    const plan = MusicPlan.parse(result.generation.metadata.plan);
    expect(plan.sections.reduce((sum, section) => sum + section.durationSeconds, 0)).toBe(12);
    expect(result.assets[0].metadata.durationSeconds).toBe(12);
    expect(plan.vocal).toBe(false);
  });

  it("creates one internal generation when simultaneous workflow calls share a key", async () => {
    const project = await getStore().createProject({ userId: randomUUID(), name: "Concurrency" });
    const request = MediaGenerationCreateRequest.parse({ kind: "image", prompt: "A paper boat under warm studio light", idempotencyKey: randomUUID(), execute: true });
    const [one, two] = await Promise.all([createProjectMediaGeneration(project.id, request), createProjectMediaGeneration(project.id, request)]);
    expect(one.generation.id).toBe(two.generation.id);
    expect((await getStore().listProjectMedia(project.id)).generations).toHaveLength(1);
  });

  it("outlines editorial labels with bundled fonts for a fontless server", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="90"><text x="10" y="60" font-family="Arial" font-size="40">Cocoa verified</text></svg>';
    const outlined = outlineEditorialText(svg).toString();
    expect(renderFontFiles).toHaveLength(4);
    expect(outlined).not.toContain("<text");
    expect(outlined).toContain("<path");
    expect(outlined.length).toBeGreaterThan(1000);
  });

  it("retains text near the top of a portrait source page in a landscape evidence frame", async () => {
    const page = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="612" height="792"><rect width="612" height="792" fill="white"/><rect x="72" y="72" width="300" height="20" fill="red"/></svg>')).png().toBuffer();
    const fitted = await fitEditorialDocumentPage(page, 1280, 720);
    const pixels = await sharp(fitted).removeAlpha().raw().toBuffer();
    let redPixels = 0;
    for (let i = 0; i < pixels.length; i += 3) if (pixels[i] > 220 && pixels[i + 1] < 30 && pixels[i + 2] < 30) redPixels++;
    expect(redPixels).toBeGreaterThan(1000);
  });

  it("composites an editorial thumbnail when the source is smaller than its overlay", async () => {
    const base = await sharp({ create: { width: 512, height: 768, channels: 3, background: "#125634" } }).png().toBuffer();
    const overlay = await sharp({ create: { width: 1280, height: 720, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    const thumbnail = await compositeEditorialThumbnail(base, overlay);
    expect(await sharp(thumbnail).metadata()).toMatchObject({ width: 1280, height: 720, format: "png" });
    expect((await sharp(thumbnail).raw().toBuffer())[1]).toBe(86);
  });


});
