import { describe, expect, it } from "vitest";

import { estimateInitialCost, estimateMediaGenerationCost } from "@/lib/cost";

describe("cost model", () => {
  it("rounds video allowances upward and includes every reference video", () => {
    expect(estimateMediaGenerationCost({ kind: "video", controls: { durationSeconds: 8, resolution: "720p" } })).toBe(2.63);
    const one = estimateMediaGenerationCost({ kind: "video", controls: { durationSeconds: 8, referenceVideoUrls: ["https://example.test/one.mp4"] } });
    const two = estimateMediaGenerationCost({ kind: "video", controls: { durationSeconds: 8, referenceVideoUrls: ["https://example.test/one.mp4", "https://example.test/two.mp4"] } });
    expect(two).toBeGreaterThan(one);
  });
  it("reserves standalone music planning and composition before either provider call", () => {
    const plain = estimateMediaGenerationCost({ kind: "music", controls: { durationSeconds: 12 } });
    const directed = estimateMediaGenerationCost({ kind: "music", controls: { durationSeconds: 12, musicControls: { genre: "ambient", vocals: "instrumental" } } });
    expect(directed).toBeCloseTo(plain + 0.7);
  });
  it("estimates final Seedance spend with a regeneration buffer", () => {
    const estimate = estimateInitialCost({
      prompt: "A stylish vertical video about a city made of signal light.",
      durationSeconds: 90,
      aspectRatio: "9:16",
      visualMode: "conceptual",
      autopilot: false,
    });

    expect(estimate.shotGenerationUsd).toBeGreaterThan(27);
    expect(estimate.qaBufferUsd).toBeCloseTo(estimate.shotGenerationUsd * 0.25, 1);
    expect(estimate.totalUsd).toBeGreaterThan(34);
  });
});
