import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { fitEditorialText, sourceCardSvg } from "@/lib/server/editorial-graphics";
import { outlineEditorialText } from "@/lib/server/render-fonts";
import type { SourceVisualArtifact } from "@/lib/schemas";

const source: SourceVisualArtifact = {
  id: "source-visual", sourceId: "paper", fragmentId: "mechanism", kind: "url_excerpt_card",
  title: "A clear explanation of contextual processing", domain: "research.example.org", locator: "3 · How the mechanism works",
  excerpt: "The mechanism compares each input with its surrounding context and combines the relevant information into a useful representation.",
  excerptHash: "a".repeat(64), extractionMethod: "html",
};

describe("editorial visual continuity", () => {
  it("bounds headlines and unbroken text by measured glyph width", () => {
    const fitted = fitEditorialText("Wide WWW headings and " + "LongUnbrokenSourceIdentifier".repeat(8), 300, 36, 3, 700);
    const context = createCanvas(1, 1).getContext("2d");
    context.font = "700 36px Arial";
    expect(fitted.lines).toHaveLength(3);
    expect(fitted.truncated).toBe(true);
    expect(fitted.lines.at(-1)).toMatch(/…$/);
    for (const line of fitted.lines) expect(context.measureText(line).width).toBeLessThanOrEqual(300);
  });

  it.each([[1280, 720], [720, 1280], [1080, 1080]])("renders readable evidence on the continuity palette at %sx%s", async (width, height) => {
    const svg = sourceCardSvg(source, "Context becomes the mechanism", width, height, ["#07110e", "#d9e3dd", "#75eaa5"]);
    expect(svg).not.toMatch(/VERIFIED EXCERPT|EVIDENCE DETAIL|#f4f3ed/);
    expect(svg).toContain("Context becomes");
    expect(svg).toContain("#75eaa5");
    const png = await sharp(outlineEditorialText(svg)).png().toBuffer();
    const pixels = await sharp(png).removeAlpha().raw().toBuffer();
    let bright = 0;
    for (let offset = 0; offset < pixels.length; offset += 3) if (pixels[offset] > 210 && pixels[offset + 1] > 210 && pixels[offset + 2] > 210) bright++;
    expect(bright / (width * height)).toBeLessThan(.12);
    expect(bright).toBeGreaterThan(1000);
    expect(pixels.reduce((sum, channel) => sum + channel, 0) / pixels.length).toBeLessThan(75);
    if (process.env.COCOA_EXPLAINER_PREVIEW_DIR) {
      await mkdir(process.env.COCOA_EXPLAINER_PREVIEW_DIR, { recursive: true });
      await writeFile(join(process.env.COCOA_EXPLAINER_PREVIEW_DIR, `evidence-${width}x${height}.png`), png);
    }
  });

  it("shows a cited metric and visibly indicates a shortened excerpt without changing evidence", () => {
    const longSource = { ...source, excerpt: source.excerpt.repeat(8) };
    const svg = sourceCardSvg(longSource, "What the evaluation found", 1280, 720, [], { value: 18, unit: "percent", label: "Reported improvement" });
    expect(svg).toContain("18 percent");
    expect(svg).toContain("Reported improvement");
    expect(svg).toContain("…");
    expect(longSource.excerpt).toBe(source.excerpt.repeat(8));
    expect(svg).not.toContain(source.excerptHash);
  });
});
