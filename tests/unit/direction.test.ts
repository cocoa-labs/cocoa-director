import { describe, expect, it } from "vitest";

import type { AnchorAsset, BeatGrid, CreativeBrief, MusicPlan, VideoJob } from "@/lib/schemas";
import { promptFor } from "@/workflow/phases/anchorAssets";
import { createCompositionPlan } from "@/workflow/phases/compositionPlan";
import { createShotPlan, scoreShotPlanDiversity } from "@/workflow/phases/shotPlan";
import { chooseVisualSignature, createTreatment } from "@/workflow/phases/treatment";
import { deterministicStyleContract } from "@/workflow/creativeStyleContract";

describe("production direction contract", () => {
  it("does not force every treatment into electric green cyberpunk city language", async () => {
    const treatment = await createTreatment(job("A playful music video about washing dishes after midnight."));

    expect(treatment.visualSignature?.id).toBe("surreal_domestic");
    expect(treatment.visualWorld).not.toMatch(/electric green, cyan, bone white, and graphite black/i);
    expect(treatment.visualWorld).not.toMatch(/rain-slick megacity|skyline|monolith/i);
  });

  it("chooses deterministic but varied visual signatures across jobs", () => {
    const first = chooseVisualSignature("A playful music video about washing dishes", "00000000-0000-4000-8000-000000000001");
    const second = chooseVisualSignature("A mythic song about crossing a moonlit forest river", "00000000-0000-4000-8000-000000000002");

    expect(first.id).not.toBe(second.id);
  });

  it("keeps cyberpunk visuals only when the prompt asks for that lane", () => {
    const domestic = chooseVisualSignature("A joyful song about washing dishes", "00000000-0000-4000-8000-000000000000");
    const cyberpunk = chooseVisualSignature("A cyberpunk courier under neon rain in a future city", "00000000-0000-4000-8000-000000000000");

    expect(domestic.id).not.toBe("cyberpunk_signal");
    expect(cyberpunk.id).toBe("cyberpunk_signal");
  });

  it("routes rock and roll guitar prompts to live-band visuals without canned motifs", async () => {
    const treatment = await createTreatment(job("A rock and roll guitar music video in a sweaty rehearsal room."));
    const treatmentText = `${treatment.visualWorld} ${treatment.subject.description}`;

    expect(treatment.visualSignature?.id).toBe("live_band_performance");
    expect(treatment.styleContract?.routing.musicProfile).toBe("rock");
    expect(treatmentText).toMatch(/live-band|amplifier|guitar/i);
    expect(treatmentText).not.toMatch(/cassette|microphone|paper hearts?/i);
  });

  it("parses broad creative intent without coupling music and visual lanes", () => {
    const rock = deterministicStyleContract("Rock and roll guitar in a gritty cyberpunk film noir city.");
    const jazz = deterministicStyleContract("Smooth jazz lounge video with saxophone, piano, brushed drums, and warm amber lights.");
    const tron = deterministicStyleContract("Techno pop with a Tron style, digital grid light trails, synths, and drum machines.");

    expect(rock.routing.musicProfile).toBe("rock");
    expect(rock.routing.visualLane).toBe("cyberpunk_noir");
    expect(rock.musicIntent.requestedInstruments.join(" ")).toMatch(/guitar/i);
    expect(jazz.routing.musicProfile).toBe("jazz");
    expect(jazz.routing.visualLane).toBe("jazz_lounge");
    expect(jazz.visualIntent.positiveVocabulary.join(" ")).toMatch(/saxophone|piano|brass|velvet|spotlight/i);
    expect(tron.routing.musicProfile).toBe("electronic");
    expect(tron.routing.visualLane).toBe("digital_grid");
    expect(tron.musicIntent.positiveStyle.join(" ")).toMatch(/synth|drum machine|electronic/i);
  });

  it("uses positive prompt vocabulary for samurai rock prompts instead of generic music-symbol props", async () => {
    const treatment = await createTreatment(job([
      "Create a rock and roll music video based on the samurai tradition with Japanese harp over it black and white",
      "",
      "Director style intervention (Reference, 42%): make the anchor assets read like premium production plates with reusable prompt-derived details.",
    ].join("\n")));
    const stylePrompt = promptFor("style", treatment);
    const palettePrompt = promptFor("palette", treatment);
    const promptText = `${treatment.visualWorld} ${stylePrompt} ${palettePrompt}`;

    expect(treatment.storySpine).not.toContain("Director style intervention");
    expect(treatment.visualSignature?.recurringMotifs).toEqual([
      "samurai armor",
      "Japanese harp",
      "monochrome contrast",
    ]);
    expect(promptText).toMatch(/samurai armor|Japanese harp|monochrome contrast/i);
    expect(promptText).toMatch(/positive visual vocabulary/i);
    expect(promptText).not.toMatch(/cassette|microphone|paper hearts?|heart-shaped/i);
    expect(promptText).not.toMatch(/do not introduce|negative prompt|blacklist/i);
  });

  it("stores a director-chosen voice family and genre-first rock instrumentation in the music plan", async () => {
    const plan = await createCompositionPlan(brief({ genre: "1980s rock with cinematic pop hooks" }));
    const instrumentation = plan.sections.map((section) => section.instrumentation).join(" ");

    expect(plan.vocal).toBe(true);
    expect(plan.voiceFamily).toBe("male");
    expect(plan.styleSummary).toMatch(/electric guitars|live drums|bass guitar/i);
    expect(instrumentation).toMatch(/electric guitar|live drums|bass guitar|amplifier/i);
    expect(instrumentation).not.toMatch(/synth|pads|electronic/i);
  });

  it("keeps synth language when the user asks for electronic music", async () => {
    const plan = await createCompositionPlan(brief({
      genre: "alt-pop electronic with cinematic percussion",
      visualWorld: "Future-city visuals with synth signal light and clean electronic rhythm.",
    }));
    const instrumentation = plan.sections.map((section) => section.instrumentation).join(" ");

    expect(plan.styleSummary).toMatch(/electronic|synth/i);
    expect(instrumentation).toMatch(/synth|programmed drums|pads/i);
  });

  it("uses genre-first smooth jazz instrumentation from the style contract", async () => {
    const treatment = await createTreatment(job("Create a smooth jazz music video with saxophone, piano, brushed drums, and warm lounge lighting."));
    const plan = await createCompositionPlan(treatment);
    const instrumentation = plan.sections.map((section) => section.instrumentation).join(" ");

    expect(plan.styleSummary).toMatch(/smooth cinematic jazz|saxophone|brushed drums|piano/i);
    expect(instrumentation).toMatch(/saxophone|piano|brushed drums|bass/i);
    expect(instrumentation).not.toMatch(/bright hook synth|programmed drums|EDM/i);
  });

  it("uses techno and Tron language only when requested", async () => {
    const treatment = await createTreatment(job("Techno pop with a Tron style, digital grid light trails, synths, and drum machines."));
    const plan = await createCompositionPlan(treatment);
    const instrumentation = plan.sections.map((section) => section.instrumentation).join(" ");

    expect(treatment.visualSignature?.id).toBe("digital_grid");
    expect(plan.styleSummary).toMatch(/techno-pop|synth|drum-machine|electronic/i);
    expect(instrumentation).toMatch(/synth|programmed drums|electronic bass/i);
  });

  it("keeps conceptual shot prompts away from literal singer language", async () => {
    const shotPlan = await createShotPlan(
      brief({ visualMode: "conceptual", subjectType: "abstract" }),
      beatGrid(),
      anchors(["style", "environment", "palette"]),
      musicPlan("female"),
    );

    expect(shotPlan.shots[0].referenceImages).toHaveLength(2);
    expect(shotPlan.shots[0].sceneLane).toBeTruthy();
    expect(shotPlan.shots[0].referenceRoles).toContain("style");
    expect(shotPlan.shots[0].prompt).toContain("prompt-derived motion");
    expect(shotPlan.shots[0].prompt).not.toMatch(/\b(mouth|lip[- ]?sync|singing into camera)\b/i);
  });

  it("matches visible performer presentation to voice family", async () => {
    const shotPlan = await createShotPlan(
      brief({ visualMode: "visible_performer", subjectType: "character" }),
      beatGrid(),
      anchors(["character", "style", "environment", "palette"]),
      musicPlan("female"),
    );

    expect(shotPlan.shots[0].referenceImages[0]).toContain("character");
    expect(shotPlan.shots[0].prompt).toContain("female-presenting");
  });

  it("adds varied shot metadata before expensive Seedance generation", async () => {
    const shotPlan = await createShotPlan(
      brief({ visualMode: "conceptual", subjectType: "environment" }),
      beatGrid90(),
      anchors(["style", "environment", "palette"]),
      musicPlan("instrumental"),
    );
    const diversity = scoreShotPlanDiversity(shotPlan);

    expect(shotPlan.shots.length).toBeGreaterThan(6);
    expect(new Set(shotPlan.shots.map((shot) => shot.sceneLane)).size).toBeGreaterThan(3);
    expect(new Set(shotPlan.shots.map((shot) => shot.visualMotif)).size).toBeGreaterThan(2);
    expect(diversity.adjacentRepeatCount).toBe(0);
    expect(diversity.score).toBeGreaterThan(0.45);
  });

  it("never plans a provider slot above Seedance's 15-second limit", async () => {
    const shotPlan = await createShotPlan(
      brief({ visualMode: "conceptual", subjectType: "environment" }),
      beatGrid90(),
      anchors(["style", "environment", "palette"]),
      musicPlan("instrumental"),
    );

    expect(shotPlan.shots.every((shot) => shot.endMs - shot.startMs <= 15_000)).toBe(true);
    expect(shotPlan.shots.every((shot, index) => index === 0 || shot.startMs === shotPlan.shots[index - 1].endMs)).toBe(true);
  });

  it("excludes low-alignment anchors from shot references", async () => {
    const shotPlan = await createShotPlan(
      brief({ visualMode: "conceptual", subjectType: "abstract" }),
      beatGrid(),
      anchors(["style", "environment", "palette"]).map((anchor) =>
        anchor.role === "environment"
          ? { ...anchor, audit: { role: anchor.role, status: "excluded" as const, dominantObjects: ["cassette tape"], styleAlignment: 0.2, reuseEligible: false, notes: ["unrequested motif"], source: "vision" as const } }
          : { ...anchor, audit: { role: anchor.role, status: "aligned" as const, dominantObjects: [], styleAlignment: 0.9, reuseEligible: true, notes: [], source: "vision" as const } },
      ),
      musicPlan("instrumental"),
    );

    expect(shotPlan.shots[0].referenceRoles).toContain("environment");
    expect(shotPlan.shots[0].referenceImages).not.toContain("https://example.com/environment.png");
  });

  it("keeps a seeded character anchor even when the reuse-audit would exclude it, and flags the shot", async () => {
    const shotPlan = await createShotPlan(
      brief({ visualMode: "visible_performer", subjectType: "character" }),
      beatGrid(),
      anchors(["character", "style", "environment", "palette"]).map((anchor) =>
        anchor.role === "character"
          ? {
              ...anchor,
              seededFrom: { intent: "character" as const, referenceCount: 2 },
              audit: { role: anchor.role, status: "excluded" as const, dominantObjects: [], styleAlignment: 0.2, reuseEligible: false, notes: ["stylized portrait"], source: "vision" as const },
            }
          : anchor,
      ),
      musicPlan("female"),
    );

    // The user-seeded character survives the reuse-audit and stays the first reference...
    expect(shotPlan.shots[0].referenceImages[0]).toContain("character");
    // ...and the shot is flagged so Seedance never replaces the performer with a stranger.
    expect(shotPlan.shots[0].seededCharacter).toBe(true);
  });

  it("threads editor direction into shot plan prompts", async () => {
    const shotPlan = await createShotPlan(
      brief({ visualMode: "conceptual", subjectType: "abstract" }),
      beatGrid(),
      anchors(["style", "environment", "palette"]),
      musicPlan("instrumental"),
      "make the movement feel like black ink panels snapping on percussion",
    );

    expect(shotPlan.shots[0].prompt).toContain("[User edit directives]");
    expect(shotPlan.shots[0].prompt).toContain("black ink panels");
  });
});

function brief(overrides: {
  visualMode?: CreativeBrief["visualMode"];
  subjectType?: CreativeBrief["subject"]["type"];
  genre?: string;
  visualWorld?: string;
} = {}): CreativeBrief {
  const visualMode = overrides.visualMode ?? "conceptual";
  const subjectType = overrides.subjectType ?? (visualMode === "visible_performer" ? "character" : "abstract");
  return {
    videoId: "00000000-0000-4000-8000-000000000000",
    durationSeconds: 60,
    aspectRatio: "9:16",
    visualMode,
    storySpine: "A joyful retro love story blooms through lights, lockers, rain, and neon stage reflections.",
    visualWorld: overrides.visualWorld ??
      "Conceptual-first 1980s rock visuals with practical light, clean silhouettes, symbolic props, and atmospheric depth.",
    subject: {
      type: subjectType,
      description:
        subjectType === "character"
          ? "A fictional adult lead performer, age 25 or older, with a consistent silhouette."
          : "Symbolic props, light, silhouettes, and motion motifs.",
    },
    visualSignature: chooseVisualSignature("A joyful retro love story blooms through lights and stage reflections.", "00000000-0000-4000-8000-000000000000"),
    energyArc: ["build", "calm", "peak"],
    mood: "joyful",
    genre: overrides.genre ?? "alt-pop electronic",
    safetyNotes: [],
  };
}

function job(prompt: string): VideoJob {
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
    seeds: { subjects: [], aesthetic: [] },
    anchorAssets: [],
    generatedShots: [],
    editDirectives: [],
    artifactVersions: [],
    phases: [],
    providerCalls: [],
  };
}

function musicPlan(voiceFamily: MusicPlan["voiceFamily"]): MusicPlan {
  return {
    videoId: "00000000-0000-4000-8000-000000000000",
    vocal: voiceFamily !== "instrumental",
    voiceFamily,
    language: "en",
    bpm: 132,
    key: "A minor",
    sections: [
      { id: "intro", durationSeconds: 12, energy: 0.3, instrumentation: "guitars", lyrics: "we wake up" },
      { id: "verse", durationSeconds: 18, energy: 0.5, instrumentation: "drums", lyrics: "we move" },
      { id: "chorus", durationSeconds: 30, energy: 0.9, instrumentation: "hook", lyrics: "lights up" },
    ],
  };
}

function beatGrid(): BeatGrid {
  return {
    videoId: "00000000-0000-4000-8000-000000000000",
    bpm: 120,
    events: [
      { timeMs: 0, type: "section_change", strength: 1, sectionId: "intro" },
      { timeMs: 0, type: "downbeat", strength: 1, sectionId: "intro" },
      { timeMs: 4000, type: "downbeat", strength: 1, sectionId: "intro" },
      { timeMs: 8000, type: "downbeat", strength: 1, sectionId: "intro" },
      { timeMs: 12000, type: "section_change", strength: 1, sectionId: "chorus" },
      { timeMs: 12000, type: "downbeat", strength: 1, sectionId: "chorus" },
      { timeMs: 18000, type: "downbeat", strength: 1, sectionId: "chorus" },
      { timeMs: 24000, type: "downbeat", strength: 1, sectionId: "chorus" },
      { timeMs: 30000, type: "downbeat", strength: 1, sectionId: "chorus" },
      { timeMs: 36000, type: "downbeat", strength: 1, sectionId: "chorus" },
      { timeMs: 42000, type: "downbeat", strength: 1, sectionId: "chorus" },
      { timeMs: 48000, type: "downbeat", strength: 1, sectionId: "chorus" },
      { timeMs: 54000, type: "downbeat", strength: 1, sectionId: "chorus" },
      { timeMs: 60000, type: "downbeat", strength: 1, sectionId: "chorus" },
    ],
  };
}

function beatGrid90(): BeatGrid {
  return {
    videoId: "00000000-0000-4000-8000-000000000000",
    bpm: 120,
    events: [
      { timeMs: 0, type: "section_change", strength: 1, sectionId: "intro" },
      { timeMs: 0, type: "downbeat", strength: 1, sectionId: "intro" },
      { timeMs: 13000, type: "section_change", strength: 1, sectionId: "verse_1" },
      { timeMs: 13000, type: "downbeat", strength: 1, sectionId: "verse_1" },
      { timeMs: 33000, type: "section_change", strength: 1, sectionId: "pre_chorus" },
      { timeMs: 33000, type: "downbeat", strength: 1, sectionId: "pre_chorus" },
      { timeMs: 46000, type: "section_change", strength: 1, sectionId: "chorus_1" },
      { timeMs: 46000, type: "downbeat", strength: 1, sectionId: "chorus_1" },
      { timeMs: 68000, type: "section_change", strength: 1, sectionId: "bridge" },
      { timeMs: 68000, type: "downbeat", strength: 1, sectionId: "bridge" },
      { timeMs: 79000, type: "section_change", strength: 1, sectionId: "final_chorus" },
      { timeMs: 79000, type: "downbeat", strength: 1, sectionId: "final_chorus" },
      ...Array.from({ length: 23 }, (_, index) => ({
        timeMs: index * 4000,
        type: "downbeat" as const,
        strength: 1,
        sectionId: "grid",
      })),
    ],
  };
}

function anchors(roles: AnchorAsset["role"][]): AnchorAsset[] {
  return roles.map((role) => ({
    role,
    url: "https://example.com/" + role + ".png",
    promptUsed: role,
  }));
}
