import { cents, estimateMediaGenerationCost } from "@/lib/cost";
import type { HybridVisualPlanV2, VideoJob } from "@/lib/schemas";

export function editorialImageSize(aspectRatio: VideoJob["aspectRatio"], qualityTier: VideoJob["qualityTier"]) {
  if (qualityTier === "premium") return aspectRatio === "9:16" ? "2160x3840" : aspectRatio === "1:1" ? "2048x2048" : "3840x2160";
  return aspectRatio === "9:16" ? "1024x1536" : aspectRatio === "1:1" ? "1024x1024" : "1536x1024";
}

/** Quote the same reservation inputs that the actual editorial providers use. */
export function naturalEditorialAllowance(input: {
  plan: HybridVisualPlanV2; aspectRatio: VideoJob["aspectRatio"]; durationSeconds: number;
  narration?: string[]; scoreReady?: boolean;
}) {
  const tier = input.plan.qualityTier;
  let cost = 50; // Final render reservation.
  for (const text of input.narration ?? []) cost += Math.ceil(text.length * .04);
  if (tier !== "draft" && !input.scoreReady) cost += Math.ceil(Math.min(120, Math.max(12, input.durationSeconds)) / 60 * 80) + 70;
  for (const beat of input.plan.beats) {
    if (!["editorial_image", "cinematic_broll", "synthetic_reenactment", "composite"].includes(beat.kind)) continue;
    if (!beat.assets.some((asset) => asset.kind === "image" && asset.status === "ready" && asset.url)) cost += cents(estimateMediaGenerationCost({ kind: "image", controls: { quality: tier === "premium" ? "high" : "medium", size: editorialImageSize(input.aspectRatio, tier) } }));
    if (tier !== "draft" && beat.kind !== "editorial_image" && !beat.assets.some((asset) => asset.kind === "video" && asset.status === "ready" && asset.url)) cost += cents(estimateMediaGenerationCost({ kind: "video", controls: { durationSeconds: Math.max(4, Math.min(15, Math.ceil((beat.endMs - beat.startMs) / 1000))), seedanceTier: beat.providerRoute.tier ?? "fast", resolution: beat.providerRoute.resolution ?? "720p" } }));
  }
  return cost;
}

/** Remaining allowance includes provider headroom and the final render. */
export function editorialRecoveryAllowanceCents(visualEstimateCents: number) {
  return Math.ceil(visualEstimateCents * 1.5) + 50;
}
