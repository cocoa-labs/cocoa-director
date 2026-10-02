import { ApiRequestError } from "@/lib/server/api-error";

export type ProviderMode = "mock" | "live";
export type ElevenLabsMusicOutputFormat =
  | "mp3_22050_32"
  | "mp3_24000_48"
  | "mp3_44100_32"
  | "mp3_44100_64"
  | "mp3_44100_96"
  | "mp3_44100_128"
  | "mp3_44100_192"
  | "pcm_8000"
  | "pcm_16000"
  | "pcm_22050"
  | "pcm_24000"
  | "pcm_32000"
  | "pcm_44100"
  | "pcm_48000"
  | "ulaw_8000"
  | "alaw_8000"
  | "opus_48000_32"
  | "opus_48000_64"
  | "opus_48000_96"
  | "opus_48000_128"
  | "opus_48000_192";

const ELEVENLABS_OUTPUT_FORMATS = new Set<string>([
  "mp3_22050_32",
  "mp3_24000_48",
  "mp3_44100_32",
  "mp3_44100_64",
  "mp3_44100_96",
  "mp3_44100_128",
  "mp3_44100_192",
  "pcm_8000",
  "pcm_16000",
  "pcm_22050",
  "pcm_24000",
  "pcm_32000",
  "pcm_44100",
  "pcm_48000",
  "ulaw_8000",
  "alaw_8000",
  "opus_48000_32",
  "opus_48000_64",
  "opus_48000_96",
  "opus_48000_128",
  "opus_48000_192",
]);

export const LIVE_ENV_KEYS = [
  "OPENAI_API_KEY",
  "FAL_KEY",
  "ELEVENLABS_API_KEY",
  "DATABASE_URL",
  "BLOB_READ_WRITE_TOKEN",
] as const;

export function getProviderMode(): ProviderMode {
  return process.env.PROVIDER_MODE === "live" ? "live" : "mock";
}

export function isNewsDigestV2Enabled() {
  return process.env.NEWS_DIGEST_V2_ENABLED !== "false";
}

export function isNewsWebResearchEnabled() {
  return process.env.NEWS_WEB_RESEARCH_ENABLED === "true";
}

export function isHybridVisualsV2Enabled() {
  return process.env.HYBRID_VISUALS_V2_ENABLED !== "false";
}

export function isProductionProgressV2Enabled() {
  return process.env.PRODUCTION_PROGRESS_V2_ENABLED !== "false";
}

export function isHybridWorkflowV4Enabled() {
  return process.env.HYBRID_WORKFLOW_V4_ENABLED !== "false";
}

export function isHybridSafeRecoveryEnabled() {
  return process.env.HYBRID_SAFE_RECOVERY_ENABLED !== "false";
}

export function isImmutableGenerationOutputsEnabled() {
  return process.env.IMMUTABLE_GENERATION_OUTPUTS_ENABLED !== "false";
}

export function isEditorialDirectionV3Enabled() {
  return process.env.EDITORIAL_DIRECTION_V3_ENABLED !== "false";
}

export function isVisualVarietyQaEnabled() {
  return process.env.VISUAL_VARIETY_QA_ENABLED !== "false";
}

export function isVisualAutopolishEnabled() {
  return process.env.VISUAL_AUTOPOLISH_ENABLED !== "false";
}

export function isEditorialTimingV2Enabled() {
  return process.env.EDITORIAL_TIMING_V2_ENABLED !== "false";
}

export function isSourceVisualsV2Enabled() {
  return process.env.SOURCE_VISUALS_V2_ENABLED !== "false";
}

export function isLayeredEditorialCompositorEnabled() {
  return process.env.LAYERED_EDITORIAL_COMPOSITOR_ENABLED !== "false";
}

export function isEditorialMotionQaEnabled() {
  return process.env.EDITORIAL_MOTION_QA_ENABLED !== "false";
}

export function isCinematicReenactmentsEnabled() {
  return process.env.CINEMATIC_REENACTMENTS_ENABLED !== "false";
}

export function isNewsPresenterEnabled() {
  return process.env.NEWS_PRESENTER_ENABLED === "true";
}

export function getDailyBudgetCapUsd() {
  const value = Number(process.env.DAILY_BUDGET_CAP_USD_PER_USER ?? process.env.DAILY_BUDGET_CAP_USD ?? "50");
  return Number.isFinite(value) && value > 0 ? value : 50;
}

export function getGlobalDailyBudgetCapUsd() {
  const value = Number(process.env.DAILY_BUDGET_CAP_USD_GLOBAL ?? "50");
  return Number.isFinite(value) && value > 0 ? value : 50;
}

export function getOpenAiImageModel() {
  return process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-2";
}

export function getOpenAiImageSize() {
  return process.env.OPENAI_IMAGE_SIZE ?? "1024x1536";
}

export function getOpenAiImageQuality() {
  return process.env.OPENAI_IMAGE_QUALITY ?? "high";
}

export function getOpenAiImageTimeoutMs() {
  const value = Number(process.env.OPENAI_IMAGE_TIMEOUT_MS ?? "180000");
  return Number.isFinite(value) && value >= 15000 ? value : 180000;
}

export function getOpenAiImageRetryAttempts() {
  const value = Number(process.env.OPENAI_IMAGE_RETRY_ATTEMPTS ?? "2");
  return Number.isFinite(value) && value >= 1 ? Math.min(Math.floor(value), 4) : 2;
}

export type ElevenLabsMusicModel = "music_v1" | "music_v2";

export function getElevenLabsMusicModel(): ElevenLabsMusicModel {
  const value = process.env.ELEVENLABS_MUSIC_MODEL_ID ?? "music_v1";
  if (value !== "music_v1" && value !== "music_v2") {
    throw new Error('ELEVENLABS_MUSIC_MODEL_ID must be "music_v1" or "music_v2".');
  }
  return value;
}

export function getElevenLabsMusicOutputFormat(): ElevenLabsMusicOutputFormat {
  const value = process.env.ELEVENLABS_MUSIC_OUTPUT_FORMAT ?? "mp3_44100_192";
  if (!ELEVENLABS_OUTPUT_FORMATS.has(value)) {
    throw new Error(`Unsupported ELEVENLABS_MUSIC_OUTPUT_FORMAT: ${value}`);
  }
  return value as ElevenLabsMusicOutputFormat;
}

export function getSeedanceStandardEndpoint() {
  return process.env.SEEDANCE_STANDARD_ENDPOINT ?? "bytedance/seedance-2.0/reference-to-video";
}

export function getSeedanceFastEndpoint() {
  return process.env.SEEDANCE_FAST_ENDPOINT ?? "bytedance/seedance-2.0/fast/reference-to-video";
}

export function isLikenessVideoEnabled() {
  return process.env.LIKENESS_VIDEO_ENABLED !== "false";
}

export function isLikenessLiveValidated() {
  return process.env.LIKENESS_LIVE_VALIDATED === "true";
}

export function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function getMissingLiveEnvKeys() {
  const keys = [...LIVE_ENV_KEYS, "AUTH_SECRET", "ADMIN_INVITE_CODES",
    ...(isNewsDigestV2Enabled() ? ["PRIVATE_BLOB_READ_WRITE_TOKEN"] : [])];
  return keys.filter((key) => !process.env[key]?.trim());
}

export function assertLiveEnvironmentReady() {
  const missing = getMissingLiveEnvKeys();
  for (const key of ["DAILY_BUDGET_CAP_USD_GLOBAL", "DAILY_BUDGET_CAP_USD_PER_USER"]) {
    if (!Number.isFinite(Number(process.env[key])) || Number(process.env[key]) <= 0) missing.push(key);
  }
  if (missing.length > 0) {
    throw new ApiRequestError(`Live configuration is incomplete: ${missing.join(", ")}. Run npm run doctor.`, 503, "live_configuration_incomplete");
  }
}

export function hasLiveProviderKeys() {
  return getMissingLiveEnvKeys().length === 0;
}
