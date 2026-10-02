import type { AspectRatio, MediaGenerationCreateRequest, ShotPlan, VideoCreateRequest } from "@/lib/schemas";
import { PROVIDER_PRICING, seedanceRateForShot } from "@/lib/provider-pricing";

const QA_REGEN_BUFFER = 0.25;

export type CostEstimate = {
  totalUsd: number;
  treatmentUsd: number;
  musicPlanUsd: number;
  anchorAssetsUsd: number;
  shotGenerationUsd: number;
  qaBufferUsd: number;
  renderUsd: number;
};

export function estimateInitialCost<T extends Pick<VideoCreateRequest, "durationSeconds" | "aspectRatio">>(request: T): CostEstimate {
  const aspectMultiplier = request.aspectRatio === "9:16" ? 1 : 1.08;
  const shotGenerationUsd =
    request.durationSeconds * PROVIDER_PRICING.seedance.standard720PerSecondUsd * aspectMultiplier;
  const qaBufferUsd = shotGenerationUsd * QA_REGEN_BUFFER;
  const treatmentUsd = 0.3;
  const musicPlanUsd = 0.3 + Math.ceil(request.durationSeconds / 60) * 0.8;
  const anchorAssetsUsd = 2.4;
  const renderUsd = 0.5;

  return roundEstimate({
    treatmentUsd,
    musicPlanUsd,
    anchorAssetsUsd,
    shotGenerationUsd,
    qaBufferUsd,
    renderUsd,
    totalUsd:
      treatmentUsd +
      musicPlanUsd +
      anchorAssetsUsd +
      shotGenerationUsd +
      qaBufferUsd +
      renderUsd,
  });
}

export function estimateShotPlanCost(shotPlan: ShotPlan, aspectRatio: AspectRatio) {
  const aspectMultiplier = aspectRatio === "9:16" ? 1 : 1.08;
  const weightedCost = shotPlan.shots.reduce(
    (sum, shot) => sum + ((shot.endMs - shot.startMs) / 1000) * seedanceRateForShot(shot),
    0,
  );
  return Number((weightedCost * aspectMultiplier).toFixed(2));
}

export function estimateMediaGenerationCost(request: Pick<MediaGenerationCreateRequest, "controls" | "kind"> & { inputAssetIds?: string[] }) {
  if (request.kind === "image") {
    const quality = typeof request.controls.quality === "string" ? request.controls.quality : "high";
    const count = Math.max(1, numericControl(request.controls.variantCount, 1));
    const references = Math.max(0, numericControl(request.controls.referenceCount, request.inputAssetIds?.length ?? 0));
    // GPT Image 2 output plus prompt/reference input allowance (October 2026).
    const size = typeof request.controls.size === "string" ? request.controls.size : "1024x1536";
    const dimensions = /^(\d+)x(\d+)$/.exec(size);
    // Reserve proportionally above the published 1 MP reference; auto can choose up to 4K.
    const pixelMultiplier = size === "auto" ? 8 : dimensions ? Math.max(1, Number(dimensions[1]) * Number(dimensions[2]) / (1024 * 1024)) : 1.5;
    const perImage = quality === "low" ? 0.03 : quality === "medium" ? 0.08 : 0.25;
    return Number((count * perImage * pixelMultiplier + references * 0.05).toFixed(2));
  }

  if (request.kind === "video") {
    const duration = numericControl(request.controls.durationSeconds, 8);
    const resolution = typeof request.controls.resolution === "string" ? request.controls.resolution : "720p";
    const tier = typeof request.controls.seedanceTier === "string" ? request.controls.seedanceTier : "standard";
    const rate = resolution === "1080p"
      ? PROVIDER_PRICING.seedance.standard1080PerSecondUsd
      : tier === "fast" || resolution === "480p"
        ? PROVIDER_PRICING.seedance.fast720PerSecondUsd
        : PROVIDER_PRICING.seedance.standard720PerSecondUsd;
    const referenceCount = Array.isArray(request.controls.referenceVideoUrls) ? request.controls.referenceVideoUrls.length : 0;
    return Math.ceil((referenceCount ? (duration + 15 * referenceCount) * 0.6 : duration) * rate * 1.08 * 100) / 100;
  }

  if (request.kind === "music") {
    // Explicit genre controls can require a style pass and a lyric pass before composition.
    const planningAllowance = request.controls.musicControls ? 0.7 : 0;
    const editedDuration = Array.isArray(request.controls.sectionEdits) ? request.controls.sectionEdits.reduce((sum, section) => sum + numericControl(section?.durationSeconds, 0), 0) : 0;
    return Math.ceil(Math.max(numericControl(request.controls.durationSeconds, 60), editedDuration) / 60) * 0.8 + planningAllowance;
  }
  if (request.kind === "render") return 0.5;
  return 0;
}

export function cents(usd: number) {
  return Math.round(usd * 100);
}

export function dollars(centsValue: number) {
  return Number((centsValue / 100).toFixed(2));
}

function roundEstimate(estimate: CostEstimate): CostEstimate {
  return Object.fromEntries(
    Object.entries(estimate).map(([key, value]) => [key, Number(value.toFixed(2))]),
  ) as CostEstimate;
}

function numericControl(value: unknown, fallback: number) {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) ? number : fallback;
}
