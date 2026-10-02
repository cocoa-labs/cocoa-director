import { describe, expect, it } from "vitest";

import { applyMusicProviderControls, applyShotProviderControls } from "@/lib/provider-capabilities";
import type { Shot } from "@/lib/schemas";

describe("provider capability helpers", () => {
  it("applies selected Seedance shot controls without mutating the source shot", () => {
    const shot: Shot = {
      shotIndex: 2,
      startMs: 5000,
      endMs: 13000,
      seedanceMode: "reference-to-video",
      seedanceTier: "standard",
      resolution: "720p",
      prompt: "A high contrast samurai silhouette crosses a paper wall under graphic shadow.",
      referenceImages: [
        "https://example.com/style.png",
        "https://example.com/environment.png",
        "https://example.com/palette.png",
        "https://example.com/title.png",
      ],
      referenceRoles: ["style", "environment", "palette", "title"],
      sceneLane: "shadow_ritual",
      visualMotif: "ink blade",
      cameraIntent: "slow lateral track",
      seed: 42,
      internalCuts: [8000],
    };

    const directed = applyShotProviderControls(shot, {
      seedanceMode: "image-to-video",
      seedanceTier: "fast",
      durationSeconds: 12,
      aspectRatio: "16:9",
      resolution: "1080p",
      seedMode: "lock",
      seed: 99,
      referenceImageLimit: 2,
      audioReferenceUrl: "https://example.com/hit.wav",
      generateAudio: true,
    });

    expect(directed.endMs).toBe(17000);
    expect(directed.seedanceMode).toBe("image-to-video");
    expect(directed.seedanceTier).toBe("fast");
    expect(directed.resolution).toBe("720p");
    expect(directed.seedanceAspectRatio).toBe("16:9");
    expect(directed.seed).toBe(99);
    expect(directed.referenceImages).toEqual([
      "https://example.com/style.png",
      "https://example.com/environment.png",
    ]);
    expect(directed.audioReferenceUrl).toBe("https://example.com/hit.wav");
    expect(directed.generateAudio).toBe(true);
    expect(shot.referenceImages).toHaveLength(4);
    expect(shot.resolution).toBe("720p");
  });

  it("applies ElevenLabs section controls without mutating the source plan", () => {
    const plan = {
      videoId: "00000000-0000-4000-8000-000000000000",
      vocal: true,
      voiceFamily: "female" as const,
      language: "en",
      bpm: 132,
      key: "A minor",
      sections: [
        { id: "intro", durationSeconds: 10, energy: 0.3, instrumentation: "filtered synth pulse", lyrics: "wake up" },
        { id: "pre_chorus", durationSeconds: 12, energy: 0.7, instrumentation: "rising pads", lyrics: "rise now" },
        { id: "chorus", durationSeconds: 24, energy: 0.9, instrumentation: "full drums", lyrics: "lights up" },
      ],
    };

    const directed = applyMusicProviderControls(plan, {
      sectionEdits: [
        {
          id: "pre_chorus",
          durationSeconds: 16,
          localStyle: "syncopated taiko hits and widening pads",
        },
      ],
    });

    expect(directed.sections[1].durationSeconds).toBe(16);
    expect(directed.sections[1].instrumentation).toBe("syncopated taiko hits and widening pads");
    expect(plan.sections[1].durationSeconds).toBe(12);
    expect(plan.sections[1].instrumentation).toBe("rising pads");
  });
});
