import { describe, expect, it } from "vitest";

import { VideoCreateRequest } from "@/lib/schemas";
import { applySeedDefaults } from "@/lib/seed-policy";

const CONSENT = {
  affirmed: true as const,
  statement: "I have the right to use these images and consent to their use in generated video.",
  affirmedAt: "2026-06-07T00:00:00.000Z",
};
const ME = { url: "https://example.com/me.png", mimeType: "image/png" };
const FOLIAGE = { url: "https://example.com/foliage.jpg", mimeType: "image/jpeg" };

function request(overrides: Record<string, unknown>) {
  return VideoCreateRequest.parse({ prompt: "Put me in a neon rooftop anthem, please.", ...overrides });
}

describe("applySeedDefaults — performer mode follows a character seed", () => {
  it("forces visible_performer when a character seed is present in conceptual mode", () => {
    const input = request({ visualMode: "conceptual", seeds: { subjects: [{ images: [ME], consent: CONSENT }] } });
    expect(applySeedDefaults(input).visualMode).toBe("visible_performer");
  });

  it("leaves conceptual mode alone when there are no seeds", () => {
    const input = request({ visualMode: "conceptual" });
    expect(applySeedDefaults(input).visualMode).toBe("conceptual");
  });

  it("leaves conceptual mode alone for an aesthetic-only seed (no person to put on screen)", () => {
    const input = request({ visualMode: "conceptual", seeds: { aesthetic: [{ role: "environment", image: FOLIAGE }] } });
    expect(applySeedDefaults(input).visualMode).toBe("conceptual");
  });

  it("does not override an explicit visible_performer choice", () => {
    const input = request({ visualMode: "visible_performer", seeds: { subjects: [{ images: [ME], consent: CONSENT }] } });
    expect(applySeedDefaults(input).visualMode).toBe("visible_performer");
  });
});
