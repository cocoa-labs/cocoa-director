import { describe, expect, it } from "vitest";

import { GptImageProvider } from "@/providers/gptimage";
import type { ProviderContext } from "@/providers/types";

// Gated, paid, manual validation of the real OpenAI images/edits (image-to-image) contract.
// Run with:  set -a; . ./.env; set +a; RUN_LIVE_IMAGE_EDITS=1 npx vitest run tests/live/image-edits.live.test.ts
const live = process.env.RUN_LIVE_IMAGE_EDITS === "1" && Boolean(process.env.OPENAI_API_KEY);

const STYLIZE_PROMPT =
  "Render a stylized, art-directed likeness from the provided reference image: preserve recognizable facial structure, hairstyle, and defining features, but re-render the person as a clean illustrated character design sheet in a bold cinematic comic style on a plain seamless studio background. Not photoreal, not a live-action photo. No readable text, names, or logos.";

describe.skipIf(!live)("LIVE OpenAI images/edits contract", () => {
  it("generates a reference portrait, then stylizes it via image-to-image", async () => {
    const provider = new GptImageProvider();
    const refCtx: ProviderContext = { videoId: "live-ref", traceId: "live-trace", phaseNumber: 5, idempotencyKey: "live-ref-1" };
    const styledCtx: ProviderContext = { videoId: "live-styled", traceId: "live-trace", phaseNumber: 5, idempotencyKey: "live-styled-1" };

    // 1) Text-to-image reference (also confirms the normal anchor path still works live).
    const ref = await provider.generateAnchorAsset(
      "character",
      "Studio portrait of a fictional adult person, plain seamless gray background, neutral expression, soft even lighting.",
      refCtx,
      { quality: "low", size: "1024x1024", outputFormat: "png" },
    );
    expect(typeof ref.data.url).toBe("string");
    expect(ref.data.url.length).toBeGreaterThan(0);
    console.log("[live] REFERENCE url:", ref.data.url);

    // 2) Image-to-image stylization — the new editAnchorAsset path / images/edits contract.
    const styled = await provider.generateAnchorAsset(
      "character",
      STYLIZE_PROMPT,
      styledCtx,
      { quality: "low", size: "1024x1024", outputFormat: "png" },
      { images: [{ url: ref.data.url, mimeType: "image/png" }], intent: "character", allowLikeness: true },
    );
    expect(typeof styled.data.url).toBe("string");
    expect(styled.data.url.length).toBeGreaterThan(0);
    console.log("[live] STYLIZED url:", styled.data.url);
  }, 240000);
});
