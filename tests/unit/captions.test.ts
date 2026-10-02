import { describe, expect, it } from "vitest";

import { captionCuesFromTimeline, timelineToSrt, timelineToVtt } from "@/lib/captions";
import { TimelineManifestV2 } from "@/lib/schemas";

describe("caption sidecars", () => {
  const timeline = TimelineManifestV2.parse({
    version: 2,
    productionId: "0d78ae58-446e-47c9-a444-18fa31fa8894",
    contentType: "explainer",
    durationMs: 62_250,
    fps: 30,
    aspectRatio: "16:9",
    compiledAt: "2026-07-28T00:00:00.000Z",
    tracks: [{
      id: "captions-main",
      kind: "captions",
      segments: [
        { id: "b", trackId: "captions-main", kind: "caption", startMs: 60_005, endMs: 62_250, metadata: { text: "Second cue" } },
        { id: "a", trackId: "captions-main", kind: "caption", startMs: 0, endMs: 1_230, metadata: { text: "First cue" } },
      ],
    }],
  });

  it("sorts timeline caption cues", () => {
    expect(captionCuesFromTimeline(timeline).map((cue) => cue.text)).toEqual(["First cue", "Second cue"]);
  });

  it("exports valid SRT timestamps", () => {
    expect(timelineToSrt(timeline)).toContain("00:00:00,000 --> 00:00:01,230\nFirst cue");
    expect(timelineToSrt(timeline)).toContain("00:01:00,005 --> 00:01:02,250\nSecond cue");
  });

  it("exports valid WebVTT timestamps", () => {
    expect(timelineToVtt(timeline)).toBe(
      "WEBVTT\n\n00:00:00.000 --> 00:00:01.230\nFirst cue\n\n00:01:00.005 --> 00:01:02.250\nSecond cue\n",
    );
  });
});
