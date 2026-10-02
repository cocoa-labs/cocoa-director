import { describe, expect, it } from "vitest";

import { VideoCreateRequest } from "@/lib/schemas";
import { getStore } from "@/lib/server/store";

const USER = { id: "seed-user", email: "seed@example.com", planTier: "dev" as const, dailyBudgetCents: 5000 };

const CONSENT = {
  affirmed: true as const,
  statement: "I have the right to use these images and consent to their use in generated video.",
  affirmedAt: "2026-06-07T00:00:00.000Z",
};
const ME = { url: "https://example.com/me.png", mimeType: "image/png" };
const FOLIAGE = { url: "https://example.com/foliage.jpg", mimeType: "image/jpeg" };

describe("video seeds — put yourself in the video", () => {
  it("accepts a character subject + an aesthetic seed, with subject defaults", () => {
    const request = VideoCreateRequest.parse({
      prompt: "Put me in a neon-soaked rooftop anthem.",
      seeds: {
        subjects: [{ images: [ME, ME], consent: CONSENT }],
        aesthetic: [{ role: "environment", image: FOLIAGE }],
      },
    });

    expect(request.seeds?.subjects[0].id).toBe("you-1");
    expect(request.seeds?.subjects[0].label).toBe("YOU");
    expect(request.seeds?.subjects[0].role).toBe("character");
    expect(request.seeds?.subjects[0].images).toHaveLength(2);
    expect(request.seeds?.aesthetic[0].role).toBe("environment");
    expect(request.seeds?.aesthetic[0].image.url).toBe(FOLIAGE.url);
  });

  it("persists seeds on the job and returns them from getJob", async () => {
    const request = VideoCreateRequest.parse({
      prompt: "Put me in a neon-soaked rooftop anthem.",
      seeds: {
        subjects: [{ images: [ME], consent: CONSENT }],
        aesthetic: [{ role: "palette", image: FOLIAGE }],
      },
    });
    const job = await getStore().createJob(request, USER);
    const fetched = await getStore().getJob(job.id);

    expect(fetched?.seeds.subjects[0].images[0].url).toBe(ME.url);
    expect(fetched?.seeds.subjects[0].label).toBe("YOU");
    expect(fetched?.seeds.aesthetic[0].role).toBe("palette");
  });

  it("defaults seeds to empty when none are provided", async () => {
    const request = VideoCreateRequest.parse({
      prompt: "A quiet conceptual rain ballad with no people in frame.",
    });
    const job = await getStore().createJob(request, USER);
    expect(job.seeds).toEqual({ subjects: [], aesthetic: [] });
  });

  it("rejects a character subject whose consent is not affirmed (the consent gate)", () => {
    expect(() =>
      VideoCreateRequest.parse({
        prompt: "Put me in a neon-soaked rooftop anthem.",
        seeds: { subjects: [{ images: [ME], consent: { ...CONSENT, affirmed: false } }] },
      }),
    ).toThrow();
  });

  it("rejects a character subject with no consent record at all", () => {
    expect(() =>
      VideoCreateRequest.parse({
        prompt: "Put me in a neon-soaked rooftop anthem.",
        seeds: { subjects: [{ images: [ME] }] },
      }),
    ).toThrow();
  });
});
