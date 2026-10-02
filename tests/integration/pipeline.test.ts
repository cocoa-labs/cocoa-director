import { describe, expect, it } from "vitest";

import { VideoCreateRequest } from "@/lib/schemas";
import { applySeedDefaults } from "@/lib/seed-policy";
import { getStore } from "@/lib/server/store";
import { advanceVideoToNextGate, runInitialTreatment } from "@/workflow";

describe("mock pipeline", () => {
  it("runs the phased workflow to a render manifest", async () => {
    process.env.PROVIDER_MODE = "mock";
    const request = VideoCreateRequest.parse({
      prompt: "A neon courier finds a hidden broadcast below a rain-slick skyline.",
      durationSeconds: 60,
      aspectRatio: "9:16",
    });
    const job = await getStore().createJob(request, {
      id: "test-user",
      email: "test@example.com",
      planTier: "dev",
      dailyBudgetCents: 5000,
    });

    await runInitialTreatment(job.id);
    await advanceVideoToNextGate(job.id);
    await advanceVideoToNextGate(job.id);
    await advanceVideoToNextGate(job.id);
    await advanceVideoToNextGate(job.id);
    await advanceVideoToNextGate(job.id);

    const finalJob = await getStore().getJob(job.id);
    expect(finalJob?.status).toBe("complete");
    expect(finalJob?.visualMode).toBe("conceptual");
    expect(finalJob?.creativeBrief?.visualMode).toBe("conceptual");
    expect(finalJob?.creativeBrief?.visualSignature?.id).toBe("cyberpunk_signal");
    expect(finalJob?.musicPlan?.voiceFamily).toMatch(/female|male|mixed|instrumental/);
    expect(finalJob?.beatGrid?.events.length).toBeGreaterThan(0);
    expect(finalJob?.anchorAssets.length).toBeGreaterThan(2);
    expect(finalJob?.anchorAssets.some((asset) => asset.role === "character")).toBe(false);
    expect(finalJob?.anchorAssets.some((asset) => asset.role === "title")).toBe(false);
    expect(finalJob?.generatedShots.length).toBeGreaterThan(0);
    expect(finalJob?.renderManifest?.shots.length).toBeGreaterThan(0);
    expect(finalJob?.finalVideoUrl).toBeDefined();
    const vault = await getStore().listLibraryAssets(finalJob?.userId ?? "");
    expect(vault.some((asset) =>
      asset.source === "render" &&
      asset.kind === "render" &&
      asset.metadata.videoJobId === finalJob?.id &&
      asset.url === finalJob?.finalVideoUrl
    )).toBe(true);
    expect(new Set(finalJob?.shotPlan?.shots.map((shot) => shot.sceneLane)).size).toBeGreaterThan(1);
  });

  it("threads a character seed through the pipeline so the user appears in the shots", async () => {
    process.env.PROVIDER_MODE = "mock";
    const input = applySeedDefaults(
      VideoCreateRequest.parse({
        prompt: "A neon courier becomes the star of a rain-slick rooftop anthem.",
        durationSeconds: 60,
        aspectRatio: "9:16",
        seeds: {
          subjects: [
            {
              images: [{ url: "https://example.com/me.png", mimeType: "image/png" }],
              consent: {
                affirmed: true,
                statement: "I have the right to use these images and consent to their use in generated video.",
                affirmedAt: "2026-06-07T00:00:00.000Z",
              },
            },
          ],
          aesthetic: [{ role: "environment", image: { url: "https://example.com/foliage.jpg", mimeType: "image/jpeg" } }],
        },
      }),
    );
    // A character seed forces performer mode at the route boundary.
    expect(input.visualMode).toBe("visible_performer");

    const job = await getStore().createJob(input, {
      id: "seed-pipeline-user",
      email: "seed@example.com",
      planTier: "dev",
      dailyBudgetCents: 5000,
    });
    expect(job.seeds.subjects).toHaveLength(1);

    await runInitialTreatment(job.id);
    await advanceVideoToNextGate(job.id);
    await advanceVideoToNextGate(job.id);
    await advanceVideoToNextGate(job.id);
    await advanceVideoToNextGate(job.id);
    await advanceVideoToNextGate(job.id);

    const finalJob = await getStore().getJob(job.id);
    // The character anchor is generated and stamped with its seed provenance...
    const character = finalJob?.anchorAssets.find((asset) => asset.role === "character");
    expect(character?.seededFrom?.intent).toBe("character");
    // ...and it flows into the shot references with the shot flagged as seeded.
    const seededShot = finalJob?.shotPlan?.shots.find((shot) => shot.seededCharacter);
    expect(seededShot).toBeDefined();
    expect(seededShot?.referenceImages).toContain(character?.url);
  });
});
