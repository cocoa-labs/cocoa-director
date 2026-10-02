import { describe, expect, it } from "vitest";

import {
  appendDirectiveText,
  createArtifactSnapshot,
  createEditDirective,
  directiveTextBlock,
  markDirectivesApplied,
  providerControlsFor,
  restorePatchForVersion,
} from "@/lib/editor";
import { VideoCreateRequest } from "@/lib/schemas";
import { getStore } from "@/lib/server/store";
import type { VideoJob } from "@/lib/schemas";

describe("editor versioning helpers", () => {
  it("scopes edit directives to phases and targets", () => {
    const job = videoJob({
      editDirectives: [
        createEditDirective({
          scope: "shots",
          phase: 7,
          targetId: "1",
          text: "Make shot two feel like inked manga panels.",
        }),
        createEditDirective({
          scope: "anchors",
          phase: 5,
          text: "Keep anchors monochrome with one red accent.",
        }),
      ],
    });

    const shotBlock = directiveTextBlock(job, { scope: "shots", phase: 7, targetId: "1" });
    const anchorBlock = directiveTextBlock(job, { scope: "anchors", phase: 5 });

    expect(shotBlock).toContain("inked manga");
    expect(shotBlock).not.toContain("monochrome");
    expect(anchorBlock).toContain("red accent");
    expect(appendDirectiveText("base prompt", shotBlock)).toContain("[User edit directives]");
  });

  it("carries provider controls through directive prompt blocks", () => {
    const job = videoJob({
      editDirectives: [
        createEditDirective({
          scope: "shots",
          phase: 7,
          targetId: "1",
          text: "Hold longer on the shadow reveal and keep the seed locked.",
          strategy: "regenerate_replacement",
          providerControls: {
            shots: {
              durationSeconds: 12,
              seedanceTier: "fast",
              resolution: "720p",
              seedMode: "lock",
              seed: 99,
            },
          },
        }),
      ],
    });

    const block = directiveTextBlock(job, { scope: "shots", phase: 7, targetId: "1" });
    const controls = providerControlsFor(job, { scope: "shots", phase: 7, targetId: "1" });

    expect(block).toContain("durationSeconds=12");
    expect(block).toContain("seedanceTier=fast");
    expect(block).toContain("seed=99");
    expect(controls?.shots?.durationSeconds).toBe(12);
    expect(controls?.shots?.seed).toBe(99);
  });

  it("snapshots and restores the active artifact payload", () => {
    const original = videoJob();
    const snapshot = createArtifactSnapshot(original, { scope: "anchors", phase: 5 }, "Before anchors");
    expect(snapshot?.payload).toEqual(original.anchorAssets);

    const changed = videoJob({ anchorAssets: [] });
    const patch = restorePatchForVersion(changed, snapshot!);

    expect(patch.anchorAssets).toEqual(original.anchorAssets);
  });

  it("marks matching directives applied without dropping them", () => {
    const directive = createEditDirective({
      scope: "music",
      phase: 2,
      text: "Make the composition instrumental.",
    });
    const job = videoJob({ editDirectives: [directive] });
    const editDirectives = markDirectivesApplied(job, { scope: "music", phase: 2 });

    expect(editDirectives).toHaveLength(1);
    expect(editDirectives[0].appliedAt).toBeTruthy();
    expect(editDirectives[0].text).toBe(directive.text);
  });

  it("persists directives and versions through the job store", async () => {
    process.env.PROVIDER_MODE = "mock";
    const store = getStore();
    const job = await store.createJob(
      VideoCreateRequest.parse({
        prompt: "A black and white samurai music video driven by harp and electronic percussion.",
        durationSeconds: 60,
      }),
      {
        id: "editor-test-user",
        email: "editor@example.com",
        planTier: "dev",
        dailyBudgetCents: 5000,
      },
    );
    const directive = createEditDirective({
      scope: "anchors",
      phase: 5,
      text: "Push the visual system toward monochrome ink.",
    });
    const version = createArtifactSnapshot(videoJob(), { scope: "anchors", phase: 5 }, "Before anchors")!;

    await store.updateJob(job.id, {
      editDirectives: [directive],
      artifactVersions: [version],
    });

    const saved = await store.getJob(job.id);
    expect(saved?.editDirectives[0].text).toContain("monochrome ink");
    expect(saved?.artifactVersions[0].label).toBe("Before anchors");
  });
});

function videoJob(overrides: Partial<VideoJob> = {}): VideoJob {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    projectId: "project",
    userId: "user",
    prompt: "A black and white samurai music video with futuristic harp textures.",
    status: "awaiting_user",
    currentPhase: 7,
    estimatedCostCents: 5000,
    actualCostCents: 1000,
    recoveryBudgetCents: 0,
    recoverySpentCents: 0,
    aspectRatio: "9:16",
    visualMode: "conceptual",
    durationSeconds: 60,
    traceId: "trace_test",
    cancellationRequested: false,
    createdAt: "2026-05-02T00:00:00.000Z",
    updatedAt: "2026-05-02T00:00:00.000Z",
    seeds: { subjects: [], aesthetic: [] },
    creativeBrief: {
      videoId: "00000000-0000-4000-8000-000000000000",
      durationSeconds: 60,
      aspectRatio: "9:16",
      visualMode: "conceptual",
      storySpine: "A samurai motif evolves through light, shadow, rhythm, and ritual.",
      visualWorld: "Black ink, rice paper, hard shadows, and futuristic projection surfaces.",
      subject: { type: "abstract", description: "Symbolic samurai shapes, shadows, and instruments." },
      energyArc: ["build", "calm", "peak"],
      mood: "focused",
      genre: "electronic",
      safetyNotes: [],
    },
    anchorAssets: [
      {
        role: "style",
        url: "https://example.com/style.png",
        promptUsed: "style prompt",
      },
    ],
    shotPlan: {
      videoId: "00000000-0000-4000-8000-000000000000",
      shots: [
        {
          shotIndex: 1,
          startMs: 0,
          endMs: 8000,
          seedanceMode: "reference-to-video",
          seedanceTier: "standard",
          resolution: "720p",
          prompt: "A high contrast samurai shadow crosses rice paper under pulsing light.",
          referenceImages: ["https://example.com/style.png"],
          sceneLane: "shadow_ritual",
          visualMotif: "ink blade",
          cameraIntent: "controlled lateral track",
          referenceRoles: ["style"],
          seed: 42,
          internalCuts: [3000, 6000],
        },
      ],
    },
    generatedShots: [
      {
        shotIndex: 1,
        providerRequestId: "fal_1",
        videoUrl: "https://example.com/shot-2.mp4",
        durationSeconds: 8,
        seed: 42,
        costUsd: 4,
        latencyMs: 1000,
        attempts: 1,
      },
    ],
    editDirectives: [],
    artifactVersions: [],
    phases: [],
    providerCalls: [],
    ...overrides,
  };
}
