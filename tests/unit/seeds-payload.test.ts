import { describe, expect, it } from "vitest";

import { VideoCreateRequest, type LibraryAsset } from "@/lib/schemas";
import { buildSeedsPayload, CONSENT_STATEMENT } from "@/lib/seeds-payload";

function asset(role: string, url: string, overrides: Partial<LibraryAsset> = {}): LibraryAsset {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    userId: "u",
    kind: "image",
    name: "seed",
    role,
    url,
    mimeType: "image/png",
    source: "upload",
    tags: ["seed"],
    metadata: {},
    createdAt: "2026-06-07T00:00:00.000Z",
    ...overrides,
  } as LibraryAsset;
}

describe("buildSeedsPayload — libraryAssets → create-request seeds", () => {
  it("returns undefined when there are no seed assets (byte-identical no-seed request)", () => {
    expect(buildSeedsPayload([], "2026-06-07T00:00:00.000Z")).toBeUndefined();
  });

  it("builds a character subject from 'you' photos with affirmed consent", () => {
    const payload = buildSeedsPayload(
      [asset("you", "https://x/me1.png"), asset("you", "https://x/me2.png")],
      "2026-06-07T00:00:00.000Z",
    );
    expect(payload?.subjects).toHaveLength(1);
    expect(payload?.subjects[0].images).toHaveLength(2);
    expect(payload?.subjects[0].consent).toEqual({
      affirmed: true,
      statement: CONSENT_STATEMENT,
      affirmedAt: "2026-06-07T00:00:00.000Z",
    });
  });

  it("maps aesthetic seeds to their anchor roles", () => {
    const payload = buildSeedsPayload([asset("seed_environment", "https://x/foliage.jpg")], "t");
    expect(payload?.subjects).toHaveLength(0);
    expect(payload?.aesthetic).toEqual([
      { role: "environment", image: { url: "https://x/foliage.jpg", mimeType: "image/png" } },
    ]);
  });

  it("ignores non-seed images and caps 'you' photos at 5", () => {
    const youAssets = Array.from({ length: 7 }, (_, index) => asset("you", `https://x/me${index}.png`));
    const nonSeed = asset("you", "https://x/other.png", { tags: [] });
    const payload = buildSeedsPayload([...youAssets, nonSeed], "t");
    expect(payload?.subjects[0].images).toHaveLength(5);
  });

  it("produces a payload that satisfies VideoCreateRequest parsing", () => {
    const payload = buildSeedsPayload([asset("you", "https://x/me.png")], "2026-06-07T00:00:00.000Z");
    const parsed = VideoCreateRequest.parse({ prompt: "Put me in the rooftop video please.", seeds: payload });
    expect(parsed.seeds?.subjects[0].label).toBe("YOU");
  });
});
