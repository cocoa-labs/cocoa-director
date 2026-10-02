import type { LibraryAsset } from "@/lib/schemas";

// The exact consent text shown at upload and recorded with a character seed.
export const CONSENT_STATEMENT =
  "I have the right to use these images and consent to their use in generated video.";

// UI-facing seed roles. "you" → the character subject; the rest seed aesthetic anchors.
export const SEED_ROLES = ["you", "style", "environment", "palette"] as const;
export type SeedRole = (typeof SEED_ROLES)[number];
export type AestheticSeedRole = Exclude<SeedRole, "you">;

// Library-asset role convention: "you" for the character, "seed_<role>" for aesthetics.
export function libraryRoleForSeed(role: SeedRole): string {
  return role === "you" ? "you" : `seed_${role}`;
}

const MAX_YOU_PHOTOS = 5;

function isSeedImage(asset: LibraryAsset): boolean {
  return asset.kind === "image" && asset.tags.includes("seed") && !asset.deletedAt;
}

export function youPhotosFrom(libraryAssets: LibraryAsset[]): LibraryAsset[] {
  return libraryAssets.filter((asset) => isSeedImage(asset) && asset.role === "you");
}

export function aestheticSeedFrom(
  libraryAssets: LibraryAsset[],
  role: AestheticSeedRole,
): LibraryAsset | undefined {
  const target = libraryRoleForSeed(role);
  // Newest upload wins, so re-seeding a slot supersedes the previous image.
  return libraryAssets
    .filter((asset) => isSeedImage(asset) && asset.role === target)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
}

type ConsentRecordInput = { affirmed: true; statement: string; affirmedAt: string };
export type SeedsPayload = {
  subjects: { images: { url: string; mimeType: string }[]; consent: ConsentRecordInput }[];
  aesthetic: { role: AestheticSeedRole; image: { url: string; mimeType: string } }[];
};

const AESTHETIC_ROLES: AestheticSeedRole[] = ["style", "environment", "palette"];

// Derive the create-request `seeds` block from the user's seed library assets. Returns
// undefined when there are no seeds, so a seed-free run sends a byte-identical request.
export function buildSeedsPayload(
  libraryAssets: LibraryAsset[],
  affirmedAt: string,
): SeedsPayload | undefined {
  const you = youPhotosFrom(libraryAssets).slice(0, MAX_YOU_PHOTOS);
  const aesthetic = AESTHETIC_ROLES.flatMap((role) => {
    const asset = aestheticSeedFrom(libraryAssets, role);
    return asset ? [{ role, image: { url: asset.url, mimeType: asset.mimeType } }] : [];
  });

  if (you.length === 0 && aesthetic.length === 0) return undefined;

  return {
    subjects:
      you.length > 0
        ? [
            {
              images: you.map((asset) => ({ url: asset.url, mimeType: asset.mimeType })),
              consent: { affirmed: true, statement: CONSENT_STATEMENT, affirmedAt },
            },
          ]
        : [],
    aesthetic,
  };
}
