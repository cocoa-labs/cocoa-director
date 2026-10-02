import { describe, expect, it } from "vitest";

import type { MediaGeneration, VideoJob } from "@/lib/schemas";
import { buildProductionProgress } from "@/lib/server/production-progress";
import { normalizeProviderError } from "@/lib/server/provider-errors";

const productionId = "00000000-0000-4000-8000-000000000401";
const now = new Date().toISOString();

describe("truthful editorial progress", () => {
  it("reports persisted unit counts and policy recovery instead of a fabricated percentage", () => {
    const job = {
      id: productionId,
      projectId: "00000000-0000-4000-8000-000000000402",
      userId: "user-1",
      prompt: "News digest",
      status: "running",
      currentPhase: 1,
      estimatedCostCents: 2472,
      actualCostCents: 2260,
      recoveryBudgetCents: 371,
      recoverySpentCents: 0,
      aspectRatio: "16:9",
      contentType: "news_digest",
      workflowVersion: "news-digest-v4",
      durationSeconds: 60,
      traceId: "trace-progress",
      cancellationRequested: false,
      createdAt: now,
      updatedAt: now,
      storyboard: { scenes: Array.from({ length: 12 }, (_, index) => ({ id: `scene-${index + 1}` })) },
      workflowSteps: [
        { id: "generation", name: "Cinematic clips", state: "running", dependsOn: ["imagery"] },
        { id: "narration", name: "Narration", state: "pending", dependsOn: ["storyboard_approval"] },
      ],
      artifactVersions: [], providerCalls: [], phases: [], seeds: { subjects: [], aesthetic: [] },
      anchorAssets: [], generatedShots: [], editDirectives: [],
    } as unknown as VideoJob;
    const generations: MediaGeneration[] = [];
    for (let index = 0; index < 18; index += 1) {
      generations.push(generation("image", index, "success"));
      generations.push(generation("video", index, index === 2 || index === 6 ? "failed" : "success"));
    }

    const snapshot = buildProductionProgress(job, generations);
    const visualStage = snapshot.stages.find((stage) => stage.id === "visuals");
    const narration = snapshot.units.filter((unit) => unit.kind === "speech");

    expect(snapshot.state).toBe("needs_attention");
    expect(snapshot.nextAction).toBe("resume_safe_recovery");
    expect(visualStage).toMatchObject({ ready: 34, total: 36, failed: 2 });
    expect(narration).toHaveLength(12);
    expect(narration.every((unit) => unit.state === "not_started")).toBe(true);
    expect(snapshot.costs.actualCents).toBe(2260);
  });

  it("classifies the FAL likeness rejection as actionable and non-transient", () => {
    const normalized = normalizeProviderError({
      status: 422,
      body: { detail: "This input cannot be processed under our authorized likeness and privacy policy." },
    }, "fal");

    expect(normalized.code).toBe("fal_likeness_policy");
    expect(normalized.retryable).toBe(false);
    expect(normalized.userMessage).toContain("identity-safe replacement");
  });

  it("keeps pending rough-cut QA neutral while visual providers are still running", () => {
    const job = {
      id: productionId,
      projectId: "00000000-0000-4000-8000-000000000402",
      userId: "user-1",
      prompt: "News digest",
      status: "running",
      currentPhase: 1,
      estimatedCostCents: 2472,
      actualCostCents: 100,
      recoveryBudgetCents: 371,
      recoverySpentCents: 0,
      aspectRatio: "16:9",
      contentType: "news_digest",
      workflowVersion: "news-digest-v5",
      durationSeconds: 60,
      traceId: "trace-progress",
      cancellationRequested: false,
      createdAt: now,
      updatedAt: now,
      workflowSteps: [
        { id: "imagery", name: "Editorial imagery", state: "complete", dependsOn: [], completedAt: now },
        { id: "generation", name: "Cinematic clips", state: "running", dependsOn: ["imagery"], startedAt: now },
        { id: "visual_rough_cut_qa", name: "Visual rough-cut QA", state: "pending", dependsOn: ["generation"] },
      ],
      artifactVersions: [], providerCalls: [], phases: [], seeds: { subjects: [], aesthetic: [] },
      anchorAssets: [], generatedShots: [], editDirectives: [],
    } as unknown as VideoJob;
    const image = generation("image", 0, "success");
    const video = {
      ...generation("video", 0, "success"),
      status: "running",
      outputUrls: {},
    } as MediaGeneration;
    const score = {
      ...generation("image", 1, "success"),
      id: "20000000-0000-4000-8000-000000000001",
      kind: "music",
      controls: {},
      outputUrls: { music: "https://example.com/score.mp3" },
    } as MediaGeneration;

    const snapshot = buildProductionProgress(job, [image, video, score]);
    const visualStage = snapshot.stages.find((stage) => stage.id === "visuals");

    expect(snapshot.visualQuality).toMatchObject({
      state: "not_started",
      retainedAssetCount: 1,
      rejectedAssetCount: 0,
      nextAction: "continue",
    });
    expect(visualStage).toMatchObject({ state: "running", ready: 2, running: 1 });
    expect(visualStage?.completedAt).toBeUndefined();
  });

  it("ignores obsolete and wrong-lane collisions after immutable current outputs exist", () => {
    const job = {
      id: productionId,
      projectId: "00000000-0000-4000-8000-000000000402",
      userId: "user-1",
      prompt: "News digest",
      status: "awaiting_user",
      currentPhase: 1,
      estimatedCostCents: 2472,
      actualCostCents: 2260,
      recoveryBudgetCents: 371,
      recoverySpentCents: 0,
      aspectRatio: "16:9",
      contentType: "news_digest",
      workflowVersion: "news-digest-v5",
      durationSeconds: 60,
      traceId: "trace-progress",
      cancellationRequested: false,
      createdAt: now,
      updatedAt: now,
      visualPlan: {
        beats: [
          { id: "scene-01-beat-02", sceneId: "scene-01", kind: "cinematic_broll" },
          { id: "scene-02-beat-01", sceneId: "scene-02", kind: "cinematic_broll" },
        ],
      },
      workflowSteps: [], artifactVersions: [], providerCalls: [], phases: [], seeds: { subjects: [], aesthetic: [] },
      anchorAssets: [], generatedShots: [], editDirectives: [],
    } as unknown as VideoJob;
    const generations = [
      generationWith("image", "scene-01-beat-02", "https://example.com/shared-plate.png", 1),
      generationWith("image", "scene-02-beat-01", "https://example.com/shared-plate.png", 2),
      generationWith("video", "scene-02-beat-02", "https://example.com/shared-legacy.mp4", 3),
      generationWith("video", "scene-03-beat-02", "https://example.com/shared-legacy.mp4", 4),
      generationWith("video", "scene-01-beat-02", "https://example.com/immutable-01.mp4", 5),
      generationWith("video", "scene-02-beat-01", "https://example.com/immutable-02.mp4", 6),
    ];

    expect(buildProductionProgress(job, generations).visualQuality).toBeUndefined();
  });
});

function generation(kind: "image" | "video", index: number, status: "success" | "failed") {
  const beatId = `scene-${String(index + 1).padStart(2, "0")}-beat-02`;
  return {
    id: `00000000-0000-4000-8000-${String(index + (kind === "video" ? 100 : 0)).padStart(12, "0")}`,
    projectId: "00000000-0000-4000-8000-000000000402",
    videoJobId: productionId,
    kind,
    provider: kind === "video" ? "fal" : "openai",
    model: kind === "video" ? "seedance-2.0" : "gpt-image-2",
    status,
    prompt: "Editorial visual",
    controls: { visualBeatId: beatId },
    inputAssetIds: [],
    outputUrls: status === "success" ? { primary: `https://example.com/${kind}-${index}` } : {},
    metadata: status === "failed" ? { errorCode: "fal_likeness_policy", attempt: 1 } : { attempt: 1 },
    costCents: status === "success" ? 100 : 0,
    error: status === "failed" ? "Authorized likeness policy rejection" : undefined,
    createdAt: now,
    updatedAt: now,
  } as MediaGeneration;
}

function generationWith(kind: "image" | "video", beatId: string, url: string, index: number) {
  return {
    ...generation(kind, index, "success"),
    id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    controls: { visualBeatId: beatId },
    outputUrls: { primary: url },
  } as MediaGeneration;
}
