import { afterEach, describe, expect, it } from "vitest";

import type { MediaGeneration } from "@/lib/schemas";
import { deleteBlobUrl, uploadPublicBlob } from "@/lib/server/blob";
import { immutableStorageKey } from "@/lib/server/media";

const createdUrls: string[] = [];

afterEach(async () => {
  await Promise.all(createdUrls.splice(0).map((url) => deleteBlobUrl(url)));
});

describe("immutable generation outputs", () => {
  it("gives concurrent image and video beats distinct generation-bound paths", () => {
    const paths = Array.from({ length: 4 }, (_, index) => ["image", "video"].map((kind) => immutableStorageKey(generation(index, kind as "image" | "video"), kind, kind === "image" ? "image/png" : "video/mp4"))).flat();

    expect(new Set(paths).size).toBe(8);
    expect(paths.every((path) => path.includes("/productions/40000000-0000-4000-8000-000000000004/generations/"))).toBe(true);
    expect(paths.every((path) => /scene-0[1-4]-beat-02\/(image|video)\/attempt-1\/(image\.png|video\.mp4)$/.test(path))).toBe(true);
  });

  it("allows idempotent replay but rejects divergent bytes at an immutable key", async () => {
    const pathname = `tests/immutable/${crypto.randomUUID()}/asset.bin`;
    const first = await uploadPublicBlob({ pathname, body: Buffer.from("same bytes"), contentType: "application/octet-stream", immutable: true });
    createdUrls.push(first.url);
    const replay = await uploadPublicBlob({ pathname, body: Buffer.from("same bytes"), contentType: "application/octet-stream", immutable: true });

    expect(replay.sha256).toBe(first.sha256);
    await expect(uploadPublicBlob({ pathname, body: Buffer.from("different bytes"), contentType: "application/octet-stream", immutable: true })).rejects.toThrow("Immutable blob collision");
  });
});

function generation(index: number, kind: "image" | "video") {
  return {
    id: `50000000-0000-4000-8000-${String(index * 2 + (kind === "video" ? 1 : 0)).padStart(12, "0")}`,
    projectId: "60000000-0000-4000-8000-000000000006",
    videoJobId: "40000000-0000-4000-8000-000000000004",
    kind,
    provider: kind === "video" ? "fal" : "openai",
    model: "test",
    status: "running",
    prompt: "Distinct editorial beat",
    controls: { visualBeatId: `scene-0${index + 1}-beat-02`, generationAttempt: 1 },
    inputAssetIds: [],
    outputUrls: {},
    metadata: {},
    costCents: 0,
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
  } as MediaGeneration;
}
