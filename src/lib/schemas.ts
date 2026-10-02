import { z } from "zod";

import { DEV_BLOB_URL_PREFIX } from "@/lib/constants";
import { MAX_EDITORIAL_NARRATION_RATE, MIN_EDITORIAL_NARRATION_RATE } from "@/lib/editorial-pacing";

// Media URLs may be absolute (https://, blob:, data:, …) in production (Vercel
// Blob) or root-relative /dev-blob/… paths in local dev (no Vercel Blob). Both
// are resolvable in the browser and on the server (see fetchBlobUrl), so accept
// either. Zod's built-in .url() rejects relative paths, which broke local-dev
// media flows (e.g. ArtifactVersion.urls during Stage/snapshot).
//
// We allow only schemes a media asset can legitimately use and that are safe to
// render or fetch — http(s), blob:, data: — and reject active-content / local
// schemes (javascript:, vbscript:, file:, …) so a URL that is stored and later
// rendered (e.g. an <img>/<a> src in the library) can't smuggle script or read
// the server's filesystem. (SSRF egress filtering for fetched URLs is separate.)
const SAFE_MEDIA_URL_SCHEMES = new Set(["http:", "https:", "blob:", "data:"]);

const mediaUrl = z.string().refine(
  (value) => {
    if (value.startsWith(DEV_BLOB_URL_PREFIX)) return true;
    if (/^\/api\/demo\/media\?[^#]*$/.test(value)) return true;
    if (/^\/api\/videos\/[a-zA-Z0-9-]+\/artifacts\/(?:treatment|music-plan|music|beat-grid|anchors|shot-plan|shots|manifest)$/.test(value)) return true;
    try {
      return SAFE_MEDIA_URL_SCHEMES.has(new URL(value).protocol);
    } catch {
      return false;
    }
  },
  { message: "Invalid or unsupported media URL" },
);

const sourceBlobUrl = z.string().refine(
  (value) => value.startsWith("private-source://") || mediaUrl.safeParse(value).success,
  { message: "Invalid source blob URL" },
);

// Strict validator for UNTRUSTED, user-supplied URLs the server will fetch (e.g. library
// URL import). Requires an absolute http(s) URL — rejects relative/local paths like
// /dev-blob/ and non-fetchable schemes (file:, data:, javascript:). Use this, not mediaUrl,
// anywhere a client-provided URL crosses into a server-side fetch.
const httpUrl = z.string().refine(
  (value) => {
    try {
      const { protocol } = new URL(value);
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  },
  { message: "Must be an absolute http(s) URL" },
);

export const AspectRatio = z.enum(["9:16", "16:9", "1:1"]);
export type AspectRatio = z.infer<typeof AspectRatio>;

export const ContentType = z.enum([
  "music_video",
  "explainer",
  "news_digest",
  "product_social",
  "custom",
]);
export type ContentType = z.infer<typeof ContentType>;

export const QualityTier = z.enum(["draft", "standard", "premium"]);
export type QualityTier = z.infer<typeof QualityTier>;

export const DigestMode = z.enum(["auto", "single_topic", "roundup"]);
export type DigestMode = z.infer<typeof DigestMode>;

export const ResearchMode = z.enum(["supplied_only", "corroborate"]);
export type ResearchMode = z.infer<typeof ResearchMode>;

export const PresentationMode = z.enum(["faceless", "presenter"]);
export type PresentationMode = z.infer<typeof PresentationMode>;

export const VisualStylePreset = z.enum([
  "auto",
  "prestige_documentary",
  "broadcast_energy",
  "cinematic_social",
]);
export type VisualStylePreset = z.infer<typeof VisualStylePreset>;

export const VisualBeatKind = z.enum([
  "documentary_source",
  "document_excerpt",
  "data_visualization",
  "editorial_image",
  "cinematic_broll",
  "synthetic_reenactment",
  "composite",
]);
export type VisualBeatKind = z.infer<typeof VisualBeatKind>;

export const VisualSequencePattern = z.enum([
  "wide_evidence_detail_consequence",
  "process_cutin_mechanism_implication",
  "source_diagram_application",
  "comparison_contrast_synthesis",
  "hook_context_reveal",
]);
export type VisualSequencePattern = z.infer<typeof VisualSequencePattern>;

export const GraphicFamily = z.enum([
  "hero_number",
  "magnitude_comparison",
  "change_over_time",
  "ranking",
  "part_to_whole",
  "geographic_map",
  "timeline",
  "process_flow",
  "relationship_network",
  "source_excerpt",
]);
export type GraphicFamily = z.infer<typeof GraphicFamily>;

export const ShotSpec = z.object({
  size: z.enum(["extreme_wide", "wide", "medium", "close", "extreme_close", "over_shoulder", "insert"]),
  angle: z.enum(["eye_level", "low", "high", "overhead", "dutch", "profile"]),
  subject: z.string().trim().min(1).max(400),
  setting: z.string().trim().min(1).max(400),
  action: z.string().trim().min(1).max(400),
  composition: z.string().trim().min(1).max(400),
  focalLength: z.string().trim().min(1).max(120),
  cameraMovement: z.enum(["locked", "dolly", "track", "orbit", "crane", "handheld", "macro_drift", "push_in", "pull_out"]),
  transition: z.enum(["hard_cut", "cut_in", "cut_out", "match_cut", "source_wipe", "dissolve", "j_cut", "l_cut"]),
  narrativeFunction: z.string().trim().min(1).max(400),
  evidenceBoundary: z.enum(["evidence", "editorial_illustration", "conceptual", "reenactment"]),
});
export type ShotSpec = z.infer<typeof ShotSpec>;

export const GraphicSpec = z.object({
  family: GraphicFamily,
  title: z.string().trim().min(1).max(180),
  values: z.array(z.object({
    label: z.string().trim().min(1).max(120),
    value: z.number(),
    unit: z.string().trim().max(40).optional(),
    evidenceId: z.string().min(1),
  })).max(20).default([]),
  sourceTreatment: z.string().trim().max(400).optional(),
  overlayPlacement: z.enum(["left", "right", "top", "bottom", "center", "split"]).default("left"),
});
export type GraphicSpec = z.infer<typeof GraphicSpec>;

const GraphicValueV2 = z.object({
  label: z.string().trim().min(1).max(160),
  value: z.number(),
  unit: z.string().trim().min(1).max(40).optional(),
  baseline: z.string().trim().min(1).max(240).optional(),
  evidenceId: z.string().min(1),
});

const GraphicNodeV2 = z.object({
  id: z.string().min(1),
  label: z.string().trim().min(1).max(160),
  evidenceId: z.string().min(1),
});

export const GraphicSpecV2 = z.discriminatedUnion("family", [
  z.object({ version: z.literal(2), family: z.enum(["hero_number", "magnitude_comparison", "change_over_time", "ranking", "part_to_whole"]), title: z.string().trim().min(1).max(180), values: z.array(GraphicValueV2).min(1).max(20), overlayPlacement: z.enum(["left", "right", "top", "bottom", "center", "split"]).default("left") }),
  z.object({ version: z.literal(2), family: z.literal("geographic_map"), title: z.string().trim().min(1).max(180), entities: z.array(z.object({ name: z.string().trim().min(1).max(160), evidenceId: z.string().min(1) })).min(1).max(20), overlayPlacement: z.enum(["left", "right", "top", "bottom", "center", "split"]).default("left") }),
  z.object({ version: z.literal(2), family: z.literal("timeline"), title: z.string().trim().min(1).max(180), events: z.array(z.object({ label: z.string().trim().min(1).max(200), date: z.string().trim().min(4).max(60), evidenceId: z.string().min(1) })).min(2).max(20), overlayPlacement: z.enum(["left", "right", "top", "bottom", "center", "split"]).default("left") }),
  z.object({ version: z.literal(2), family: z.enum(["process_flow", "relationship_network"]), title: z.string().trim().min(1).max(180), nodes: z.array(GraphicNodeV2).min(2).max(20), edges: z.array(z.object({ from: z.string().min(1), to: z.string().min(1), label: z.string().trim().max(120).optional(), evidenceId: z.string().min(1) })).min(1).max(40), overlayPlacement: z.enum(["left", "right", "top", "bottom", "center", "split"]).default("left") }),
  z.object({ version: z.literal(2), family: z.literal("source_excerpt"), title: z.string().trim().min(1).max(180), fragmentId: z.string().min(1), excerptHash: z.string().min(16).max(128), excerpt: z.string().trim().min(1).max(1_000), locator: z.string().trim().min(1).max(240), overlayPlacement: z.enum(["left", "right", "top", "bottom", "center", "split"]).default("left") }),
]);
export type GraphicSpecV2 = z.infer<typeof GraphicSpecV2>;

export const MotionCue = z.object({
  kind: z.enum(["reveal", "highlight", "track", "cut_in", "comparison", "emphasis", "exit"]),
  atMs: z.number().int().nonnegative(),
  durationMs: z.number().int().positive().max(1_500),
  target: z.string().trim().min(1).max(240).optional(),
});
export type MotionCue = z.infer<typeof MotionCue>;

export const SourceVisualArtifact = z.object({
  id: z.string().min(1),
  sourceId: z.string().min(1),
  fragmentId: z.string().min(1),
  kind: z.enum(["pdf_page", "pdf_highlight_crop", "ocr_page_card", "url_excerpt_card"]),
  title: z.string().trim().min(1).max(240),
  domain: z.string().trim().min(1).max(240).optional(),
  publishedAt: z.string().optional(),
  pageNumber: z.number().int().positive().optional(),
  locator: z.string().trim().min(1).max(240),
  excerpt: z.string().trim().min(1).max(1_000),
  excerptHash: z.string().min(16).max(128),
  sourceUrl: z.string().url().optional(),
  visualUrl: z.string().optional(),
  highlight: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().positive().max(1), height: z.number().positive().max(1) }).optional(),
  extractionMethod: z.enum(["digital", "ocr", "mixed", "html", "research"]).optional(),
});
export type SourceVisualArtifact = z.infer<typeof SourceVisualArtifact>;

export const EditorialPause = z.object({
  id: z.string().min(1),
  afterSceneId: z.string().min(1).optional(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  durationMs: z.number().int().positive().max(30_000),
  kind: z.enum(["transition", "chapter", "ending", "reading"]),
  reason: z.string().trim().min(1).max(300),
  approved: z.boolean().default(false),
}).refine((pause) => pause.endMs > pause.startMs && pause.endMs - pause.startMs === pause.durationMs && (["ending", "reading"].includes(pause.kind) || pause.durationMs <= 1_500), "Editorial pause timestamps must match durationMs and the pause policy");
export type EditorialPause = z.infer<typeof EditorialPause>;

export const NarrationCoverageReport = z.object({
  version: z.literal(1),
  targetDurationMs: z.number().int().positive(),
  spokenDurationMs: z.number().int().nonnegative(),
  // Failed timing reports must retain overruns above 100%.
  spokenCoverage: z.number().nonnegative(),
  longestUnapprovedGapMs: z.number().int().nonnegative(),
  passed: z.boolean(),
  findings: z.array(z.object({ code: z.string().min(1), severity: z.enum(["review", "blocking"]), message: z.string().min(1), sceneId: z.string().optional(), startMs: z.number().int().nonnegative().optional(), endMs: z.number().int().positive().optional() })).default([]),
});
export type NarrationCoverageReport = z.infer<typeof NarrationCoverageReport>;

export const MotionEnergyReport = z.object({
  version: z.literal(1),
  passed: z.boolean(),
  maximumUnchangedFullScreenMs: z.number().int().nonnegative(),
  maximumInformationStasisMs: z.number().int().nonnegative(),
  lowEntropyIntervals: z.array(z.object({ startMs: z.number().int().nonnegative(), endMs: z.number().int().positive(), beatId: z.string().optional() })).default([]),
  findings: z.array(z.object({ code: z.string().min(1), severity: z.enum(["review", "blocking"]), message: z.string().min(1), beatIds: z.array(z.string()).default([]) })).default([]),
});
export type MotionEnergyReport = z.infer<typeof MotionEnergyReport>;

export const SourceVisualReport = z.object({
  version: z.literal(1),
  passed: z.boolean(),
  authenticArtifactCount: z.number().int().nonnegative(),
  invalidExcerptBeatIds: z.array(z.string()).default([]),
  unsupportedGraphicBeatIds: z.array(z.string()).default([]),
  findings: z.array(z.object({ code: z.string().min(1), severity: z.enum(["review", "blocking"]), message: z.string().min(1), beatIds: z.array(z.string()).default([]) })).default([]),
});
export type SourceVisualReport = z.infer<typeof SourceVisualReport>;

export const EditorialTimingPlan = z.object({
  version: z.union([z.literal(2), z.literal(3)]),
  productionId: z.string().uuid(),
  scriptVersionId: z.string().optional(),
  targetDurationMs: z.number().int().positive(),
  scenes: z.array(z.object({ sceneId: z.string().min(1), startMs: z.number().int().nonnegative(), speechStartMs: z.number().int().nonnegative(), speechEndMs: z.number().int().positive(), endMs: z.number().int().positive(), measuredNarrationMs: z.number().int().positive(), retimeRate: z.number().min(MIN_EDITORIAL_NARRATION_RATE).max(MAX_EDITORIAL_NARRATION_RATE), pauseAfterId: z.string().optional() })).min(1),
  pauses: z.array(EditorialPause).default([]),
  coverage: NarrationCoverageReport,
  compiledAt: z.string(),
});
export type EditorialTimingPlan = z.infer<typeof EditorialTimingPlan>;

export const AssetReusePolicy = z.object({
  mode: z.enum(["unique", "motif_callback"]).default("unique"),
  callbackId: z.string().min(1).optional(),
  approved: z.boolean().default(false),
  minimumSeparationMs: z.number().int().nonnegative().default(30_000),
});
export type AssetReusePolicy = z.infer<typeof AssetReusePolicy>;

export const VisualFingerprint = z.object({
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  perceptualHashes: z.array(z.string().min(1)).max(3).default([]),
  motionSignature: z.array(z.number()).max(32).default([]),
  sampledAt: z.array(z.number().min(0).max(1)).max(3).default([]),
});
export type VisualFingerprint = z.infer<typeof VisualFingerprint>;

export const VisualQualityReport = z.object({
  version: z.literal(1),
  passed: z.boolean(),
  state: z.enum(["pending", "running", "passed", "needs_review", "failed"]),
  uniqueAssetRatio: z.number().min(0).max(1),
  cinematicCoverage: z.number().min(0).max(1),
  retainedBeatIds: z.array(z.string()).default([]),
  rejectedBeatIds: z.array(z.string()).default([]),
  duplicateGroups: z.array(z.array(z.string().min(1)).min(2)).default([]),
  graphicFamilyMix: z.record(z.string(), z.number().int().nonnegative()).default({}),
  semanticScore: z.number().min(0).max(1).optional(),
  autoPolishAttempts: z.number().int().nonnegative().default(0),
  findings: z.array(z.object({
    code: z.string().min(1),
    severity: z.enum(["info", "review", "blocking"]),
    message: z.string().min(1),
    beatIds: z.array(z.string()).default([]),
  })).default([]),
  narrationCoverage: NarrationCoverageReport.optional(),
  motionEnergy: MotionEnergyReport.optional(),
  sourceVisuals: SourceVisualReport.optional(),
  checkedAt: z.string(),
});
export type VisualQualityReport = z.infer<typeof VisualQualityReport>;

export const DisclosurePolicy = z.object({
  required: z.boolean().default(false),
  label: z.string().trim().min(1).max(120).optional(),
  persistent: z.boolean().default(false),
  reason: z.string().trim().max(500).optional(),
  publicFigures: z.array(z.string().trim().min(1).max(120)).max(12).default([]),
  currentEvent: z.boolean().default(false),
});
export type DisclosurePolicy = z.infer<typeof DisclosurePolicy>;

export const VisualBeatAsset = z.object({
  beatId: z.string().min(1),
  generationId: z.string().uuid().optional(),
  assetId: z.string().uuid().optional(),
  kind: z.enum(["image", "video", "source", "graphic"]),
  url: mediaUrl.optional(),
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  status: z.enum(["planned", "queued", "running", "ready", "failed"]).default("planned"),
  costCents: z.number().int().nonnegative().default(0),
  error: z.string().max(1_000).optional(),
  probe: z.lazy(() => MediaProbeMetadata).optional(),
  provenance: z.lazy(() => AssetProvenance).optional(),
  immutableStorageKey: z.string().min(1).optional(),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  fingerprint: VisualFingerprint.optional(),
  semanticScore: z.number().min(0).max(1).optional(),
  noveltyScore: z.number().min(0).max(1).optional(),
  recoveryOfGenerationId: z.string().uuid().optional(),
  recoveryReason: z.string().max(500).optional(),
});
export type VisualBeatAsset = z.infer<typeof VisualBeatAsset>;

export const VisualBeat = z.object({
  id: z.string().min(1),
  sceneId: z.string().min(1),
  index: z.number().int().nonnegative(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  kind: VisualBeatKind,
  intent: z.string().trim().min(1).max(1_000),
  evidenceIds: z.array(z.string().min(1)).max(24).default([]),
  sourceIds: z.array(z.string().min(1)).max(24).default([]),
  generationPrompt: z.string().trim().min(1).max(2_000).optional(),
  motionDirection: z.string().trim().min(1).max(500),
  providerRoute: z.object({
    image: z.string().min(1).optional(),
    video: z.string().min(1).optional(),
    resolution: z.enum(["720p", "1080p"]).optional(),
    tier: z.enum(["fast", "standard"]).optional(),
    fallback: z.enum(["retry_same", "approved_equivalent", "review_required"]).default("review_required"),
  }),
  disclosure: DisclosurePolicy,
  costEstimateCents: z.number().int().nonnegative().default(0),
  locked: z.boolean().default(false),
  hold: z.boolean().default(false),
  assets: z.array(VisualBeatAsset).max(8).default([]),
  chapterId: z.string().min(1).optional(),
  sequencePattern: VisualSequencePattern.optional(),
  shotSpec: ShotSpec.optional(),
  graphicSpec: z.union([GraphicSpec, GraphicSpecV2]).optional(),
  sourceVisual: SourceVisualArtifact.optional(),
  motionCues: z.array(MotionCue).max(12).default([]),
  fullScreen: z.boolean().default(false),
  reusePolicy: AssetReusePolicy.default({ mode: "unique", approved: false, minimumSeparationMs: 30_000 }),
}).refine((beat) => beat.endMs > beat.startMs, "Visual beat endMs must be after startMs");
export type VisualBeat = z.infer<typeof VisualBeat>;

export const HybridVisualPlanV2 = z.object({
  version: z.union([z.literal(2), z.literal(3), z.literal(4)]),
  productionId: z.string().uuid(),
  contentType: z.enum(["news_digest", "explainer"]),
  requestedPreset: VisualStylePreset,
  resolvedPreset: VisualStylePreset.exclude(["auto"]),
  qualityTier: QualityTier,
  continuityKit: z.object({
    palette: z.array(z.string().min(1).max(40)).min(3).max(8),
    lighting: z.string().min(1).max(300),
    lensLanguage: z.string().min(1).max(300),
    texture: z.string().min(1).max(300),
    motifs: z.array(z.string().min(1).max(160)).min(1).max(8),
    transitionLanguage: z.string().min(1).max(300),
    graphicLanguage: z.string().min(1).max(300),
  }),
  beats: z.array(VisualBeat).min(1).max(400),
  metrics: z.object({
    cinematicCoverage: z.number().min(0).max(1),
    staticCoverage: z.number().min(0).max(1),
    cinematicBeatCount: z.number().int().nonnegative(),
    evidenceBeatCount: z.number().int().nonnegative(),
    estimatedCostCents: z.number().int().nonnegative(),
    predictedNarrationDurationMs: z.number().int().positive(),
    targetDurationMs: z.number().int().positive(),
  }),
  createdAt: z.string(),
  chapters: z.array(z.object({
    id: z.string().min(1),
    title: z.string().min(1).max(180),
    sceneIds: z.array(z.string().min(1)).min(1),
    sequencePattern: VisualSequencePattern,
  })).default([]),
  noveltyLedger: z.object({
    subjects: z.record(z.string(), z.number().int().nonnegative()).default({}),
    settings: z.record(z.string(), z.number().int().nonnegative()).default({}),
    shotSizes: z.record(z.string(), z.number().int().nonnegative()).default({}),
    cameraMoves: z.record(z.string(), z.number().int().nonnegative()).default({}),
    graphicFamilies: z.record(z.string(), z.number().int().nonnegative()).default({}),
    transitions: z.record(z.string(), z.number().int().nonnegative()).default({}),
  }).optional(),
  qualityReport: VisualQualityReport.optional(),
  timingPlan: EditorialTimingPlan.optional(),
  narrationWordsPerSecond: z.number().positive().optional(),
});
export type HybridVisualPlanV2 = z.infer<typeof HybridVisualPlanV2>;
export type HybridVisualPlanV3 = HybridVisualPlanV2 & { version: 3 };
export type HybridVisualPlanV4 = HybridVisualPlanV2 & { version: 4 };

export const SourceEvidence = z.object({
  sourceId: z.string().min(1),
  fragmentId: z.string().uuid().optional(),
  pageNumber: z.number().int().positive().optional(),
  section: z.string().trim().max(240).optional(),
  sourceUrl: httpUrl.optional(),
  excerpt: z.string().trim().min(1).max(1_000),
  excerptHash: z.string().min(16).max(128),
  extractionMethod: z.enum(["digital", "ocr", "mixed", "html", "plain_text", "research"]).optional(),
});
export type SourceEvidence = z.infer<typeof SourceEvidence>;

export const SourceInput = z.discriminatedUnion("kind", [
  z.object({
    id: z.string().min(1),
    kind: z.literal("text"),
    sourceRecordId: z.string().uuid().optional(),
    title: z.string().trim().max(200).optional(),
    text: z.string().trim().min(1).max(200_000),
    suppliedAt: z.string().optional(),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal("url"),
    sourceRecordId: z.string().uuid().optional(),
    title: z.string().trim().max(200).optional(),
    url: httpUrl,
    canonicalUrl: httpUrl.optional(),
    extractedText: z.string().max(200_000).optional(),
    publishedAt: z.string().optional(),
    retrievedAt: z.string().optional(),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal("document"),
    sourceRecordId: z.string().uuid().optional(),
    title: z.string().trim().max(200),
    assetId: z.string().uuid(),
    mimeType: z.string().min(3),
    pageCount: z.number().int().positive().max(250).optional(),
    extractedText: z.string().max(200_000).optional(),
    suppliedAt: z.string().optional(),
  }),
]);
export type SourceInput = z.infer<typeof SourceInput>;

export const SourceClaim = z.object({
  id: z.string().min(1),
  text: z.string().trim().min(1).max(2_000),
  sourceIds: z.array(z.string().min(1)).default([]),
  asOf: z.string().optional(),
  confidence: z.number().min(0).max(1).default(0),
  status: z.enum(["unverified", "supported", "contested", "rejected"]).default("unverified"),
  evidence: z.array(z.string().trim().min(1).max(1_000)).default([]),
  evidenceRefs: z.array(SourceEvidence).default([]),
  independenceGroup: z.string().trim().max(200).optional(),
  editorialStatus: z.enum(["draft", "approved", "excluded"]).default("draft"),
  breaking: z.boolean().default(false),
});
export type SourceClaim = z.infer<typeof SourceClaim>;

export const SourceBundle = z.object({
  inputs: z.array(SourceInput).max(100).default([]),
  claims: z.array(SourceClaim).max(1_000).default([]),
  researchedAt: z.string().optional(),
  asOf: z.string().optional(),
});
export type SourceBundle = z.infer<typeof SourceBundle>;

export const ProductionSource = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  productionId: z.string().uuid().optional(),
  userId: z.string().min(1),
  kind: z.enum(["text", "url", "document", "research"]),
  title: z.string().trim().min(1).max(200),
  originalName: z.string().trim().max(240).optional(),
  url: httpUrl.optional(),
  canonicalUrl: httpUrl.optional(),
  blobUrl: sourceBlobUrl.optional(),
  mimeType: z.string().min(3).optional(),
  byteSize: z.number().int().nonnegative().optional(),
  sha256: z.string().length(64).optional(),
  pageCount: z.number().int().positive().max(250).optional(),
  publishedAt: z.string().optional(),
  retrievedAt: z.string().optional(),
  suppliedAt: z.string(),
  rights: z.enum(["user_authorized", "evidence_only", "licensed", "official", "public_domain"]),
  processingState: z.enum(["pending", "processing", "ready", "warning", "failed"]).default("pending"),
  extractionVersion: z.string().default("source-v1"),
  warnings: z.array(z.string().max(500)).default([]),
  error: z.string().max(1_000).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProductionSource = z.infer<typeof ProductionSource>;

export const SourceFragment = z.object({
  id: z.string().uuid(),
  sourceId: z.string().uuid(),
  ordinal: z.number().int().nonnegative(),
  pageNumber: z.number().int().positive().max(250).optional(),
  section: z.string().trim().max(240).optional(),
  text: z.string().trim().min(1).max(200_000),
  textHash: z.string().length(64),
  extractionMethod: z.enum(["digital", "ocr", "mixed", "html", "plain_text", "research"]),
  createdAt: z.string(),
});
export type SourceFragment = z.infer<typeof SourceFragment>;

export const EditorialScene = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  narration: z.string().trim().min(1).max(5_000),
  visual: z.string().trim().min(1).max(1_000),
  claimIds: z.array(z.string().min(1)).default([]),
  sourceIds: z.array(z.string().min(1)).default([]),
});
export type EditorialScene = z.infer<typeof EditorialScene>;

export const EditorialPlan = z.object({
  version: z.literal(1),
  digestMode: DigestMode,
  title: z.string().trim().min(1).max(240),
  dek: z.string().trim().max(500).optional(),
  scenes: z.array(EditorialScene).min(1).max(40),
  createdAt: z.string(),
});
export type EditorialPlan = z.infer<typeof EditorialPlan>;

export const StoryboardScene = EditorialScene.extend({
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  visualKind: z.enum(["graphic", "document", "image", "video", "presenter"]),
  sourceVisualId: z.string().optional(),
  syntheticLabelRequired: z.boolean().default(false),
  citationLabels: z.array(z.string().min(1).max(160)).default([]),
  beats: z.array(VisualBeat).max(400).default([]),
});
export type StoryboardScene = z.infer<typeof StoryboardScene>;

export const NewsStoryboard = z.object({
  version: z.literal(1),
  scenes: z.array(StoryboardScene).min(1).max(40),
  createdAt: z.string(),
});
export type NewsStoryboard = z.infer<typeof NewsStoryboard>;

export const ProductionApproval = z.object({
  gate: z.enum(["script", "storyboard"]),
  artifactVersionId: z.string().uuid(),
  approvedBy: z.string().min(1),
  approvedAt: z.string(),
});
export type ProductionApproval = z.infer<typeof ProductionApproval>;

export const AssetProvenance = z.object({
  origin: z.enum(["user_upload", "licensed", "official", "public_domain", "creative_commons", "generated"]),
  creator: z.string().trim().max(200).optional(),
  sourceUrl: httpUrl.optional(),
  license: z.string().trim().max(300).optional(),
  permittedUse: z.string().trim().max(500),
  acquiredAt: z.string(),
  transformations: z.array(z.string().trim().min(1).max(200)).default([]),
  c2paManifestUrl: httpUrl.optional(),
  c2paValidated: z.boolean().default(false),
});
export type AssetProvenance = z.infer<typeof AssetProvenance>;

export const MediaProbeMetadata = z.object({
  durationSeconds: z.number().positive(),
  startTimeSeconds: z.number().default(0),
  frameRate: z.number().positive().optional(),
  frameCount: z.number().int().nonnegative().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  videoCodec: z.string().optional(),
  audioCodec: z.string().optional(),
  hasAudio: z.boolean().default(false),
  audioTrackCount: z.number().int().nonnegative().default(0),
  videoStartTimeSeconds: z.number().optional(),
  audioStartTimeSeconds: z.number().optional(),
  avStartOffsetMs: z.number().optional(),
  colorSpace: z.string().optional(),
  colorTransfer: z.string().optional(),
  colorPrimaries: z.string().optional(),
  probedAt: z.string(),
});
export type MediaProbeMetadata = z.infer<typeof MediaProbeMetadata>;

export const TimelineTransition = z.object({
  type: z.enum(["cut", "crossfade", "dip_to_color", "graphic_match"]).default("cut"),
  durationMs: z.number().int().min(0).max(2_000).default(0),
});
export type TimelineTransition = z.infer<typeof TimelineTransition>;

export const TimelineSegment = z.object({
  id: z.string().min(1),
  trackId: z.string().min(1),
  kind: z.enum(["video", "image", "graphic", "caption", "narration", "music", "sfx"]),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  sourceUrl: mediaUrl.optional(),
  sourceInMs: z.number().int().nonnegative().default(0),
  sourceOutMs: z.number().int().positive().optional(),
  requestedDurationMs: z.number().int().positive().optional(),
  actualDurationMs: z.number().int().positive().optional(),
  usableInMs: z.number().int().nonnegative().default(0),
  usableOutMs: z.number().int().positive().optional(),
  handleInMs: z.number().int().nonnegative().optional(),
  handleOutMs: z.number().int().nonnegative().optional(),
  hold: z.boolean().default(false),
  transitionIn: TimelineTransition.optional(),
  transitionOut: TimelineTransition.optional(),
  provenance: AssetProvenance.optional(),
  probe: MediaProbeMetadata.optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
}).refine((segment) => segment.endMs > segment.startMs, {
  message: "Timeline segment endMs must be greater than startMs",
});
export type TimelineSegment = z.infer<typeof TimelineSegment>;

export const TimelineTrack = z.object({
  id: z.string().min(1),
  kind: z.enum(["video", "graphics", "captions", "narration", "music", "sfx"]),
  segments: z.array(TimelineSegment).default([]),
});
export type TimelineTrack = z.infer<typeof TimelineTrack>;

export const TimelineManifestV2 = z.object({
  version: z.literal(2),
  productionId: z.string().uuid(),
  contentType: ContentType,
  durationMs: z.number().int().positive(),
  fps: z.number().int().min(24).max(60).default(30),
  aspectRatio: AspectRatio,
  tracks: z.array(TimelineTrack).min(1),
  metadata: z.object({
    durationMode: z.enum(["auto", "target", "fixed"]).optional(),
    endingHoldMs: z.number().int().nonnegative().optional(),
    measuredSpeechBounds: z.array(z.object({ sceneId: z.string().min(1), startMs: z.number().int().nonnegative(), endMs: z.number().int().positive() })).default([]),
    pauseIds: z.array(z.string().min(1)).default([]),
    sourceFragmentIds: z.array(z.string().min(1)).default([]),
    excerptHashes: z.array(z.string().min(16)).default([]),
    graphicPayloads: z.record(z.string(), z.unknown()).default({}),
    motionCues: z.record(z.string(), z.array(MotionCue)).default({}),
  }).optional(),
  compiledAt: z.string(),
});
export type TimelineManifestV2 = z.infer<typeof TimelineManifestV2>;

export const QAFinding = z.object({
  id: z.string().min(1),
  category: z.enum(["structural", "audiovisual", "semantic", "factual", "accessibility", "policy", "cost", "provenance"]),
  severity: z.enum(["info", "warning", "error"]),
  code: z.string().min(1),
  message: z.string().min(1),
  segmentId: z.string().optional(),
  startMs: z.number().int().nonnegative().optional(),
  endMs: z.number().int().positive().optional(),
  retryable: z.boolean().default(false),
});
export type QAFinding = z.infer<typeof QAFinding>;

export const QAReport = z.object({
  version: z.literal(1),
  productionId: z.string().uuid(),
  passed: z.boolean(),
  findings: z.array(QAFinding).default([]),
  metrics: z.record(z.string(), z.number()).default({}),
  checkedAt: z.string(),
});
export type QAReport = z.infer<typeof QAReport>;

export const ProviderCapability = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  mediaKind: z.enum(["text", "image", "video", "music", "speech", "research"]),
  inputModes: z.array(z.string().min(1)).default([]),
  maxDurationSeconds: z.number().positive().optional(),
  resolutions: z.array(z.string().min(1)).default([]),
  maxReferences: z.number().int().nonnegative().optional(),
  nativeAudio: z.boolean().default(false),
  canExtend: z.boolean().default(false),
  versionStatus: z.enum(["stable", "preview", "deprecated"]).default("stable"),
  qualityScore: z.number().min(0).max(1).default(0.5),
  reliabilityScore: z.number().min(0).max(1).default(0.5),
  estimatedCostPerUnitUsd: z.number().nonnegative(),
  estimatedLatencySeconds: z.number().nonnegative(),
});
export type ProviderCapability = z.infer<typeof ProviderCapability>;

export const WorkflowStep = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  state: z.enum(["pending", "running", "awaiting_user", "complete", "failed", "cancelled"]),
  dependsOn: z.array(z.string().min(1)).default([]),
  artifactVersionId: z.string().uuid().optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  error: z.string().optional(),
});
export type WorkflowStep = z.infer<typeof WorkflowStep>;

export const ProductionRunState = z.enum([
  "queued",
  "active",
  "awaiting_user",
  "complete",
  "failed",
  "cancelled",
]);
export type ProductionRunState = z.infer<typeof ProductionRunState>;

export const ProductionWorkflowRun = z.object({
  id: z.string().uuid(),
  productionId: z.string().uuid(),
  runId: z.string().min(1),
  kind: z.enum(["main", "recovery", "beat_recovery"]),
  workflowVersion: z.string().min(1),
  state: ProductionRunState,
  recoveryToken: z.string().optional(),
  errorCode: z.string().optional(),
  error: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  startedAt: z.string(),
  heartbeatAt: z.string(),
  completedAt: z.string().optional(),
});
export type ProductionWorkflowRun = z.infer<typeof ProductionWorkflowRun>;

export const WorkUnitProgress = z.object({
  id: z.string().min(1),
  stageId: z.string().min(1),
  label: z.string().min(1),
  kind: z.string().min(1),
  state: z.enum(["not_started", "queued", "running", "ready", "needs_attention", "failed"]),
  provider: z.string().optional(),
  model: z.string().optional(),
  requestId: z.string().optional(),
  attempt: z.number().int().positive().default(1),
  errorCode: z.string().optional(),
  error: z.string().optional(),
  assetUrl: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type WorkUnitProgress = z.infer<typeof WorkUnitProgress>;

export const ProductionStageProgress = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  state: z.enum(["not_started", "running", "awaiting_user", "complete", "needs_attention", "failed"]),
  detail: z.string().optional(),
  total: z.number().int().nonnegative().default(0),
  ready: z.number().int().nonnegative().default(0),
  queued: z.number().int().nonnegative().default(0),
  running: z.number().int().nonnegative().default(0),
  failed: z.number().int().nonnegative().default(0),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
});
export type ProductionStageProgress = z.infer<typeof ProductionStageProgress>;

export const ProductionProgressSnapshot = z.object({
  productionId: z.string().uuid(),
  workflowVersion: z.string().min(1),
  state: z.enum(["queued", "active", "awaiting_user", "needs_attention", "possibly_stalled", "failed", "complete", "cancelled"]),
  activeStageId: z.string().optional(),
  activeStageLabel: z.string().optional(),
  activeDetail: z.string().optional(),
  lastActivityAt: z.string(),
  staleAfterSeconds: z.number().int().positive(),
  stages: z.array(ProductionStageProgress),
  units: z.array(WorkUnitProgress),
  costs: z.object({
    estimatedBaseCents: z.number().int().nonnegative(),
    recoveryReserveCents: z.number().int().nonnegative(),
    maximumAuthorizedCents: z.number().int().nonnegative(),
    committedCents: z.number().int().nonnegative().optional(),
    remainingAuthorizedCents: z.number().int().nonnegative().optional(),
    actualCents: z.number().int().nonnegative(),
    recoverySpentCents: z.number().int().nonnegative(),
    remainingRecoveryCents: z.number().int().nonnegative(),
  }),
  recoverable: z.boolean(),
  nextAction: z.enum(["none", "wait", "approve_script", "approve_storyboard", "resume_safe_recovery", "retry_failed_units", "review_failure"]),
  artifactVersionCount: z.number().int().nonnegative(),
  visualQuality: z.object({
    state: z.enum(["not_started", "running", "passed", "needs_review", "failed"]),
    retainedAssetCount: z.number().int().nonnegative(),
    rejectedAssetCount: z.number().int().nonnegative(),
    rejectedBeatIds: z.array(z.string()).default([]),
    autoPolishAttempts: z.number().int().nonnegative(),
    uniqueAssetRatio: z.number().min(0).max(1).optional(),
    cinematicCoverage: z.number().min(0).max(1).optional(),
    semanticScore: z.number().min(0).max(1).optional(),
    spokenCoverage: z.number().min(0).max(1).optional(),
    longestUnapprovedGapMs: z.number().int().nonnegative().optional(),
    maximumInformationStasisMs: z.number().int().nonnegative().optional(),
    authenticSourceVisualCount: z.number().int().nonnegative().optional(),
    unsupportedGraphicCount: z.number().int().nonnegative().optional(),
    duplicateGroupCount: z.number().int().nonnegative(),
    findings: z.array(z.object({
      code: z.string().min(1),
      severity: z.enum(["info", "review", "blocking"]),
      message: z.string().min(1),
      beatIds: z.array(z.string()).default([]),
    })).default([]),
    nextAction: z.enum(["wait", "auto_polish", "review_flagged_beats", "continue"]),
  }).optional(),
  updatedAt: z.string(),
});
export type ProductionProgressSnapshot = z.infer<typeof ProductionProgressSnapshot>;

export const ProductionRecoveryRequest = z.object({
  action: z.enum(["resume", "safe_retry", "retry_failed_beats", "salvage_visuals", "rebuild_visuals"]),
  beatIds: z.array(z.string().min(1)).max(40).default([]),
  confirmSpend: z.boolean().default(false),
});
export type ProductionRecoveryRequest = z.infer<typeof ProductionRecoveryRequest>;

export const BrandKit = z.object({
  name: z.string().trim().max(120).optional(),
  colors: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
  fonts: z.array(z.string().trim().min(1).max(120)).max(6).default([]),
  logoAssetIds: z.array(z.string().uuid()).max(6).default([]),
});
export type BrandKit = z.infer<typeof BrandKit>;

export const DurationMode = z.enum(["auto", "target", "fixed"]);
export type DurationMode = z.infer<typeof DurationMode>;
export const EditorialCoveragePoint = z.object({
  claimId: z.string(),
  sourceIds: z.array(z.string()),
  text: z.string(),
  role: z.enum(["core", "mechanism", "evidence", "limitation", "detail"]),
  priority: z.enum(["essential", "supporting"]),
  included: z.boolean(),
  reason: z.string(),
});
export const EditorialDurationPlan = z.object({
  version: z.literal(1),
  mode: DurationMode,
  voiceId: z.string().optional(),
  excludedClaimIds: z.array(z.string()).optional(),
  requestedTargetSeconds: z.number().int().min(15).max(600).optional(),
  tolerance: z.number().min(0).max(0.5).default(0.2),
  estimatedDurationSeconds: z.number().int().positive(),
  resolvedDurationSeconds: z.number().int().positive().optional(),
  approvedDurationSeconds: z.number().int().positive().optional(),
  approvedCostCents: z.number().int().nonnegative().optional(),
  needsReview: z.boolean(),
  scopeTooLong: z.boolean(),
  rationale: z.string(),
  coverage: z.array(EditorialCoveragePoint),
  closingTakeaway: z.string(),
  updatedAt: z.string(),
});
export type EditorialDurationPlan = z.infer<typeof EditorialDurationPlan>;

export const ProductionCreateRequest = z.object({
  contentType: ContentType.default("music_video"),
  projectId: z.string().uuid().optional(),
  brief: z.string().trim().min(12).max(20_000),
  sourceBundle: SourceBundle.default({ inputs: [], claims: [] }),
  sourceRecordIds: z.array(z.string().uuid()).max(25).default([]),
  digestMode: DigestMode.default("auto"),
  researchMode: ResearchMode.default("supplied_only"),
  presentationMode: PresentationMode.default("faceless"),
  visualStylePreset: VisualStylePreset.default("auto"),
  targetDurationSeconds: z.number().int().min(15).max(600).default(90),
  // Omitted policy is deliberately legacy fixed, including restored API clients.
  durationMode: DurationMode.default("fixed"),
  excludedClaimIds: z.array(z.string().min(1)).max(500).default([]),
  briefDurationHintSeconds: z.number().int().min(15).max(600).optional(),
  aspectRatio: AspectRatio.default("16:9"),
  language: z.string().trim().min(2).max(20).default("en"),
  voiceId: z.string().trim().max(120).optional(),
  qualityTier: QualityTier.default("standard"),
  brandKit: BrandKit.default({ colors: [], fonts: [], logoAssetIds: [] }),
  autopilot: z.boolean().default(false),
});
export type ProductionCreateRequest = z.infer<typeof ProductionCreateRequest>;

export const VisualMode = z.enum(["conceptual", "visible_performer"]);
export type VisualMode = z.infer<typeof VisualMode>;

export const VoiceFamily = z.enum(["female", "male", "mixed", "instrumental"]);
export type VoiceFamily = z.infer<typeof VoiceFamily>;

// Optional, user-facing music controls from the Advanced music panel. Every field is
// "auto"/undefined by default so an omitted MusicControls leaves inference untouched —
// these only OVERRIDE genre/voice/tempo/intensity when the user explicitly sets them.
export const MusicVocalControl = z.enum(["auto", "instrumental", "male", "female", "mixed", "choir"]);
export type MusicVocalControl = z.infer<typeof MusicVocalControl>;

export const MusicTempoControl = z.enum(["auto", "slow", "mid", "fast"]);
export type MusicTempoControl = z.infer<typeof MusicTempoControl>;

export const MusicIntensityControl = z.enum(["auto", "low", "medium", "high"]);
export type MusicIntensityControl = z.infer<typeof MusicIntensityControl>;

export const MusicControls = z.object({
  genre: z.string().trim().max(60).optional(), // a GENRE_PRESETS id, or omitted for free-text/auto
  vocals: MusicVocalControl.default("auto"),
  tempo: MusicTempoControl.default("auto"),
  bpm: z.number().int().min(60).max(180).optional(), // explicit BPM supersedes tempo when set
  intensity: MusicIntensityControl.default("auto"),
});
export type MusicControls = z.infer<typeof MusicControls>;

export const AnchorRole = z.enum(["character", "style", "environment", "palette", "title"]);
export type AnchorRole = z.infer<typeof AnchorRole>;

// ── Reference-image seeds ("put yourself in the video") ──────────────────────
// A user can seed an anchor with uploaded image(s): a CHARACTER subject (a stylized
// "you" rendered across the video) and/or AESTHETIC references that drive the look.
// The image bytes live in Blob/library; here we carry durable URLs + provenance.
export const ConsentRecord = z.object({
  affirmed: z.literal(true), // must be true to persist a character subject
  statement: z.string().min(8).max(400), // exact checkbox text shown to the user
  affirmedAt: z.string(), // ISO; server-filled
  version: z.string().default("v1"),
});
export type ConsentRecord = z.infer<typeof ConsentRecord>;

export const SeedReferenceImage = z.object({
  url: mediaUrl,
  libraryAssetId: z.string().uuid().optional(),
  mimeType: z.string().min(3),
});
export type SeedReferenceImage = z.infer<typeof SeedReferenceImage>;

// A "character" the performer wants on screen. Modeled as an array on the job so a
// future cast/band is additive; only a single "you" subject is built for now.
export const VideoSeedSubject = z.object({
  id: z.string().min(1).default("you-1"),
  label: z.string().trim().min(1).max(80).default("YOU"),
  role: z.literal("character").default("character"),
  images: z.array(SeedReferenceImage).min(1).max(5),
  consent: ConsentRecord,
});
export type VideoSeedSubject = z.infer<typeof VideoSeedSubject>;

export const VideoSeedAesthetic = z.object({
  role: z.enum(["style", "environment", "palette"]),
  image: SeedReferenceImage,
});
export type VideoSeedAesthetic = z.infer<typeof VideoSeedAesthetic>;

export const VideoSeeds = z.object({
  subjects: z.array(VideoSeedSubject).max(1).default([]), // bump max for a cast later
  aesthetic: z.array(VideoSeedAesthetic).max(3).default([]),
});
export type VideoSeeds = z.infer<typeof VideoSeeds>;

export const JobState = z.enum([
  "pending",
  "running",
  "awaiting_user",
  "complete",
  "failed",
  "cancelled",
]);
export type JobState = z.infer<typeof JobState>;

export const PhaseNumber = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
  z.literal(7),
  z.literal(8),
  z.literal(9),
]);
export type PhaseNumber = z.infer<typeof PhaseNumber>;

export const EditorScope = z.enum(["preview", "treatment", "music", "anchors", "shots", "script", "storyboard", "recovery", "render_candidate", "render", "phase"]);
export type EditorScope = z.infer<typeof EditorScope>;

export const RegenerateStrategy = z.enum(["edit_current", "regenerate_replacement", "extend_continue"]);
export type RegenerateStrategy = z.infer<typeof RegenerateStrategy>;

export const OpenAiImageSize = z.enum([
  "auto",
  "1024x1024",
  "1024x1536",
  "1536x1024",
  "2048x2048",
  "2048x1152",
  "3840x2160",
  "2160x3840",
]);
export type OpenAiImageSize = z.infer<typeof OpenAiImageSize>;

export const OpenAiImageQuality = z.enum(["auto", "low", "medium", "high"]);
export type OpenAiImageQuality = z.infer<typeof OpenAiImageQuality>;

export const OpenAiImageOutputFormat = z.enum(["png", "jpeg", "webp"]);
export type OpenAiImageOutputFormat = z.infer<typeof OpenAiImageOutputFormat>;

export const SeedanceAspectRatio = z.enum(["auto", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]);
export type SeedanceAspectRatio = z.infer<typeof SeedanceAspectRatio>;

export const ElevenLabsMusicOutputFormat = z.enum([
  "mp3_22050_32",
  "mp3_24000_48",
  "mp3_44100_128",
  "mp3_44100_192",
]);
export type ElevenLabsMusicOutputFormat = z.infer<typeof ElevenLabsMusicOutputFormat>;

export const AnchorProviderControls = z.object({
  model: z.literal("gpt-image-2").optional(),
  size: OpenAiImageSize.optional(),
  quality: OpenAiImageQuality.optional(),
  outputFormat: OpenAiImageOutputFormat.optional(),
  variantCount: z.number().int().min(1).max(4).optional(),
});
export type AnchorProviderControls = z.infer<typeof AnchorProviderControls>;

export const ShotProviderControls = z.object({
  seedanceMode: z.enum(["text-to-video", "image-to-video", "reference-to-video"]).optional(),
  seedanceTier: z.enum(["standard", "fast"]).optional(),
  durationSeconds: z.number().int().min(4).max(15).optional(),
  aspectRatio: SeedanceAspectRatio.optional(),
  resolution: z.enum(["480p", "720p", "1080p"]).optional(),
  seedMode: z.enum(["lock", "randomize"]).optional(),
  seed: z.number().int().optional(),
  referenceImageLimit: z.number().int().min(1).max(9).optional(),
  audioReferenceUrl: mediaUrl.optional(),
  generateAudio: z.boolean().optional(),
});
export type ShotProviderControls = z.infer<typeof ShotProviderControls>;

export const MusicSectionProviderControls = z.object({
  id: z.string().min(1),
  durationSeconds: z.number().int().min(4).max(120).optional(),
  localStyle: z.string().trim().max(220).optional(),
  negativeStyle: z.string().trim().max(220).optional(),
});
export type MusicSectionProviderControls = z.infer<typeof MusicSectionProviderControls>;

export const MusicProviderControls = z.object({
  outputFormat: ElevenLabsMusicOutputFormat.optional(),
  seed: z.number().int().optional(),
  durationSeconds: z.number().int().min(12).max(120).optional(),
  respectSectionDurations: z.boolean().optional(),
  withTimestamps: z.boolean().optional(),
  storeForInpainting: z.boolean().optional(),
  requestStems: z.boolean().optional(),
  globalStyle: z.string().trim().max(220).optional(),
  negativeStyle: z.string().trim().max(220).optional(),
  sectionEdits: z.array(MusicSectionProviderControls).max(16).optional(),
  // Creative genre/vocals/tempo/intensity from the Music Studio console; routes standalone music
  // through the genre engine (see media.ts musicPlanForGeneration).
  musicControls: MusicControls.optional(),
});
export type MusicProviderControls = z.infer<typeof MusicProviderControls>;

export const ProviderControls = z.object({
  anchors: AnchorProviderControls.optional(),
  shots: ShotProviderControls.optional(),
  music: MusicProviderControls.optional(),
});
export type ProviderControls = z.infer<typeof ProviderControls>;

export const MediaKind = z.enum(["image", "video", "music", "render"]);
export type MediaKind = z.infer<typeof MediaKind>;

export const MediaProvider = z.enum(["openai", "fal", "elevenlabs", "vercel-render", "mock"]);
export type MediaProvider = z.infer<typeof MediaProvider>;

export const MediaGenerationStatus = z.enum(["draft", "queued", "running", "success", "failed"]);
export type MediaGenerationStatus = z.infer<typeof MediaGenerationStatus>;

export const Project = z.object({
  id: z.string().uuid(),
  userId: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  createdAt: z.string(),
});
export type Project = z.infer<typeof Project>;

export const ProjectCreateRequest = z.object({
  name: z.string().trim().min(1).max(120).default("Cocoa Director Project"),
});
export type ProjectCreateRequest = z.infer<typeof ProjectCreateRequest>;

export const BetaAccessRequestStatus = z.enum(["pending", "approved", "rejected"]);
export type BetaAccessRequestStatus = z.infer<typeof BetaAccessRequestStatus>;

export const BetaAccessRequest = z.object({
  id: z.string().uuid(),
  name: z.string().trim().max(120).optional(),
  email: z.string().trim().email().optional(),
  phone: z.string().trim().min(7).max(40).optional(),
  note: z.string().trim().max(1200).optional(),
  ipHash: z.string().trim().max(140).optional(),
  userAgent: z.string().trim().max(240).optional(),
  inviteCodeId: z.string().uuid().optional(),
  status: BetaAccessRequestStatus.default("pending"),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type BetaAccessRequest = z.infer<typeof BetaAccessRequest>;

export const BetaAccessRequestCreateRequest = z.object({
  name: z.string().trim().max(120).optional(),
  email: z.string().trim().email().optional(),
  phone: z.string().trim().min(7).max(40).optional(),
  note: z.string().trim().max(1200).optional(),
  website: z.string().trim().max(200).optional(),
}).refine((request) => request.email || request.phone, {
  message: "Email or phone is required",
});
export type BetaAccessRequestCreateRequest = z.infer<typeof BetaAccessRequestCreateRequest>;

export const BetaAccessRequestUpdateRequest = z.object({
  action: z.enum(["approve", "reject", "resend", "revoke"]).optional(),
  status: BetaAccessRequestStatus.optional(),
}).refine((request) => request.action || request.status, {
  message: "Action or status is required",
});
export type BetaAccessRequestUpdateRequest = z.infer<typeof BetaAccessRequestUpdateRequest>;

export const BetaInviteCode = z.object({
  id: z.string().uuid(),
  accessRequestId: z.string().uuid().optional(),
  codeHash: z.string().min(32),
  email: z.string().trim().email().optional(),
  phone: z.string().trim().min(7).max(40).optional(),
  expiresAt: z.string(),
  consumedAt: z.string().optional(),
  consumedBy: z.string().optional(),
  revokedAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type BetaInviteCode = z.infer<typeof BetaInviteCode>;

export const ProviderAuditStatus = z.enum([
  "blocked_paused",
  "blocked_cap",
  "submitted",
  "success",
  "failed",
]);
export type ProviderAuditStatus = z.infer<typeof ProviderAuditStatus>;

export const ProviderAuditEvent = z.object({
  id: z.string().uuid(),
  userId: z.string().min(1),
  projectId: z.string().uuid().optional(),
  videoJobId: z.string().uuid().optional(),
  mediaGenerationId: z.string().uuid().optional(),
  mediaSessionId: z.string().uuid().optional(),
  provider: z.string().min(1),
  model: z.string().min(1),
  status: ProviderAuditStatus,
  estimatedCostCents: z.number().int().nonnegative().default(0),
  actualCostCents: z.number().int().nonnegative().default(0),
  dailySpentCents: z.number().int().nonnegative().optional(),
  dailyBudgetCents: z.number().int().nonnegative().optional(),
  globalSpentCents: z.number().int().nonnegative().optional(),
  globalBudgetCents: z.number().int().nonnegative().optional(),
  requestId: z.string().optional(),
  idempotencyKey: z.string().optional(),
  billingKey: z.string().optional(),
  error: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string(),
});
export type ProviderAuditEvent = z.infer<typeof ProviderAuditEvent>;

export const BetaFeedbackStatus = z.enum(["open", "reviewing", "resolved", "closed"]);
export type BetaFeedbackStatus = z.infer<typeof BetaFeedbackStatus>;

export const BetaFeedbackKind = z.enum(["issue", "request", "praise", "other"]);
export type BetaFeedbackKind = z.infer<typeof BetaFeedbackKind>;

export const BetaFeedback = z.object({
  id: z.string().uuid(),
  userId: z.string().min(1),
  projectId: z.string().uuid().optional(),
  videoJobId: z.string().uuid().optional(),
  mediaSessionId: z.string().uuid().optional(),
  kind: BetaFeedbackKind,
  message: z.string().trim().min(1).max(2000),
  status: BetaFeedbackStatus.default("open"),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type BetaFeedback = z.infer<typeof BetaFeedback>;

export const BetaFeedbackCreateRequest = z.object({
  projectId: z.string().uuid().optional(),
  videoJobId: z.string().uuid().optional(),
  mediaSessionId: z.string().uuid().optional(),
  kind: BetaFeedbackKind.default("issue"),
  message: z.string().trim().min(4).max(2000),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type BetaFeedbackCreateRequest = z.infer<typeof BetaFeedbackCreateRequest>;

export const LibraryAssetSource = z.enum(["upload", "url", "generation", "render", "system"]);
export type LibraryAssetSource = z.infer<typeof LibraryAssetSource>;

export const LibraryAsset = z.object({
  id: z.string().uuid(),
  userId: z.string().min(1),
  kind: MediaKind,
  name: z.string().trim().min(1).max(160),
  role: z.string().trim().min(1).max(80),
  url: z.string().min(1),
  mimeType: z.string().min(3),
  source: LibraryAssetSource,
  tags: z.array(z.string().trim().min(1).max(40)).max(24).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
  favoriteAt: z.string().optional(),
  createdAt: z.string(),
  deletedAt: z.string().optional(),
});
export type LibraryAsset = z.infer<typeof LibraryAsset>;

export const LibraryAssetUpdateRequest = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(24).optional(),
  favorite: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type LibraryAssetUpdateRequest = z.infer<typeof LibraryAssetUpdateRequest>;

export const LibraryAssetCreateRequest = z.object({
  kind: MediaKind,
  name: z.string().trim().min(1).max(160),
  role: z.string().trim().min(1).max(80).default("reference"),
  // Stored then rendered in the library UI — restrict to safe media URLs (no javascript:/file:).
  url: mediaUrl,
  mimeType: z.string().min(3),
  source: LibraryAssetSource.default("url"),
  tags: z.array(z.string().trim().min(1).max(40)).max(24).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
  pinToProject: z.boolean().default(true),
});
export type LibraryAssetCreateRequest = z.infer<typeof LibraryAssetCreateRequest>;

export const LibraryUrlImportRequest = z.object({
  // Untrusted user input fetched server-side — must be absolute http(s), not /dev-blob/ etc.
  url: httpUrl,
  kind: MediaKind,
  name: z.string().trim().min(1).max(160).optional(),
  role: z.string().trim().min(1).max(80).default("reference"),
  mimeType: z.string().min(3).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(24).default([]),
  pinToProject: z.boolean().default(true),
});
export type LibraryUrlImportRequest = z.infer<typeof LibraryUrlImportRequest>;

export const ProjectAssetLink = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  libraryAssetId: z.string().uuid(),
  mediaAssetId: z.string().uuid(),
  createdAt: z.string(),
});
export type ProjectAssetLink = z.infer<typeof ProjectAssetLink>;

export const LibraryCollection = z.object({
  id: z.string().uuid(),
  userId: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  metadata: z.record(z.string(), z.unknown()).default({}),
  assetIds: z.array(z.string().uuid()).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().optional(),
});
export type LibraryCollection = z.infer<typeof LibraryCollection>;

export const LibraryCollectionCreateRequest = z.object({
  name: z.string().trim().min(1).max(120),
  metadata: z.record(z.string(), z.unknown()).default({}),
  assetIds: z.array(z.string().uuid()).max(80).default([]),
});
export type LibraryCollectionCreateRequest = z.infer<typeof LibraryCollectionCreateRequest>;

export const LibraryCollectionUpdateRequest = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  archived: z.boolean().optional(),
});
export type LibraryCollectionUpdateRequest = z.infer<typeof LibraryCollectionUpdateRequest>;

export const MediaSessionKind = z.enum(["image", "video", "music", "render", "film"]);
export type MediaSessionKind = z.infer<typeof MediaSessionKind>;

export const MediaSessionStatus = z.enum(["draft", "active", "complete", "archived"]);
export type MediaSessionStatus = z.infer<typeof MediaSessionStatus>;

export const MediaSession = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  kind: MediaSessionKind,
  title: z.string().trim().min(1).max(160),
  status: MediaSessionStatus.default("active"),
  sourceAssetId: z.string().uuid().optional(),
  currentAssetId: z.string().uuid().optional(),
  goal: z.string().trim().max(1200).optional(),
  settings: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MediaSession = z.infer<typeof MediaSession>;

export const MediaSessionVersion = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  assetId: z.string().uuid(),
  generationId: z.string().uuid().optional(),
  label: z.string().trim().min(1).max(160),
  prompt: z.string().trim().max(2000).optional(),
  controls: z.record(z.string(), z.unknown()).default({}),
  parentVersionId: z.string().uuid().optional(),
  notes: z.string().trim().max(1200).optional(),
  createdAt: z.string(),
});
export type MediaSessionVersion = z.infer<typeof MediaSessionVersion>;

export const MediaSessionCreateRequest = z.object({
  kind: MediaSessionKind,
  title: z.string().trim().min(1).max(160).optional(),
  sourceAssetId: z.string().uuid().optional(),
  goal: z.string().trim().max(1200).optional(),
  settings: z.record(z.string(), z.unknown()).default({}),
});
export type MediaSessionCreateRequest = z.infer<typeof MediaSessionCreateRequest>;

export const MediaSessionGenerationRequest = z.object({
  prompt: z.string().trim().min(1).max(2000),
  controls: z.record(z.string(), z.unknown()).default({}),
  inputAssetIds: z.array(z.string().uuid()).default([]),
  provider: MediaProvider.optional(),
  execute: z.boolean().default(true),
  idempotencyKey: z.string().trim().min(8).max(120).optional(),
  label: z.string().trim().max(120).optional(),
});
export type MediaSessionGenerationRequest = z.infer<typeof MediaSessionGenerationRequest>;

export const MediaInjectionAction = z.enum([
  "use_as_anchor",
  "use_as_shot_reference",
  "replace_selected_shot",
  "use_as_music_track",
  "use_in_render_manifest",
]);
export type MediaInjectionAction = z.infer<typeof MediaInjectionAction>;

export const MediaAsset = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  videoJobId: z.string().uuid().optional(),
  generationId: z.string().uuid().optional(),
  kind: MediaKind,
  role: z.string().min(1).max(80),
  url: z.string().min(1),
  mimeType: z.string().min(3),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string(),
  deletedAt: z.string().optional(),
});
export type MediaAsset = z.infer<typeof MediaAsset>;

export const MediaGeneration = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  videoJobId: z.string().uuid().optional(),
  kind: MediaKind,
  provider: MediaProvider,
  model: z.string().min(1),
  status: MediaGenerationStatus,
  prompt: z.string().trim().min(1).max(2000),
  controls: z.record(z.string(), z.unknown()).default({}),
  inputAssetIds: z.array(z.string().uuid()).default([]),
  outputUrls: z.record(z.string(), z.string().min(1)).default({}),
  metadata: z.record(z.string(), z.unknown()).default({}),
  costCents: z.number().int().nonnegative().default(0),
  requestId: z.string().optional(),
  error: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MediaGeneration = z.infer<typeof MediaGeneration>;

export const MediaLibraryResponse = z.object({
  projectId: z.string().uuid(),
  generations: z.array(MediaGeneration),
  assets: z.array(MediaAsset),
});
export type MediaLibraryResponse = z.infer<typeof MediaLibraryResponse>;

export const MediaGenerationCreateRequest = z.object({
  videoJobId: z.string().uuid().optional(),
  kind: MediaKind,
  provider: MediaProvider.optional(),
  prompt: z.string().trim().min(1).max(2000),
  controls: z.record(z.string(), z.unknown()).default({}),
  inputAssetIds: z.array(z.string().uuid()).default([]),
  execute: z.boolean().default(true),
  idempotencyKey: z.string().trim().min(8).max(120).optional(),
  label: z.string().trim().max(120).optional(),
});
export type MediaGenerationCreateRequest = z.infer<typeof MediaGenerationCreateRequest>;

export const MediaGenerationInjectRequest = z.object({
  videoJobId: z.string().uuid(),
  action: MediaInjectionAction,
  role: AnchorRole.optional(),
  shotIndex: z.number().int().nonnegative().optional(),
  note: z.string().trim().max(800).optional(),
});
export type MediaGenerationInjectRequest = z.infer<typeof MediaGenerationInjectRequest>;

export const RenderAgentProposal = z.object({
  title: z.string().min(1).max(120),
  rationale: z.string().min(1).max(800),
  kind: MediaKind,
  provider: MediaProvider,
  prompt: z.string().min(1).max(2000),
  controls: z.record(z.string(), z.unknown()).default({}),
  inputAssetIds: z.array(z.string().uuid()).default([]),
  injectionAction: MediaInjectionAction.optional(),
  targetId: z.string().optional(),
  costRisk: z.string().min(1).max(240),
});
export type RenderAgentProposal = z.infer<typeof RenderAgentProposal>;

export const AgentActionType = z.enum([
  "media_generation",
  "pipeline_directive",
  "pipeline_regeneration",
  "media_injection",
]);
export type AgentActionType = z.infer<typeof AgentActionType>;

export const AgentActionProposal = z.object({
  actionType: AgentActionType,
  title: z.string().min(1).max(120),
  rationale: z.string().min(1).max(800),
  costRisk: z.string().min(1).max(240),
  kind: MediaKind.optional(),
  provider: MediaProvider.optional(),
  prompt: z.string().trim().min(1).max(2000).optional(),
  controls: z.record(z.string(), z.unknown()).default({}),
  inputAssetIds: z.array(z.string().uuid()).default([]),
  label: z.string().trim().max(120).optional(),
  scope: EditorScope.optional(),
  phase: PhaseNumber.optional(),
  targetId: z.string().min(1).optional(),
  strategy: RegenerateStrategy.optional(),
  directiveText: z.string().trim().max(1200).optional(),
  providerControls: ProviderControls.optional(),
  generationId: z.string().uuid().optional(),
  injectionAction: MediaInjectionAction.optional(),
  role: AnchorRole.optional(),
  shotIndex: z.number().int().nonnegative().optional(),
});
export type AgentActionProposal = z.infer<typeof AgentActionProposal>;

export const MediaSessionMessageRole = z.enum(["user", "agent", "system"]);
export type MediaSessionMessageRole = z.infer<typeof MediaSessionMessageRole>;

export const MediaSessionMessage = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  role: MediaSessionMessageRole,
  content: z.string().trim().min(1).max(4000),
  proposal: AgentActionProposal.optional(),
  generationId: z.string().uuid().optional(),
  versionId: z.string().uuid().optional(),
  actionId: z.string().uuid().optional(),
  createdAt: z.string(),
});
export type MediaSessionMessage = z.infer<typeof MediaSessionMessage>;

export const RenderAgentMessageRequest = z.object({
  videoJobId: z.string().uuid().optional(),
  message: z.string().trim().min(1).max(2000),
  mode: z.enum(["compose", "inspect", "refine"]).default("compose"),
});
export type RenderAgentMessageRequest = z.infer<typeof RenderAgentMessageRequest>;

export const RenderAgentMessageResponse = z.object({
  reply: z.string(),
  proposal: RenderAgentProposal.optional(),
});
export type RenderAgentMessageResponse = z.infer<typeof RenderAgentMessageResponse>;

export const MediaSessionAgentMessageRequest = z.object({
  videoJobId: z.string().uuid().optional(),
  message: z.string().trim().min(1).max(2000),
  mode: z.enum(["compose", "inspect", "refine"]).default("compose"),
});
export type MediaSessionAgentMessageRequest = z.infer<typeof MediaSessionAgentMessageRequest>;

export const MediaSessionAgentMessageResponse = z.object({
  reply: z.string(),
  proposal: AgentActionProposal.optional(),
  messages: z.array(MediaSessionMessage).default([]),
});
export type MediaSessionAgentMessageResponse = z.infer<typeof MediaSessionAgentMessageResponse>;

export const ProjectAgentMessageRequest = z.object({
  videoJobId: z.string().uuid().optional(),
  sessionId: z.string().uuid().optional(),
  message: z.string().trim().min(1).max(2000),
  mode: z.enum(["compose", "inspect", "refine"]).default("compose"),
  workspace: z.string().trim().max(80).optional(),
  selectedAssetIds: z.array(z.string().uuid()).default([]),
  shotIndex: z.number().int().nonnegative().optional(),
});
export type ProjectAgentMessageRequest = z.infer<typeof ProjectAgentMessageRequest>;

export const ProjectAgentMessageResponse = z.object({
  reply: z.string(),
  proposal: AgentActionProposal.optional(),
  messages: z.array(MediaSessionMessage).default([]),
});
export type ProjectAgentMessageResponse = z.infer<typeof ProjectAgentMessageResponse>;

export const VideoCreateRequest = z.object({
  prompt: z.string().trim().min(12).max(1500),
  durationSeconds: z.number().int().min(60).max(120).default(75),
  aspectRatio: AspectRatio.default("9:16"),
  visualMode: VisualMode.default("conceptual"),
  mood: z.string().trim().max(120).optional(),
  genre: z.string().trim().max(120).optional(),
  musicControls: MusicControls.optional(),
  seeds: VideoSeeds.optional(),
  autopilot: z.boolean().default(false),
});
export type VideoCreateRequest = z.infer<typeof VideoCreateRequest>;

export const VisualSignature = z.object({
  id: z.string().min(2),
  paletteFamily: z.string().min(3),
  palette: z.array(z.string().min(2)).min(3),
  medium: z.string().min(3),
  worldGrammar: z.string().min(8),
  recurringMotifs: z.array(z.string().min(2)).default([]),
  texture: z.string().min(3),
  cameraLanguage: z.array(z.string().min(3)).min(3),
  avoidMotifs: z.array(z.string().min(3)).default([]),
});
export type VisualSignature = z.infer<typeof VisualSignature>;

export const CreativeStyleContract = z.object({
  source: z.enum(["llm", "deterministic", "llm_fallback"]).default("deterministic"),
  confidence: z.number().min(0).max(1).default(0.65),
  musicIntent: z.object({
    primaryGenre: z.string().min(2),
    secondaryGenres: z.array(z.string().min(2)).default([]),
    requestedInstruments: z.array(z.string().min(2)).default([]),
    vocalMode: z.enum(["vocal", "instrumental", "mixed", "unspecified"]).default("unspecified"),
    lyricsPolicy: z.string().min(2).optional(),
    tempoFeel: z.string().min(2).optional(),
    positiveStyle: z.array(z.string().min(2)).default([]),
  }),
  visualIntent: z.object({
    primaryStyle: z.string().min(2),
    secondaryStyles: z.array(z.string().min(2)).default([]),
    setting: z.string().min(2).optional(),
    palette: z.array(z.string().min(2)).default([]),
    materials: z.array(z.string().min(2)).default([]),
    camera: z.array(z.string().min(2)).default([]),
    positiveVocabulary: z.array(z.string().min(2)).default([]),
  }),
  userMotifs: z.array(z.string().min(2)).default([]),
  routing: z.object({
    musicProfile: z.string().min(2),
    visualLane: z.string().min(2),
  }),
  conflicts: z.array(z.string().min(2)).default([]),
  providerRequestId: z.string().optional(),
  createdAt: z.string().optional(),
});
export type CreativeStyleContract = z.infer<typeof CreativeStyleContract>;

export const CreativeBrief = z.object({
  videoId: z.string().uuid(),
  durationSeconds: z.number().int().min(60).max(120),
  aspectRatio: AspectRatio,
  visualMode: VisualMode.default("conceptual"),
  storySpine: z.string().min(20),
  visualWorld: z.string().min(20),
  visualSignature: VisualSignature.optional(),
  subject: z.object({
    type: z.enum(["character", "abstract", "environment"]),
    description: z.string().min(8),
  }),
  energyArc: z.array(z.enum(["build", "peak", "drop", "calm"])).min(3),
  mood: z.string().min(2),
  genre: z.string().min(2),
  styleContract: CreativeStyleContract.optional(),
  musicControls: MusicControls.optional(),
  safetyNotes: z.array(z.string()).default([]),
});
export type CreativeBrief = z.infer<typeof CreativeBrief>;

export const AnchorAudit = z.object({
  role: AnchorRole,
  status: z.enum(["aligned", "low_alignment", "excluded", "legacy"]).default("legacy"),
  dominantObjects: z.array(z.string().min(1)).default([]),
  styleAlignment: z.number().min(0).max(1).default(1),
  reuseEligible: z.boolean().default(true),
  notes: z.array(z.string().min(1)).default([]),
  source: z.enum(["vision", "prompt", "heuristic"]).default("heuristic"),
  providerRequestId: z.string().optional(),
  auditedAt: z.string().optional(),
});
export type AnchorAudit = z.infer<typeof AnchorAudit>;

export const MusicPlanSection = z.object({
  id: z.string().min(2),
  durationSeconds: z.number().int().min(4),
  energy: z.number().min(0).max(1),
  instrumentation: z.string().min(4),
  lyrics: z.string().optional(),
});
export type MusicPlanSection = z.infer<typeof MusicPlanSection>;

export const MusicPlan = z.object({
  videoId: z.string().uuid(),
  vocal: z.boolean(),
  voiceFamily: VoiceFamily,
  language: z.string().optional(),
  bpm: z.number().int().min(60).max(180),
  key: z.string().min(1),
  styleSummary: z.string().min(4).optional(),
  negativeStyleSummary: z.string().min(4).optional(),
  sections: z.array(MusicPlanSection).min(3),
});
export type MusicPlan = z.infer<typeof MusicPlan>;

export const LyricWord = z.object({
  word: z.string(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
});
export type LyricWord = z.infer<typeof LyricWord>;

export const MusicTrack = z.object({
  videoId: z.string().uuid(),
  url: mediaUrl,
  durationSeconds: z.number().positive(),
  songId: z.string(),
  lyrics: z.array(LyricWord).default([]),
  providerRequestId: z.string(),
  // Metadata from ElevenLabs composeDetailed (response.json.songMetadata). Optional:
  // mock mode and tracks generated before this was captured may omit these.
  title: z.string().optional(),
  genres: z.array(z.string()).optional(),
  languages: z.array(z.string()).optional(),
  isExplicit: z.boolean().optional(),
});
export type MusicTrack = z.infer<typeof MusicTrack>;

export const BeatGrid = z.object({
  videoId: z.string().uuid(),
  bpm: z.number().positive(),
  source: z.enum(["audio_analysis", "provider_timestamps", "plan_fallback"]).optional(),
  analysis: z.object({
    confidence: z.number().min(0).max(1),
    onsetCount: z.number().int().nonnegative(),
    medianOnsetOffsetMs: z.number().nonnegative().optional(),
    analyzedAt: z.string(),
  }).optional(),
  events: z.array(
    z.object({
      timeMs: z.number().int().nonnegative(),
      type: z.enum(["beat", "downbeat", "section_change"]),
      strength: z.number().min(0).max(1),
      sectionId: z.string(),
    }),
  ),
});
export type BeatGrid = z.infer<typeof BeatGrid>;

export const AnchorAsset = z.object({
  role: AnchorRole,
  url: mediaUrl,
  promptUsed: z.string(),
  c2paClaim: z.string().optional(),
  audit: AnchorAudit.optional(),
  // Provenance when this anchor was generated from a user-uploaded seed (image-to-image).
  // Used downstream to protect a seeded character plate from the reuse-audit and to badge it.
  seededFrom: z
    .object({
      intent: z.enum(["character", "aesthetic"]),
      referenceCount: z.number().int().min(1).max(5),
    })
    .optional(),
});
export type AnchorAsset = z.infer<typeof AnchorAsset>;

export const Shot = z.object({
  shotIndex: z.number().int().nonnegative(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  seedanceMode: z.enum(["text-to-video", "image-to-video", "reference-to-video"]),
  seedanceTier: z.enum(["standard", "fast"]),
  resolution: z.enum(["480p", "720p", "1080p"]),
  prompt: z.string().min(20),
  referenceImages: z.array(mediaUrl).max(9),
  audioReferenceUrl: mediaUrl.optional(),
  audioReferenceUrls: z.array(mediaUrl).max(3).optional(),
  priorShotEndFrameUrl: mediaUrl.optional(),
  referenceVideos: z.array(mediaUrl).max(3).optional(),
  seedanceAspectRatio: SeedanceAspectRatio.optional(),
  generateAudio: z.boolean().optional(),
  sceneLane: z.string().default("core_scene"),
  visualMotif: z.string().default("signature motif"),
  cameraIntent: z.string().default("beat-aware cinematic movement"),
  referenceRoles: z.array(AnchorRole).default([]),
  seed: z.number().int(),
  internalCuts: z.array(z.number().int().nonnegative()).default([]),
  // True when this shot uses a user-seeded character reference. Signals Seedance to keep the
  // stylized performer on a reference rejection instead of inventing a brand-new face.
  seededCharacter: z.boolean().optional(),
  routingReason: z.string().min(1).max(300).optional(),
});
export type Shot = z.infer<typeof Shot>;

export const ShotPlan = z.object({
  videoId: z.string().uuid(),
  shots: z.array(Shot).min(1),
});
export type ShotPlan = z.infer<typeof ShotPlan>;

export const GeneratedShot = z.object({
  shotIndex: z.number().int().nonnegative(),
  providerRequestId: z.string(),
  videoUrl: mediaUrl,
  sourceVideoUrl: mediaUrl.optional(),
  requestedDurationSeconds: z.number().positive().optional(),
  actualDurationSeconds: z.number().positive().optional(),
  usableInSeconds: z.number().nonnegative().optional(),
  usableOutSeconds: z.number().positive().optional(),
  timelineStartMs: z.number().int().nonnegative().optional(),
  timelineEndMs: z.number().int().positive().optional(),
  probe: MediaProbeMetadata.optional(),
  provenance: AssetProvenance.optional(),
  referencePolicy: z.enum(["all", "visual-only", "stability-retry"]).optional(),
  durationSeconds: z.number().positive(),
  seed: z.number().int(),
  costUsd: z.number().nonnegative(),
  latencyMs: z.number().int().nonnegative(),
  qaScore: z.number().min(0).max(1).optional(),
  attempts: z.number().int().min(1).default(1),
});
export type GeneratedShot = z.infer<typeof GeneratedShot>;

export const RenderManifest = z.object({
  videoId: z.string().uuid(),
  music: z.object({ url: mediaUrl, durationSeconds: z.number() }),
  shots: z.array(GeneratedShot),
  beatGrid: BeatGrid,
  lyrics: z.array(LyricWord).optional(),
  aspectRatio: AspectRatio,
  timeline: TimelineManifestV2.optional(),
  qaReport: QAReport.optional(),
});
export type RenderManifest = z.infer<typeof RenderManifest>;

export const ProviderCall = z.object({
  id: z.string(),
  videoJobId: z.string().uuid(),
  phaseNumber: PhaseNumber,
  provider: z.string(),
  model: z.string(),
  requestId: z.string(),
  idempotencyKey: z.string(),
  latencyMs: z.number().int().nonnegative(),
  costCents: z.number().int().nonnegative(),
  status: z.enum(["queued", "running", "success", "failed", "skipped"]),
  error: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.string(),
});
export type ProviderCall = z.infer<typeof ProviderCall>;

export const PromptTrace = z.object({
  styleContract: CreativeStyleContract.optional(),
  promptSummaries: z.record(z.string(), z.string()).default({}),
  providerPayloadSummaries: z.record(z.string(), z.unknown()).default({}),
  selectedReferences: z.array(z.object({
    shotIndex: z.number().int().nonnegative(),
    roles: z.array(AnchorRole),
    urlCount: z.number().int().nonnegative(),
  })).default([]),
  anchorAudits: z.array(AnchorAudit).default([]),
  updatedAt: z.string().optional(),
});
export type PromptTrace = z.infer<typeof PromptTrace>;

export const EditDirective = z.object({
  id: z.string().uuid(),
  scope: EditorScope,
  phase: PhaseNumber.optional(),
  targetId: z.string().min(1).optional(),
  text: z.string().trim().min(1).max(1200),
  strategy: RegenerateStrategy.optional(),
  providerControls: ProviderControls.optional(),
  status: z.enum(["active", "archived"]).default("active"),
  createdAt: z.string(),
  appliedAt: z.string().optional(),
});
export type EditDirective = z.infer<typeof EditDirective>;

export const ArtifactVersion = z.object({
  id: z.string().uuid(),
  scope: EditorScope,
  phase: PhaseNumber.optional(),
  targetId: z.string().min(1).optional(),
  label: z.string().min(1).max(120),
  payload: z.unknown(),
  urls: z.record(z.string(), mediaUrl).default({}),
  createdAt: z.string(),
});
export type ArtifactVersion = z.infer<typeof ArtifactVersion>;

export const WorkflowPhase = z.object({
  phaseNumber: PhaseNumber,
  name: z.string(),
  state: JobState,
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  artifactUrl: mediaUrl.optional(),
  error: z.string().optional(),
});
export type WorkflowPhase = z.infer<typeof WorkflowPhase>;

export const VideoJobStatus = z.object({
  videoId: z.string().uuid(),
  currentPhase: z.number().int().min(1).max(9),
  state: JobState,
  estimatedCostUsd: z.number().nonnegative(),
  actualCostUsd: z.number().nonnegative(),
  artifacts: z.record(z.string(), mediaUrl),
  error: z.string().optional(),
});
export type VideoJobStatus = z.infer<typeof VideoJobStatus>;

export const VideoJob = z.object({
  id: z.string().uuid(),
  projectId: z.string(),
  userId: z.string(),
  prompt: z.string(),
  status: JobState,
  currentPhase: z.number().int().min(1).max(9),
  estimatedCostCents: z.number().int().nonnegative(),
  actualCostCents: z.number().int().nonnegative(),
  recoveryBudgetCents: z.number().int().nonnegative().default(0),
  recoverySpentCents: z.number().int().nonnegative().default(0),
  aspectRatio: AspectRatio,
  contentType: ContentType.optional(),
  qualityTier: QualityTier.optional(),
  workflowVersion: z.string().optional(),
  sourceBundle: SourceBundle.optional(),
  digestMode: DigestMode.optional(),
  researchMode: ResearchMode.optional(),
  presentationMode: PresentationMode.optional(),
  visualStylePreset: VisualStylePreset.optional(),
  visualPlan: HybridVisualPlanV2.optional(),
  editorialPlan: EditorialPlan.optional(),
  durationPlan: EditorialDurationPlan.optional(),
  storyboard: NewsStoryboard.optional(),
  approvals: z.array(ProductionApproval).optional(),
  timelineManifest: TimelineManifestV2.optional(),
  qaReport: QAReport.optional(),
  workflowSteps: z.array(WorkflowStep).optional(),
  script: z.string().optional(),
  narrationAssetId: z.string().uuid().optional(),
  visualMode: VisualMode.default("conceptual"),
  durationSeconds: z.number().int(),
  traceId: z.string(),
  cancellationRequested: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  error: z.string().optional(),
  musicControls: MusicControls.optional(),
  seeds: VideoSeeds.default({ subjects: [], aesthetic: [] }),
  creativeBrief: CreativeBrief.optional(),
  musicPlan: MusicPlan.optional(),
  musicTrack: MusicTrack.optional(),
  beatGrid: BeatGrid.optional(),
  anchorAssets: z.array(AnchorAsset).default([]),
  shotPlan: ShotPlan.optional(),
  generatedShots: z.array(GeneratedShot).default([]),
  renderManifest: RenderManifest.optional(),
  finalVideoUrl: mediaUrl.optional(),
  thumbnailUrl: mediaUrl.optional(),
  promptTrace: PromptTrace.optional(),
  editDirectives: z.array(EditDirective).default([]),
  artifactVersions: z.array(ArtifactVersion).default([]),
  phases: z.array(WorkflowPhase),
  providerCalls: z.array(ProviderCall).default([]),
});
export type VideoJob = z.infer<typeof VideoJob>;

export const RegenerateTarget = z.object({
  scope: EditorScope.optional(),
  phase: PhaseNumber.optional(),
  targetId: z.string().min(1).optional(),
}).optional();

export const RegenerateRequest = z.object({
  phase: PhaseNumber,
  directiveIds: z.array(z.string().uuid()).default([]),
  directiveText: z.string().trim().max(1200).optional(),
  strategy: RegenerateStrategy.optional(),
  providerControls: ProviderControls.optional(),
  target: RegenerateTarget,
  params: z.record(z.string(), z.unknown()).optional(),
});
export type RegenerateRequest = z.infer<typeof RegenerateRequest>;

export const ShotRegenerateRequest = z.object({
  directiveIds: z.array(z.string().uuid()).default([]),
  directiveText: z.string().trim().max(1200).optional(),
  strategy: RegenerateStrategy.optional(),
  providerControls: ProviderControls.optional(),
  target: RegenerateTarget,
}).default({ directiveIds: [] });
export type ShotRegenerateRequest = z.infer<typeof ShotRegenerateRequest>;

export const EditDirectiveCreateRequest = z.object({
  scope: EditorScope,
  phase: PhaseNumber.optional(),
  targetId: z.string().min(1).optional(),
  text: z.string().trim().min(1).max(1200),
  strategy: RegenerateStrategy.optional(),
  providerControls: ProviderControls.optional(),
});
export type EditDirectiveCreateRequest = z.infer<typeof EditDirectiveCreateRequest>;

export const AdvanceRequest = z.object({
  idempotencyKey: z.string().min(8).optional(),
});
export type AdvanceRequest = z.infer<typeof AdvanceRequest>;
