import { describe, expect, it } from "vitest";

import { analyzePcmBeats, extractBeatGrid } from "@/workflow/phases/beatExtraction";

describe("beat grid", () => {
  it("puts section changes and downbeats into the manifest artifact", async () => {
    const grid = await extractBeatGrid(
      {
        videoId: "00000000-0000-4000-8000-000000000000",
        url: "https://mock.cocoa.invalid/audio.mp3",
        durationSeconds: 20,
        songId: "song",
        providerRequestId: "request",
        lyrics: [],
      },
      {
        videoId: "00000000-0000-4000-8000-000000000000",
        vocal: true,
        voiceFamily: "mixed",
        bpm: 120,
        key: "A minor",
        sections: [
          { id: "intro", durationSeconds: 8, energy: 0.2, instrumentation: "pulse" },
          { id: "chorus", durationSeconds: 12, energy: 0.9, instrumentation: "drums" },
        ],
      },
    );

    expect(grid.events.some((event) => event.type === "section_change")).toBe(true);
    expect(grid.events.some((event) => event.type === "downbeat" && event.timeMs % 2000 === 0)).toBe(true);
    expect(grid.source).toBe("plan_fallback");
  });

  it("detects beat timing from rendered-audio PCM within one video frame", () => {
    const sampleRate = 22_050;
    const durationSeconds = 12;
    const pcm = new Float32Array(sampleRate * durationSeconds);
    const expectedOnsets: number[] = [];
    for (let timeSeconds = 0.25; timeSeconds < durationSeconds; timeSeconds += 0.5) {
      expectedOnsets.push(timeSeconds * 1_000);
      const start = Math.round(timeSeconds * sampleRate);
      for (let offset = 0; offset < 220; offset += 1) {
        pcm[start + offset] += Math.exp(-offset / 38) * Math.sin(offset * 0.9);
      }
    }

    const analysis = analyzePcmBeats(pcm, sampleRate, 120);
    const offsets = expectedOnsets.map((onset) => {
      const nearestBeat = analysis.phaseMs + Math.round((onset - analysis.phaseMs) / analysis.beatDurationMs) * analysis.beatDurationMs;
      return Math.abs(nearestBeat - onset);
    }).sort((left, right) => left - right);
    const medianOffset = offsets[Math.floor(offsets.length / 2)];

    expect(analysis.bpm).toBeGreaterThanOrEqual(119);
    expect(analysis.bpm).toBeLessThanOrEqual(121);
    expect(analysis.onsetTimesMs.length).toBeGreaterThan(10);
    expect(medianOffset).toBeLessThanOrEqual(1000 / 30);
  });
});
