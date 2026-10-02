import { describe, expect, it } from "vitest";

import { buildSeedanceReferenceRequest, formatFalError, isLikenessPolicyRejection, isRetryableSeedanceError } from "@/providers/seedance";
import { toElevenCompositionPlan } from "@/providers/elevenmusic";
import { createIdempotencyKey } from "@/lib/trace";
import { routeShotForQuality } from "@/lib/provider-capabilities";
import { promptFor } from "@/workflow/phases/anchorAssets";

describe("provider request construction", () => {
  it("routes quality tiers with an explicit provider reason", () => {
    const base = { seedanceTier: "standard", resolution: "720p" } as Parameters<typeof routeShotForQuality>[0];
    expect(routeShotForQuality(base, "draft")).toMatchObject({ seedanceTier: "fast", resolution: "480p" });
    expect(routeShotForQuality(base, "standard").routingReason).toMatch(/balanced/i);
    expect(routeShotForQuality(base, "premium").routingReason).toMatch(/validated/i);
  });

  it("builds Seedance reference-to-video with image and audio references", () => {
    const request = buildSeedanceReferenceRequest(
      {
        shotIndex: 0,
        startMs: 0,
        endMs: 12000,
        seedanceMode: "reference-to-video",
        seedanceTier: "standard",
        resolution: "720p",
        prompt: "At 0 seconds, cut through three views of the lead sprinting under neon rain.",
        referenceImages: ["https://example.com/character.png", "https://example.com/style.png"],
        audioReferenceUrl: "https://example.com/music.mp3?slice=0-10000",
        sceneLane: "performer_intro",
        visualMotif: "wet reflections",
        cameraIntent: "running tracking shot",
        referenceRoles: ["character", "style"],
        seed: 42,
        internalCuts: [4000, 8000],
      },
      {
        videoId: "00000000-0000-4000-8000-000000000000",
        durationSeconds: 75,
        aspectRatio: "9:16",
        visualMode: "visible_performer",
        storySpine: "A character moves through a future city.",
        visualWorld: "Neon city, hard backlight.",
        subject: { type: "character", description: "A courier" },
        energyArc: ["build", "peak", "drop"],
        mood: "urgent",
        genre: "electronic",
        safetyNotes: [],
      },
    );

    expect(request.generate_audio).toBe(false);
    expect(request.image_urls).toHaveLength(2);
    expect(request.audio_urls).toHaveLength(1);
    expect(request.prompt).toContain("Internal cuts");
    expect(request.prompt).toContain("adult performer");
    expect(request.prompt).toContain("locked performer/style");
    expect(request.prompt).toContain("maintaining strict wardrobe");
  });

  it("builds Seedance fallback requests without the character face reference", () => {
    const request = buildSeedanceReferenceRequest(
      {
        shotIndex: 0,
        startMs: 0,
        endMs: 12000,
        seedanceMode: "reference-to-video",
        seedanceTier: "standard",
        resolution: "720p",
        prompt: "At 0 seconds, cut through three views of a fictional performer on a retro stage.",
        referenceImages: [
          "https://example.com/character.png",
          "https://example.com/style.png",
          "https://example.com/environment.png",
        ],
        sceneLane: "environment_stage",
        visualMotif: "footlight bulbs",
        cameraIntent: "backstage follow",
        referenceRoles: ["character", "style", "environment"],
        seed: 42,
        internalCuts: [4000, 8000],
      },
      {
        videoId: "00000000-0000-4000-8000-000000000000",
        durationSeconds: 75,
        aspectRatio: "9:16",
        visualMode: "visible_performer",
        storySpine: "A character moves through a future city.",
        visualWorld: "Neon city, hard backlight.",
        subject: { type: "character", description: "A courier" },
        energyArc: ["build", "peak", "drop"],
        mood: "urgent",
        genre: "electronic",
        safetyNotes: [],
      },
      {
        referenceImages: ["https://example.com/style.png", "https://example.com/environment.png"],
        referencePolicy: "visual-only",
      },
    );

    expect(request.image_urls).toEqual([
      "https://example.com/style.png",
      "https://example.com/environment.png",
    ]);
    expect(request.prompt).toContain("visual style");
    expect(request.prompt).toContain("newly invented fictional adult performer");
    expect(request.prompt).toContain("original face");
    expect(request.prompt).not.toContain("locked performer/style");
  });

  it("builds conceptual Seedance requests around symbolic motion", () => {
    const request = buildSeedanceReferenceRequest(
      {
        shotIndex: 0,
        startMs: 0,
        endMs: 12000,
        seedanceMode: "reference-to-video",
        seedanceTier: "standard",
        resolution: "720p",
        prompt: "0-4s: neon dishes spin under kitchen light. 4-8s: soap bubbles pulse to the beat. 8-12s: silhouettes move through steam and reflections.",
        referenceImages: ["https://example.com/style.png", "https://example.com/environment.png"],
        sceneLane: "object_micro_chapter",
        visualMotif: "soap bubbles",
        cameraIntent: "macro push-in",
        referenceRoles: ["style", "palette"],
        seed: 42,
        internalCuts: [4000, 8000],
      },
      {
        videoId: "00000000-0000-4000-8000-000000000000",
        durationSeconds: 75,
        aspectRatio: "9:16",
        visualMode: "conceptual",
        storySpine: "A symbolic kitchen ritual becomes a neon pop dream.",
        visualWorld: "Conceptual light, reflections, objects, and atmospheric depth.",
        subject: { type: "abstract", description: "Dishes, water, bubbles, and light" },
        energyArc: ["build", "peak", "drop"],
        mood: "joyful",
        genre: "pop",
        safetyNotes: [],
      },
    );

    expect(request.prompt).toContain("dance-like motion");
    expect(request.prompt.indexOf("Shot direction")).toBeLessThan(request.prompt.indexOf("Global art direction"));
    expect(request.prompt).toContain("scene lane object_micro_chapter");
    expect(request.prompt).toContain("continuity focus soap bubbles");
    expect(request.prompt).not.toMatch(/symbolic motifs|recurring motifs/i);
    expect(request.prompt).not.toMatch(/lip[- ]?sync/i);
    expect(request.prompt).not.toMatch(/typography|readable text/i);
  });

  it("keeps Seedance guidance positive for prompt-derived samurai rock vocabulary", () => {
    const request = buildSeedanceReferenceRequest(
      {
        shotIndex: 0,
        startMs: 0,
        endMs: 12000,
        seedanceMode: "reference-to-video",
        seedanceTier: "standard",
        resolution: "720p",
        prompt: "Samurai armor silhouettes, Japanese harp strings, and monochrome stage light move on guitar downbeats.",
        referenceImages: ["https://example.com/style.png", "https://example.com/palette.png"],
        sceneLane: "object_micro_chapter",
        visualMotif: "samurai armor",
        cameraIntent: "low guitar tracking",
        referenceRoles: ["style", "palette"],
        seed: 42,
        internalCuts: [4000, 8000],
      },
      {
        videoId: "00000000-0000-4000-8000-000000000000",
        durationSeconds: 75,
        aspectRatio: "9:16",
        visualMode: "conceptual",
        storySpine: "A rock and roll samurai tradition video moves through Japanese harp strings and monochrome light.",
        visualWorld: "Live-band cinema with samurai armor, Japanese harp, monochrome contrast, and stage light.",
        visualSignature: {
          id: "live_band_performance",
          paletteFamily: "stage tungsten, road-case black, oxidized silver, denim blue, and warm white",
          palette: ["stage tungsten", "road-case black", "oxidized silver"],
          medium: "grounded live-band music-video cinema",
          worldGrammar: "rehearsal rooms, small stages, amplifier walls, drum risers, and raw studio floors",
          recurringMotifs: ["samurai armor", "Japanese harp", "monochrome contrast"],
          texture: "amplifier grille cloth, scuffed stage wood, cable coils, cymbal shimmer, and controlled haze",
          cameraLanguage: ["low guitar tracking", "drum-riser push", "handheld stage orbit"],
          avoidMotifs: [],
        },
        subject: { type: "abstract", description: "Samurai armor, Japanese harp strings, monochrome contrast, and stage light" },
        energyArc: ["build", "peak", "drop"],
        mood: "dramatic",
        genre: "guitar-driven rock",
        safetyNotes: [],
      },
    );

    expect(request.prompt).toMatch(/positive visual vocabulary samurai armor, Japanese harp, monochrome contrast/i);
    expect(request.prompt).not.toMatch(/cassette|microphone|paper hearts?|heart-shaped/i);
    expect(request.prompt).not.toMatch(/do not introduce|blacklist|negative prompt/i);
  });

  it("builds conceptual anchor prompts as an atlas and motif plate", () => {
    const brief = {
      videoId: "00000000-0000-4000-8000-000000000000",
      durationSeconds: 75,
      aspectRatio: "9:16" as const,
      visualMode: "conceptual" as const,
      storySpine: "A domestic ritual becomes a pop dream.",
      visualWorld: "Surreal domestic cinema with porcelain, chrome, suds, and tabletop choreography.",
      visualSignature: {
        id: "surreal_domestic",
        paletteFamily: "porcelain white, soap blue, butter yellow, tomato red, and chrome",
        palette: ["porcelain white", "soap blue", "butter yellow"],
        medium: "surreal practical-object cinema",
        worldGrammar: "kitchens, laundromats, tiled rooms, sinks, steam, bubbles, and glassware",
        recurringMotifs: ["soap bubbles", "spinning plates", "rinsing water"],
        texture: "wet ceramic, suds, soft steam, and polished metal",
        cameraLanguage: ["macro push-in", "overhead choreography", "waterline glide"],
        avoidMotifs: ["teal cyberpunk skyline"],
      },
      subject: { type: "abstract" as const, description: "Dishes, water, bubbles, and light" },
      energyArc: ["build" as const, "peak" as const, "drop" as const],
      mood: "playful",
      genre: "pop",
      safetyNotes: [],
    };

    const environmentPrompt = promptFor("environment", brief);
    const palettePrompt = promptFor("palette", brief);

    expect(environmentPrompt).toContain("Connected location atlas");
    expect(environmentPrompt).toContain("3 to 4 distinct spaces");
    expect(palettePrompt).toContain("Material and continuity plate");
    expect(palettePrompt).toContain("soap bubbles");
  });

  it("builds visible performer prompts that match the music voice family", () => {
    const prompt = promptFor(
      "character",
      {
        videoId: "00000000-0000-4000-8000-000000000000",
        durationSeconds: 75,
        aspectRatio: "9:16",
        visualMode: "visible_performer",
        storySpine: "A nostalgic first-love story at a retro campus dance performed by adult musicians.",
        visualWorld: "1980s rock stage lighting.",
        subject: { type: "character", description: "A fictional adult lead performer, age 25 or older." },
        energyArc: ["build", "peak", "drop"],
        mood: "joyful",
        genre: "1980s rock",
        safetyNotes: [],
      },
      {
        videoId: "00000000-0000-4000-8000-000000000000",
        vocal: true,
        voiceFamily: "male",
        language: "en",
        bpm: 132,
        key: "A minor",
        sections: [
          { id: "intro", durationSeconds: 12, energy: 0.3, instrumentation: "guitars", lyrics: "we wake up" },
          { id: "verse", durationSeconds: 18, energy: 0.5, instrumentation: "drums", lyrics: "we move" },
          { id: "chorus", durationSeconds: 30, energy: 0.9, instrumentation: "hook", lyrics: "lights up" },
        ],
      },
    );

    expect(prompt).toContain("male-presenting");
    expect(prompt).toContain("fictional adult");
  });

  it("threads editor direction into anchor prompts", () => {
    const prompt = promptFor(
      "style",
      {
        videoId: "00000000-0000-4000-8000-000000000000",
        durationSeconds: 75,
        aspectRatio: "9:16",
        visualMode: "conceptual",
        storySpine: "A samurai motif becomes an abstract signal through shadow and light.",
        visualWorld: "Black ink, rice paper, hard light, and futuristic projection surfaces.",
        subject: { type: "abstract", description: "Symbolic samurai shapes, shadows, and instruments." },
        energyArc: ["build", "peak", "drop"],
        mood: "focused",
        genre: "electronic",
        safetyNotes: [],
      },
      undefined,
      "make the style plate monochrome with one red sun accent",
    );

    expect(prompt).toContain("User edit directives");
    expect(prompt).toContain("one red sun accent");
  });

  it("builds Seedance-safe human anchor prompts", () => {
    const prompt = promptFor("character", {
      videoId: "00000000-0000-4000-8000-000000000000",
      durationSeconds: 75,
      aspectRatio: "9:16",
      visualMode: "visible_performer",
      storySpine: "A nostalgic first-love story at a retro campus dance performed by adult musicians.",
      visualWorld: "1980s rock stage lighting.",
      subject: { type: "character", description: "A fictional adult lead performer, age 25 or older." },
      energyArc: ["build", "peak", "drop"],
      mood: "joyful",
      genre: "1980s rock",
      safetyNotes: [],
    });

    expect(prompt).toContain("age 25 or older");
    expect(prompt).toContain("no readable text");
    expect(prompt).toContain("no age labels");
    expect(prompt).toContain("no band logos");
    expect(prompt).toContain("no photorealistic portrait");
    expect(prompt).toContain("illustrated character design sheet");
  });

  it("maps music plan and provider controls to Eleven composition_plan", () => {
    const plan = toElevenCompositionPlan(
      {
        videoId: "00000000-0000-4000-8000-000000000000",
        vocal: true,
        voiceFamily: "female",
        bpm: 132,
        key: "A minor",
        language: "en",
        styleSummary: "guitar-driven rock production with electric guitars and live drums",
        negativeStyleSummary: "synth-pop lead sound design",
        sections: [{ id: "chorus", durationSeconds: 12, energy: 0.9, instrumentation: "full drums", lyrics: "turn the lights up" }],
      },
      {
        globalStyle: "wide synth bass and crisp percussion",
        negativeStyle: "no muddy mix",
        sectionEdits: [
          {
            id: "chorus",
            durationSeconds: 14,
            localStyle: "anthemic hook with extra cymbal lift",
            negativeStyle: "no thin drums",
          },
        ],
      },
    );

    expect(plan.sections[0].durationMs).toBe(14000);
    expect(plan.sections[0].lines).toContain("turn the lights up");
    expect(plan.sections[0].positiveLocalStyles).toContain("anthemic hook with extra cymbal lift");
    expect(plan.sections[0].negativeLocalStyles).toContain("no thin drums");
    expect(plan.positiveGlobalStyles.join(" ")).toContain("female lead vocalist");
    expect(plan.positiveGlobalStyles).toContain("wide synth bass and crisp percussion");
    expect(plan.positiveGlobalStyles).toContain("guitar-driven rock production with electric guitars and live drums");
    expect(plan.negativeGlobalStyles).toContain("no muddy mix");
    expect(plan.negativeGlobalStyles).toContain("copyrighted lyrics");
    expect(plan.negativeGlobalStyles).not.toContain("male lead vocal");
    expect(plan.negativeGlobalStyles).not.toContain("synth-pop lead sound design");
  });

  it("derives stable idempotency keys", () => {
    expect(
      createIdempotencyKey({
        videoId: "00000000-0000-4000-8000-000000000000",
        phase: 7,
        shotIndex: 2,
      }),
    ).toBe(
      createIdempotencyKey({
        videoId: "00000000-0000-4000-8000-000000000000",
        phase: 7,
        shotIndex: 2,
      }),
    );
  });

  it("formats nested fal errors without leaking secrets", () => {
    const error = Object.assign(new Error("Internal Server Error"), {
      status: 500,
      requestId: "fal_req_123",
      body: {
        detail: {
          message: "Seedance upstream failed while processing image reference",
          apiKey: "should-not-leak",
        },
      },
      response: {
        status: 500,
        statusText: "Internal Server Error",
        data: { error: "worker crashed", token: "also-secret" },
      },
    });

    const formatted = formatFalError(error);

    expect(formatted).toContain("Internal Server Error");
    expect(formatted).toContain("status 500");
    expect(formatted).toContain("fal_req_123");
    expect(formatted).toContain("worker crashed");
    expect(formatted).not.toContain("should-not-leak");
    expect(formatted).not.toContain("also-secret");
  });
});

describe("isRetryableSeedanceError", () => {
  it("fails closed for explicit likeness-policy rejections", () => {
    const error = Object.assign(new Error("Private information and real-person likeness are not allowed"), { status: 422 });
    expect(isLikenessPolicyRejection(error)).toBe(true);
    expect(isRetryableSeedanceError(error)).toBe(false);
  });

  it("retries on transient HTTP status and network error codes", () => {
    expect(isRetryableSeedanceError(Object.assign(new Error("boom"), { status: 503 }))).toBe(true);
    expect(isRetryableSeedanceError(Object.assign(new Error("boom"), { statusCode: 429 }))).toBe(true);
    expect(isRetryableSeedanceError(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }))).toBe(true);
    expect(isRetryableSeedanceError(new Error("fetch failed"))).toBe(true);
  });

  it("retries on a network error code carried on error.cause", () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND queue.fal.run"), { code: "ENOTFOUND" });
    const error = Object.assign(new Error("request to provider failed"), { cause });
    expect(isRetryableSeedanceError(error)).toBe(true);
  });

  it("does NOT retry a permanent error whose echoed body merely mentions a transient word", () => {
    // Regression guard: classification must read structured fields, not the echoed response
    // body (which can contain user input coincidentally mentioning "timeout"/"network error").
    const error = Object.assign(new Error("Unprocessable Entity"), {
      status: 422,
      body: { detail: "your prompt mentioned a network error and a timeout" },
    });
    expect(isRetryableSeedanceError(error)).toBe(false);
  });

  it("ignores non-Error inputs", () => {
    expect(isRetryableSeedanceError("ETIMEDOUT")).toBe(false);
    expect(isRetryableSeedanceError(null)).toBe(false);
  });
});
