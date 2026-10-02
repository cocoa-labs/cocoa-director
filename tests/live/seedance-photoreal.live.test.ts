import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { fal } from "@fal-ai/client";
import { describe, expect, it } from "vitest";

import type { CreativeBrief, Shot } from "@/lib/schemas";
import { SeedanceProvider } from "@/providers/seedance";
import type { ProviderContext } from "@/providers/types";

// Gated, paid (~$1 video gen). Answers: does Seedance (fal) accept a PHOTOREAL real-face
// character reference, or does it reject it on likeness grounds?
// Run only with an owned/authorized adult portrait and explicit consent:
// RUN_LIVE_LIKENESS_TEST=1 LIKENESS_CONSENT_AFFIRMED=1 LIKENESS_REFERENCE_PATH=/abs/ref.jpg ...
const live =
  process.env.RUN_LIVE_LIKENESS_TEST === "1" &&
  process.env.LIKENESS_CONSENT_AFFIRMED === "1" &&
  process.env.LIKENESS_VIDEO_ENABLED !== "false" &&
  Boolean(process.env.LIKENESS_REFERENCE_PATH) &&
  Boolean(process.env.FAL_KEY) &&
  process.env.PROVIDER_CALLS_ENABLED === "true";

describe.skipIf(!live)("LIVE Seedance accepts a photoreal character reference", () => {
  it("runs reference-to-video with a photoreal face and reports acceptance", async () => {
    // The operator must provide an owned adult portrait and affirm the same consent
    // shown in-product. The fixture never ships a face or silently fabricates one.
    const localPath = resolve(process.env.LIKENESS_REFERENCE_PATH!);
    const bytes = await readFile(localPath);
    console.log("[seedance] ref bytes:", bytes.length);
    fal.config({ credentials: process.env.FAL_KEY });
    const publicUrl = await fal.storage.upload(new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }));
    console.log("[seedance] public ref url:", publicUrl);

    // 3) Minimal performer brief + a shot locking the photoreal face as the character ref.
    const brief = {
      videoId: "seedance-shot",
      durationSeconds: 60,
      aspectRatio: "9:16",
      visualMode: "visible_performer",
      storySpine: "A lead performer moves through a neon city as the night peaks.",
      visualWorld: "Neon rain, practical lights, and hard silhouettes.",
      subject: { type: "character", description: "An adult lead performer." },
      energyArc: ["build", "calm", "peak"],
      mood: "urgent",
      genre: "electronic",
    } as CreativeBrief;
    const shot = {
      shotIndex: 0,
      startMs: 0,
      endMs: 4000,
      seedanceMode: "reference-to-video",
      seedanceTier: "fast",
      resolution: "480p",
      prompt: "The performer walks toward camera on a rain-slick neon street, cinematic, music-driven motion.",
      referenceImages: [publicUrl],
      referenceRoles: ["character"],
      seededCharacter: true,
      sceneLane: "core_scene",
      visualMotif: "neon",
      cameraIntent: "slow push-in",
      seed: 12345,
      internalCuts: [],
    } as Shot;

    const sd = new SeedanceProvider();
    const ctx: ProviderContext = { videoId: "seedance-shot", traceId: "sd", phaseNumber: 7, idempotencyKey: "sd-shot-1" };

    try {
      const result = await sd.generateShot(shot, brief, ctx);
      // attempts === 1 -> accepted on the first (policy "all") try, no fallback needed.
      console.log("[seedance] ACCEPTED — attempts:", result.data.attempts, "video:", result.data.videoUrl);
      expect(result.data.videoUrl.length).toBeGreaterThan(0);
      expect(result.data.referencePolicy).toBe("all");
      expect(result.data.provenance?.permittedUse).toMatch(/consent/i);
    } catch (error) {
      console.log("[seedance] REJECTED/ERROR:", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }, 420000);
});
