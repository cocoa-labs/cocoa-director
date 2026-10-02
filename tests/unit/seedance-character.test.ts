import { describe, expect, it } from "vitest";

import type { CreativeBrief, Shot } from "@/lib/schemas";
import { buildSeedanceReferenceRequest, endpointForShot, fallbackReferenceImages, seedanceReferenceInstruction } from "@/providers/seedance";

function performerBrief(): CreativeBrief {
  return {
    videoId: "00000000-0000-4000-8000-000000000000",
    durationSeconds: 60,
    aspectRatio: "9:16",
    visualMode: "visible_performer",
    storySpine: "A lead performer moves through a neon city as the night peaks.",
    visualWorld: "Neon rain, practical lights, and hard silhouettes.",
    subject: { type: "character", description: "An adult lead performer with a clean silhouette." },
    energyArc: ["build", "calm", "peak"],
    mood: "urgent",
    genre: "electronic",
  } as CreativeBrief;
}

function shot(seededCharacter?: boolean): Shot {
  return {
    shotIndex: 0,
    startMs: 0,
    endMs: 5000,
    seedanceMode: "reference-to-video",
    seedanceTier: "standard",
    resolution: "720p",
    prompt: "A cinematic performer shot with strong rhythm.",
    referenceImages: ["https://x/character.png", "https://x/style.png", "https://x/environment.png"],
    referenceRoles: ["character", "style", "environment"],
    sceneLane: "core_scene",
    visualMotif: "signature motif",
    cameraIntent: "beat-aware move",
    seed: 1,
    internalCuts: [],
    seededCharacter,
  } as Shot;
}

const INVENT_FACE = /newly invented fictional adult performer with an original face/i;
const PRESERVE = /preserve the exact performer|keep the same true-to-life face/i;

describe("seedanceReferenceInstruction — the visual-only fallback never erases a seeded character", () => {
  it("preserves the stylized character when the shot carries a user seed", () => {
    const text = seedanceReferenceInstruction(performerBrief(), "visual-only", true);
    expect(text).toMatch(PRESERVE);
    expect(text).not.toMatch(INVENT_FACE);
  });

  it("keeps the invent-a-new-performer behavior for an unseeded performer (regression)", () => {
    const text = seedanceReferenceInstruction(performerBrief(), "visual-only", false);
    expect(text).toMatch(INVENT_FACE);
  });
});

describe("fallbackReferenceImages — preserves the seeded character reference", () => {
  it("drops the LAST reference (keeping the character at index 0) when seeded", () => {
    const result = fallbackReferenceImages(shot(true));
    expect(result[0]).toContain("character");
    expect(result).toHaveLength(2);
    expect(result).not.toContain("https://x/environment.png");
  });

  it("drops the FIRST reference when not seeded (original loosening behavior)", () => {
    const result = fallbackReferenceImages(shot(false));
    expect(result).not.toContain("https://x/character.png");
    expect(result[0]).toContain("style");
  });
});


describe("Seedance mode routing", () => {
  it("uses matching standard and fast endpoints for each mode", () => {
    for (const seedanceTier of ["standard", "fast"] as const) {
      for (const seedanceMode of ["text-to-video", "image-to-video", "reference-to-video"] as const) {
        expect(endpointForShot({ seedanceTier, seedanceMode })).toBe(`bytedance/seedance-2.0/${seedanceTier === "fast" ? "fast/" : ""}${seedanceMode}`);
      }
    }
  });
  it("sends text input without reference fields and image input using start/end frames", () => {
    const text = buildSeedanceReferenceRequest({ ...shot(), seedanceMode: "text-to-video", referenceImages: [] }, performerBrief());
    expect(text.image_urls).toBeUndefined();
    expect(text.image_url).toBeUndefined();
    expect(text.audio_urls).toBeUndefined();
    expect(text.prompt).not.toContain("@Image");
    const image = buildSeedanceReferenceRequest({ ...shot(), seedanceMode: "image-to-video" }, performerBrief());
    expect(image.image_url).toBe("https://x/character.png");
    expect(image.end_image_url).toBe("https://x/style.png");
    expect(image.image_urls).toBeUndefined();
  });
  it("rejects missing references before submitting a paid request", () => {
    for (const seedanceMode of ["image-to-video", "reference-to-video"] as const) {
      expect(() => buildSeedanceReferenceRequest({ ...shot(), seedanceMode, referenceImages: [] }, performerBrief())).toThrow(/Choose/);
    }
  });
});
