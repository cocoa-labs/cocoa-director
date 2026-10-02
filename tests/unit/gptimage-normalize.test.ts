import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { normalizeSeedImage } from "@/providers/gptimage";

async function solidPng(width: number, height: number) {
  return sharp({
    create: { width, height, channels: 3, background: { r: 100, g: 120, b: 140 } },
  })
    .png()
    .toBuffer();
}

describe("normalizeSeedImage", () => {
  it("upscales a tiny seed so the short side is >= 1024 and re-encodes to PNG", async () => {
    // A 80x110 crop mirrors the 208x297 phone photo OpenAI rejected with invalid_image_file.
    const result = await normalizeSeedImage(await solidPng(80, 110), "image/png");
    expect(result.mimeType).toBe("image/png");
    const meta = await sharp(Buffer.from(result.bytes)).metadata();
    expect(meta.format).toBe("png");
    expect(Math.min(meta.width ?? 0, meta.height ?? 0)).toBeGreaterThanOrEqual(1024);
  });

  it("downscales an oversized seed to a ~1024 short side", async () => {
    const result = await normalizeSeedImage(await solidPng(4000, 3000), "image/png");
    const meta = await sharp(Buffer.from(result.bytes)).metadata();
    expect(Math.min(meta.width ?? 0, meta.height ?? 0)).toBe(1024);
  });

  it("falls back to the original bytes when the input isn't a decodable image", async () => {
    const garbage = Buffer.from("not an image at all");
    const result = await normalizeSeedImage(garbage, "image/jpeg");
    expect(result.mimeType).toBe("image/jpeg");
    expect(Buffer.from(result.bytes).toString()).toBe("not an image at all");
  });
});
