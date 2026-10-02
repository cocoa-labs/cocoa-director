import { describe, expect, it } from "vitest";

import type { CreativeBrief, VideoSeeds } from "@/lib/schemas";
import { createAnchorAssets, getAnchorRoles, promptFor } from "@/workflow/phases/anchorAssets";

function brief(visualMode: CreativeBrief["visualMode"] = "conceptual"): CreativeBrief {
  return {
    videoId: "00000000-0000-4000-8000-000000000000",
    durationSeconds: 75,
    aspectRatio: "9:16",
    visualMode,
    storySpine: "A lead figure crosses a neon city and turns the skyline into light.",
    visualWorld: "Neon rain, cyan practical lights, hard silhouettes, and graphite concrete.",
    subject: {
      type: visualMode === "visible_performer" ? "character" : "abstract",
      description: "A courier with a clean silhouette.",
    },
    energyArc: ["build", "calm", "peak"],
    mood: "urgent",
    genre: "electronic",
  } as CreativeBrief;
}

const CHARACTER_SEEDS: VideoSeeds = {
  subjects: [
    {
      id: "you-1",
      label: "YOU",
      role: "character",
      images: [{ url: "https://example.com/me.png", mimeType: "image/png" }],
      consent: {
        affirmed: true,
        statement: "I have the right to use these images and consent to their use in generated video.",
        affirmedAt: "2026-06-07T00:00:00.000Z",
        version: "v1",
      },
    },
  ],
  aesthetic: [],
};

const IDENTITY_BAN = /no face that resembles a specific real person/i;
const BACKGROUND_STRIP = /discard the original photo'?s background/i;
const PHOTOREAL = /true-to-life|photorealistic|recognizable as themselves/i;
const FORCED_CARTOON = /not photoreal|illustrated character design sheet|stylized production concept art/i;
const DERIVE_FROM_REF = /derive .*from the provided reference image/i;

describe("promptFor — seed-aware likeness", () => {
  it("keeps the identity-safety ban for an unseeded character anchor", () => {
    const prompt = promptFor("character", brief("visible_performer"));
    expect(prompt).toMatch(IDENTITY_BAN);
    expect(prompt).not.toMatch(BACKGROUND_STRIP);
  });

  it("drops the identity ban and renders a photoreal, true-to-life likeness with the background stripped", () => {
    const prompt = promptFor("character", brief("visible_performer"), undefined, "", "character");
    expect(prompt).not.toMatch(IDENTITY_BAN);
    expect(prompt).toMatch(BACKGROUND_STRIP);
    expect(prompt).toMatch(PHOTOREAL);
    expect(prompt).not.toMatch(FORCED_CARTOON);
  });

  it("keeps the identity ban for an aesthetic seed and leads with a derive-from-reference instruction", () => {
    const prompt = promptFor("environment", brief(), undefined, "", "aesthetic");
    expect(prompt).toMatch(IDENTITY_BAN);
    expect(prompt).toMatch(DERIVE_FROM_REF);
  });
});

describe("getAnchorRoles — a character seed forces the character anchor", () => {
  it("excludes character in conceptual mode with no seeds (regression guard)", () => {
    expect(getAnchorRoles(brief("conceptual"))).not.toContain("character");
  });

  it("includes character when a character seed is present, even in conceptual mode", () => {
    expect(getAnchorRoles(brief("conceptual"), CHARACTER_SEEDS)).toContain("character");
  });
});

describe("createAnchorAssets — seed provenance (mock provider)", () => {
  it("generates a character anchor stamped with seededFrom even from a conceptual brief", async () => {
    process.env.PROVIDER_MODE = "mock";
    const results = await createAnchorAssets(
      brief("conceptual"),
      undefined,
      { videoId: "00000000-0000-4000-8000-000000000000", traceId: "trace", phaseNumber: 5 },
      (role) => `idem-${role}`,
      "",
      undefined,
      CHARACTER_SEEDS,
    );

    const character = results.find((result) => result.data.role === "character");
    expect(character).toBeDefined();
    expect(character?.data.seededFrom).toEqual({ intent: "character", referenceCount: 1 });
  });
});
