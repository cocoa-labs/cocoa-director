import { describe, expect, it } from "vitest";

import type { MusicControls, MusicPlan, VideoJob } from "@/lib/schemas";
import { chooseVoiceFamily, createCompositionPlan } from "@/workflow/phases/compositionPlan";
import { createTreatment } from "@/workflow/phases/treatment";
import { applyMusicControls, canonicalizeMusicProfile, deterministicStyleContract } from "@/workflow/creativeStyleContract";
import { toElevenCompositionPlan } from "@/providers/elevenmusic";

// Pre-change, every non-pop genre inherited these. They must never appear in a generated plan.
const POP_TELLS = /art-pop|glossy pop|turn the lights up|make the moment break|EDM festival drop/i;

function job(prompt: string, musicControls?: MusicControls): VideoJob {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    projectId: "project",
    userId: "user",
    prompt,
    status: "pending",
    currentPhase: 1,
    estimatedCostCents: 0,
    actualCostCents: 0,
    recoveryBudgetCents: 0,
    recoverySpentCents: 0,
    aspectRatio: "9:16",
    visualMode: "conceptual",
    durationSeconds: 75,
    traceId: "trace",
    cancellationRequested: false,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    musicControls,
    seeds: { subjects: [], aesthetic: [] },
    anchorAssets: [],
    generatedShots: [],
    editDirectives: [],
    artifactVersions: [],
    phases: [],
    providerCalls: [],
  };
}

async function planFor(prompt: string, musicControls?: MusicControls): Promise<MusicPlan> {
  const treatment = await createTreatment(job(prompt, musicControls));
  return createCompositionPlan(treatment);
}

function instrumentation(plan: MusicPlan) {
  return plan.sections.map((section) => section.instrumentation).join(" ");
}

function controls(overrides: Partial<MusicControls> = {}): MusicControls {
  return { vocals: "auto", tempo: "auto", intensity: "auto", ...overrides };
}

describe("music genre breadth", () => {
  it("renders Gregorian chant as modal sacred choir with no percussion and Latin lyrics", async () => {
    const plan = await planFor("A Gregorian chant echoing through a vast stone cathedral.");

    expect(plan.styleSummary).toMatch(/chant|plainsong|sacred|cathedral|choir/i);
    expect(plan.voiceFamily).toBe("mixed");
    expect(plan.bpm).toBeLessThanOrEqual(72);
    expect(instrumentation(plan)).not.toMatch(/\bdrum/i);
    expect(plan.sections.some((section) => /kyrie|gloria|amen|dona nobis|sanctus|agnus/i.test(section.lyrics ?? ""))).toBe(true);
    expect(JSON.stringify(plan.sections)).not.toMatch(POP_TELLS);
  });

  it("keeps thrash metal heavy and guitar-driven with a male lead", async () => {
    const plan = await planFor("A thrash metal music video with relentless riffs.");

    expect(plan.styleSummary).toMatch(/metal|distorted|guitar/i);
    expect(plan.voiceFamily).toBe("male");
    expect(JSON.stringify(plan)).not.toMatch(POP_TELLS);
  });

  it("routes boom-bap rap to hip-hop with a vocal lead (never silent)", async () => {
    const plan = await planFor("A boom-bap rap video on a rainy city street at night.");

    expect(plan.styleSummary).toMatch(/hip-hop|drums|bass|sample/i);
    expect(plan.vocal).toBe(true);
    expect(plan.voiceFamily).not.toBe("instrumental");
    expect(plan.sections.some((section) => (section.lyrics ?? "").length > 0)).toBe(true);
    expect(JSON.stringify(plan)).not.toMatch(POP_TELLS);
  });

  it("keeps instrumental-leaning genres instrumental by default", async () => {
    const plan = await planFor("A slow ambient drone piece for quiet meditation.");

    expect(plan.voiceFamily).toBe("instrumental");
    expect(plan.sections.every((section) => section.lyrics === undefined)).toBe(true);
  });

  it("honors a free-text genre with no curated profile via pass-through (reggae)", async () => {
    const plan = await planFor("A roots reggae song on a sunny beach.");

    expect(plan.styleSummary).toMatch(/reggae|offbeat|one-drop|dub/i);
    expect(plan.bpm).toBeGreaterThan(80);
    expect(plan.bpm).toBeLessThan(110);
    expect(JSON.stringify(plan)).not.toMatch(POP_TELLS);
  });

  it("gives a prompt with no genre hint a neutral, non-pop default", async () => {
    const plan = await planFor("A quiet film about the ocean at dawn.");

    expect(JSON.stringify(plan)).not.toMatch(POP_TELLS);
  });
});

describe("advanced music controls", () => {
  it("applies a genre preset over inference", () => {
    const base = deterministicStyleContract("a cinematic music video about light");
    const next = applyMusicControls(base, controls({ genre: "gregorian" }));

    expect(next.routing.musicProfile).toBe("gregorian");
    expect(next.musicIntent.primaryGenre).toMatch(/chant|choral/i);
  });

  it("returns the contract unchanged when controls are absent (no breaking change)", () => {
    const base = deterministicStyleContract("Rock and roll guitar in a rehearsal room.");
    expect(applyMusicControls(base, undefined)).toEqual(base);
    expect(applyMusicControls(base, controls())).toEqual(base);
  });

  it("forces instrumental and skips lyrics when vocals=instrumental", async () => {
    const plan = await planFor("An upbeat song with a lead singer.", controls({ vocals: "instrumental" }));

    expect(plan.vocal).toBe(false);
    expect(plan.voiceFamily).toBe("instrumental");
    expect(plan.sections.every((section) => section.lyrics === undefined)).toBe(true);
  });

  it("honors an explicit vocal family and BPM over inference", async () => {
    const plan = await planFor("An electronic track for a night drive.", controls({ vocals: "male", bpm: 150 }));

    expect(plan.voiceFamily).toBe("male");
    expect(plan.bpm).toBe(150);
  });

  it("maps a House chip to four-on-the-floor electronic style", async () => {
    const plan = await planFor("a club video", controls({ genre: "house" }));

    expect(plan.styleSummary).toMatch(/four-on-the-floor|electronic|synth/i);
    expect(JSON.stringify(plan)).not.toMatch(POP_TELLS);
  });

  it("defaults to instrumental when no vocal cue is present", () => {
    const treatmentGenre = deterministicStyleContract("a calm instrumental-free ocean film");
    void treatmentGenre;
    // direct unit check on the voice resolver with a minimal brief
    const voice = chooseVoiceFamily({
      videoId: "00000000-0000-4000-8000-000000000000",
      durationSeconds: 75,
      aspectRatio: "9:16",
      visualMode: "conceptual",
      storySpine: "A wide ambient film drifting across the open sea at first light.",
      visualWorld: "Open water, soft light, slow horizon.",
      subject: { type: "abstract", description: "light, water, horizon, motion" },
      energyArc: ["build", "calm", "peak"],
      mood: "calm",
      genre: "ambient textural score",
      safetyNotes: [],
    });
    expect(voice).toBe("instrumental");
  });
});

describe("eleven labs payload", () => {
  it("steers chant away from percussion and keeps the copyright guard", async () => {
    const plan = await planFor("Gregorian chant in a cathedral.");
    const payload = toElevenCompositionPlan(plan);
    const localStyles = payload.sections.flatMap((section) => section.positiveLocalStyles).join(" ");

    expect(payload.negativeGlobalStyles).toContain("copyrighted lyrics");
    expect(payload.positiveGlobalStyles.join(" ")).toMatch(/chant|choir|cathedral/i);
    expect(localStyles).toMatch(/no percussion/i);
  });
});

describe("live-mode profile normalization", () => {
  it("passes canonical tokens through unchanged", () => {
    expect(canonicalizeMusicProfile("hip_hop")).toBe("hip_hop");
    expect(canonicalizeMusicProfile("gregorian")).toBe("gregorian");
    expect(canonicalizeMusicProfile("electronic")).toBe("electronic");
  });

  it("maps free-text LLM genre labels to canonical tokens", () => {
    expect(canonicalizeMusicProfile("hip-hop")).toBe("hip_hop");
    expect(canonicalizeMusicProfile("boom-bap hip-hop")).toBe("hip_hop");
    expect(canonicalizeMusicProfile("drum and bass")).toBe("dnb");
    expect(canonicalizeMusicProfile("Gregorian chant")).toBe("gregorian");
    expect(canonicalizeMusicProfile("R&B")).toBe("blues_rnb");
    expect(canonicalizeMusicProfile("deep house")).toBe("electronic");
  });

  it("returns empty for empty input", () => {
    expect(canonicalizeMusicProfile(undefined)).toBe("");
    expect(canonicalizeMusicProfile("   ")).toBe("");
  });

  it("routes an LLM free-text profile to the curated profile and a genre-aware voice", async () => {
    const brief = await createTreatment(job("a music video about a city night"));
    // Simulate a live LLM contract that returned free-text genre labels.
    brief.styleContract!.routing.musicProfile = "hip-hop";
    brief.styleContract!.musicIntent.primaryGenre = "boom-bap hip-hop";
    brief.styleContract!.musicIntent.positiveStyle = ["dusty drums", "jazzy samples"];
    brief.styleContract!.musicIntent.vocalMode = "vocal";

    const plan = await createCompositionPlan(brief);

    expect(plan.styleSummary).toMatch(/hip-hop/i);
    expect(plan.voiceFamily).toBe("male"); // vocalLead[hip_hop], not the generic female fallback
    expect(JSON.stringify(plan)).not.toMatch(POP_TELLS);
  });

  it("applies the curated no-percussion Gregorian profile for a free-text 'Gregorian chant' label", async () => {
    const brief = await createTreatment(job("a music video"));
    brief.styleContract!.routing.musicProfile = "Gregorian chant";
    brief.styleContract!.musicIntent.primaryGenre = "Gregorian chant";

    const plan = await createCompositionPlan(brief);

    expect(plan.bpm).toBeLessThanOrEqual(72);
    expect(plan.voiceFamily).toBe("mixed");
    expect(plan.sections.map((section) => section.instrumentation).join(" ")).not.toMatch(/\bdrum/i);
  });
});
