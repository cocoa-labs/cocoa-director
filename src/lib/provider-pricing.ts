import type { Shot } from "@/lib/schemas";

export const PROVIDER_PRICING = {
  seedance: {
    standard720PerSecondUsd: 0.3034,
    fast480PerSecondUsd: 0.2419,
    fast720PerSecondUsd: 0.2419,
    standard1080PerSecondUsd: 0.682,
  },
  qualityTargetsPerMinuteUsd: {
    draft: 1.5,
    standard: 8,
    premium: 18,
  },
} as const;

export function seedanceRateForShot(shot: Pick<Shot, "resolution" | "seedanceTier">) {
  if (shot.resolution === "1080p") return PROVIDER_PRICING.seedance.standard1080PerSecondUsd;
  return shot.seedanceTier === "fast" || shot.resolution === "480p"
    ? PROVIDER_PRICING.seedance.fast720PerSecondUsd
    : PROVIDER_PRICING.seedance.standard720PerSecondUsd;
}
