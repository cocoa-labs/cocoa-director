import { describe, expect, it } from "vitest";

import {
  chooseProviderCapability,
  compileMusicTimeline,
  initialWorkflowSteps,
  validateTimeline,
  workflowProfileFor,
} from "@/lib/production";
import { ProductionCreateRequest, TimelineManifestV2 } from "@/lib/schemas";
import { buildSourceFirstDraft } from "@/workflow/source-first";

const productionId = "00000000-0000-4000-8000-000000000101";

describe("content-neutral productions", () => {
  it("parses source-first explainer requests and creates 20-40 scenes for five minutes", () => {
    const source = Array.from({ length: 80 }, (_, index) =>
      `Lesson point ${index + 1} explains a concrete idea with an example and a practical takeaway.`
    ).join(" ");
    const request = ProductionCreateRequest.parse({
      contentType: "explainer",
      brief: "Teach the supplied material clearly to a general audience.",
      sourceBundle: { inputs: [{ id: "notes", kind: "text", text: source }], claims: [] },
      targetDurationSeconds: 300,
      aspectRatio: "16:9",
    });

    const draft = buildSourceFirstDraft(productionId, request, "2026-07-28T00:00:00.000Z");

    expect(draft.outline.length).toBeGreaterThanOrEqual(20);
    expect(draft.outline.length).toBeLessThanOrEqual(40);
    expect(draft.timeline.durationMs).toBe(300_000);
    expect(draft.qaReport.passed).toBe(true);
  });

  it("blocks unsupported news claims", () => {
    const request = ProductionCreateRequest.parse({
      contentType: "news_digest",
      brief: "Summarize these unverified notes as a current news update.",
      sourceBundle: { inputs: [{ id: "notes", kind: "text", text: "A major event reportedly happened today." }] },
      targetDurationSeconds: 60,
    });
    const draft = buildSourceFirstDraft(productionId, request, "2026-07-28T00:00:00.000Z");

    expect(draft.qaReport.passed).toBe(false);
    expect(draft.qaReport.findings.some((finding) => finding.code === "facts.unsupported_claim")).toBe(true);
  });

  it("defines stable dependency-based workflow profiles", () => {
    const profile = workflowProfileFor("explainer");
    const steps = initialWorkflowSteps("explainer");

    expect(profile.id).toBe("explainer-v5");
    expect(steps.find((step) => step.id === "narration")?.dependsOn).toEqual(["storyboard_approval"]);
    expect(steps.find((step) => step.id === "timing_reconciliation")?.dependsOn).toEqual(["narration"]);
    expect(steps.find((step) => step.id === "generation")?.dependsOn).toEqual(["imagery"]);
    expect(steps.find((step) => step.id === "visual_rough_cut_qa")?.dependsOn).toEqual(["generation", "score"]);
    expect(steps.find((step) => step.id === "timeline")?.dependsOn).toEqual(["timing_reconciliation", "visual_rough_cut_qa"]);
    expect(steps.at(-1)?.id).toBe("final_qa");
  });
});

describe("timeline v2 integrity", () => {
  it("keeps measured media truth separate from the requested timeline duration", () => {
    const timeline = compileMusicTimeline({
      productionId,
      aspectRatio: "9:16",
      compiledAt: "2026-07-28T00:00:00.000Z",
      shots: [{
        shotIndex: 0,
        providerRequestId: "seedance-1",
        videoUrl: "https://example.com/shot.mp4",
        requestedDurationSeconds: 5.2,
        actualDurationSeconds: 5.1,
        usableInSeconds: 0,
        durationSeconds: 5,
        seed: 42,
        costUsd: 1,
        latencyMs: 100,
        attempts: 1,
      }],
      music: {
        videoId: productionId,
        url: "https://example.com/music.mp3",
        durationSeconds: 5.2,
        songId: "song-1",
        lyrics: [],
        providerRequestId: "music-1",
      },
      beatGrid: { videoId: productionId, bpm: 120, events: [] },
    });
    const segment = timeline.tracks.find((track) => track.kind === "video")?.segments[0];

    expect(segment?.requestedDurationMs).toBe(5_200);
    expect(segment?.actualDurationMs).toBe(5_100);
    expect(segment?.hold).toBe(false);
    const report = validateTimeline({ timeline });
    expect(report.passed).toBe(true);
    expect(report.findings.some((finding) => finding.code === "timeline.bounded_retime")).toBe(true);
  });

  it("rejects material source shortages instead of concealing them with a hold", () => {
    const timeline = TimelineManifestV2.parse({
      version: 2,
      productionId,
      contentType: "music_video",
      durationMs: 5_000,
      fps: 30,
      aspectRatio: "9:16",
      compiledAt: "2026-07-28T00:00:00.000Z",
      tracks: [{
        id: "video-main",
        kind: "video",
        segments: [{
          id: "shot-1",
          trackId: "video-main",
          kind: "video",
          startMs: 0,
          endMs: 5_000,
          sourceUrl: "https://example.com/short.mp4",
          actualDurationMs: 4_000,
          usableInMs: 0,
          hold: false,
        }],
      }],
    });
    const report = validateTimeline({ timeline });

    expect(report.passed).toBe(false);
    expect(report.findings.some((finding) => finding.code === "timeline.short_source")).toBe(true);
  });

  it("validates coverage across composited graphics and cinematic tracks", () => {
    const timeline = TimelineManifestV2.parse({
      version: 2,
      productionId,
      contentType: "news_digest",
      durationMs: 20_000,
      fps: 30,
      aspectRatio: "16:9",
      compiledAt: "2026-07-29T00:00:00.000Z",
      tracks: [
        {
          id: "visual-main",
          kind: "video",
          segments: [
            { id: "cinema-1", trackId: "visual-main", kind: "video", startMs: 5_000, endMs: 10_000, actualDurationMs: 5_000, usableInMs: 0, usableOutMs: 5_000, hold: false },
            { id: "cinema-2", trackId: "visual-main", kind: "video", startMs: 15_000, endMs: 20_000, actualDurationMs: 5_000, usableInMs: 0, usableOutMs: 5_000, hold: false },
          ],
        },
        {
          id: "graphics-main",
          kind: "graphics",
          segments: [
            { id: "graphic-1", trackId: "graphics-main", kind: "graphic", startMs: 0, endMs: 5_000, usableInMs: 0, hold: false },
            { id: "graphic-2", trackId: "graphics-main", kind: "graphic", startMs: 5_000, endMs: 10_000, usableInMs: 0, hold: false },
            { id: "graphic-3", trackId: "graphics-main", kind: "graphic", startMs: 10_000, endMs: 15_000, usableInMs: 0, hold: false },
            { id: "graphic-4", trackId: "graphics-main", kind: "graphic", startMs: 15_000, endMs: 20_000, usableInMs: 0, hold: false },
          ],
        },
      ],
    });

    const report = validateTimeline({ timeline });

    expect(report.findings.some((finding) => finding.code === "timeline.gap")).toBe(false);
    expect(report.findings.some((finding) => finding.code === "timeline.overlap")).toBe(false);
  });

  it("routes by measured capability and quality tier", () => {
    const selected = chooseProviderCapability({
      mediaKind: "video",
      qualityTier: "premium",
      requiredInputMode: "image",
      capabilities: [
        { provider: "fast", model: "draft", mediaKind: "video", inputModes: ["image"], resolutions: ["720p"], nativeAudio: false, canExtend: false, versionStatus: "stable", qualityScore: 0.5, reliabilityScore: 0.9, estimatedCostPerUnitUsd: 0.1, estimatedLatencySeconds: 10 },
        { provider: "cinema", model: "premium", mediaKind: "video", inputModes: ["image"], resolutions: ["1080p"], nativeAudio: true, canExtend: true, versionStatus: "stable", qualityScore: 0.95, reliabilityScore: 0.85, estimatedCostPerUnitUsd: 1.5, estimatedLatencySeconds: 90 },
      ],
    });

    expect(selected?.provider).toBe("cinema");
  });
});
