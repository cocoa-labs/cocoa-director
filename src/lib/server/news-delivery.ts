import { editorialSurfaceColors, editorialTextSvg, fitEditorialText, sourceCardSvg } from "@/lib/server/editorial-graphics";
import { outlineEditorialText, renderFontFiles } from "@/lib/server/render-fonts";
import { reserveProviderAttempt } from "@/lib/server/budget-ledger";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mediaTools, mediaToolsSource, prepareSandboxMediaTools } from "@/lib/server/media-tools";
import { Sandbox } from "@vercel/sandbox";
import sharp from "sharp";

import type {
  HybridVisualPlanV2,
  NewsStoryboard,
  ProductionSource,
  TimelineManifestV2,
  TimelineSegment,
  VideoJob,
  VisualBeat,
  WorkflowStep,
} from "@/lib/schemas";
import { timelineToSrt, timelineToVtt } from "@/lib/captions";
import { narrationBudgetSummary, DEFAULT_NARRATION_WORDS_PER_SECOND } from "@/lib/hybrid-visuals";
import { applyTimingPlan, compileEditorialTimingPlan } from "@/lib/editorial-timing";
import { editorialNarrationTiming } from "@/lib/editorial-narration";
import { validateTimeline } from "@/lib/production";
import { fetchBlobUrl, uploadPublicBlob } from "@/lib/server/blob";
import { getProviderMode, isEditorialTimingV2Enabled, isHybridVisualsV2Enabled, isLayeredEditorialCompositorEnabled, isSourceVisualsV2Enabled } from "@/lib/server/config";
import { probeMediaFile, probeMediaUrl } from "@/lib/server/media-probe";
import { heartbeatLatestRun, recordEditorialStep } from "@/lib/server/production-runtime";
import { getStore } from "@/lib/server/store";
import { assertMediaCoversSlot } from "@/lib/server/media-probe";
import { renderProductionSourcePdfPage } from "@/lib/server/source-processing";
import { attachAuthenticSourceVisuals, validateGraphicPayload } from "@/lib/server/source-visuals";

type WordTiming = { text: string; startMs: number; endMs: number };
type SceneNarration = { audio: Buffer; durationMs: number; words: WordTiming[]; contentType: string; costCents: number; requestId?: string };
type SceneAsset = { narration: SceneNarration; targetDurationMs: number };
type RenderBeat = {
  beat: VisualBeat;
  base: Buffer;
  baseType: "image" | "video";
  measuredDurationMs?: number;
  overlay: Buffer;
};

const FPS = 30;
const EDITORIAL_RENDER_VERSION = "bundled-fonts-document-fit-v3";
const MAX_NARRATION_OVERRUN = 1.05;

export async function generateNarrationScene(videoId: string, sceneId: string) {
  const store = getStore();
  const job = await store.getJob(videoId);
  const sceneIndex = job?.storyboard?.scenes.findIndex((scene) => scene.id === sceneId) ?? -1;
  const scene = sceneIndex >= 0 ? job?.storyboard?.scenes[sceneIndex] : undefined;
  if (!job || !scene) throw new Error(`Narration scene not found: ${sceneId}`);
  const scriptVersion = job.workflowSteps?.find((step) => step.id === "script")?.artifactVersionId ?? "script";
  const media = await store.listJobMedia(videoId);
  const existing = media.assets.find((asset) => asset.role === "narration_scene" && asset.metadata.sceneId === sceneId && asset.metadata.scriptVersion === scriptVersion);
  if (existing) return existing;
  const narration = await synthesizeNarration(scene.narration, job, sceneIndex);
  const extension = narration.contentType === "audio/mpeg" ? "mp3" : "wav";
  const blob = await uploadPublicBlob({
    pathname: `videos/${videoId}/editorial/narration-${String(sceneIndex + 1).padStart(2, "0")}-${scriptVersion}.${extension}`,
    body: narration.audio,
    contentType: narration.contentType,
  });
  const generation = await store.createMediaGeneration({
    projectId: job.projectId,
    videoJobId: videoId,
    kind: "music",
    provider: getProviderMode() === "live" ? "elevenlabs" : "mock",
    model: getProviderMode() === "live" ? process.env.ELEVENLABS_TTS_MODEL_ID ?? "eleven_multilingual_v2" : "mock-narration",
    status: "success",
    prompt: scene.narration,
    controls: { narrationSceneId: sceneId, sceneIndex, scriptVersion },
    inputAssetIds: [],
    outputUrls: { audio: blob.url },
    metadata: {
      idempotencyKey: `${videoId}:narration:${scriptVersion}:${sceneIndex + 1}`,
      heartbeatAt: new Date().toISOString(),
      durationMs: narration.durationMs,
      words: narration.words,
      contentType: narration.contentType,
      providerCostCents: narration.costCents,
    },
    costCents: 0,
    requestId: narration.requestId,
  });
  return store.createMediaAsset({
    projectId: job.projectId,
    videoJobId: videoId,
    generationId: generation.id,
    kind: "music",
    role: "narration_scene",
    url: blob.url,
    mimeType: narration.contentType,
    metadata: { sceneId, sceneIndex, scriptVersion, durationMs: narration.durationMs, words: narration.words },
  });
}

export async function reconcileEditorialTiming(videoId: string) {
  const store = getStore();
  const job = await store.getJob(videoId);
  if (!job?.storyboard || !job.visualPlan) throw new Error("Editorial storyboard and visual plan are required before timing reconciliation.");
  if (!isEditorialTimingV2Enabled()) return { requiresScriptRevision: false as const, timingPlan: undefined, storyboard: job.storyboard, visualPlan: job.visualPlan };
  const scriptVersion = job.workflowSteps?.find((step) => step.id === "script")?.artifactVersionId ?? "script";
  const media = await store.listJobMedia(videoId);
  const measured = job.storyboard.scenes.map((scene) => {
    const asset = media.assets.find((candidate) => candidate.role === "narration_scene" && candidate.metadata.sceneId === scene.id && candidate.metadata.scriptVersion === scriptVersion);
    const durationMs = Number(asset?.metadata.durationMs);
    if (!asset || !Number.isFinite(durationMs) || durationMs <= 0) throw new Error(`Measured narration is missing for ${scene.id}.`);
    return { sceneId: scene.id, durationMs: Math.round(durationMs) };
  });
  const timingPlan = compileEditorialTimingPlan({
    productionId: job.id,
    scriptVersionId: scriptVersion,
    storyboard: job.storyboard,
    narration: measured,
    targetDurationMs: job.durationSeconds * 1_000,
    compiledAt: new Date().toISOString(),
  });
  const narrationTiming = editorialNarrationTiming({ ...job, visualPlan: { ...job.visualPlan, timingPlan } });
  const measuredPlan = { ...job.visualPlan, timingPlan, narrationWordsPerSecond: narrationTiming.pacing?.wordsPerSecond };
  if (!timingPlan.coverage.passed) {
    const message = narrationTiming.revisionMessage ?? "Recorded narration does not fit the selected duration. Fit the script to duration and review the new version.";
    const resetIds = new Set(["storyboard_approval", "imagery", "score", "generation", "visual_rough_cut_qa", "timeline", "preflight_qa", "render", "final_qa", "qa", "review"]);
    const workflowSteps = (job.workflowSteps ?? []).map((step): WorkflowStep => {
      if (step.id === "timing_reconciliation" || step.id === "script_approval") {
        return { ...step, state: "awaiting_user", error: message, completedAt: undefined };
      }
      if (resetIds.has(step.id)) return { ...step, state: "pending", startedAt: undefined, completedAt: undefined, error: undefined };
      return step;
    });
    await store.updateJob(videoId, {
      visualPlan: measuredPlan,
      approvals: (job.approvals ?? []).filter((approval) => approval.gate !== "script" && approval.gate !== "storyboard"),
      workflowSteps,
      status: "awaiting_user",
      error: message,
    });
    await heartbeatLatestRun(videoId, "awaiting_user", message);
    return { requiresScriptRevision: true as const, timingPlan, storyboard: job.storyboard, visualPlan: measuredPlan };
  }
  const timed = applyTimingPlan(job.storyboard, measuredPlan, timingPlan);
  const visualPlan = isSourceVisualsV2Enabled() && job.sourceBundle
    ? attachAuthenticSourceVisuals(timed.plan, job.sourceBundle)
    : timed.plan;
  const storyboard = {
    ...timed.storyboard,
    scenes: timed.storyboard.scenes.map((scene) => ({ ...scene, beats: visualPlan.beats.filter((beat) => beat.sceneId === scene.id) })),
  };
  await store.updateJob(videoId, { storyboard, visualPlan });
  return { requiresScriptRevision: false as const, timingPlan, storyboard, visualPlan };
}

export async function prepareEditorialTimeline(videoId: string) {
  const store = getStore();
  const job = await store.getJob(videoId);
  if (!job?.storyboard || (job.contentType !== "news_digest" && job.contentType !== "explainer")) {
    throw new Error("Approved editorial storyboard not found.");
  }
  assertCurrentApprovals(job);
  assertVisualQualityApproved(job);
  await recordEditorialStep(videoId, "timeline", "running");
  const sceneAssets = await loadSceneAssets(job, job.storyboard);
  assertNarrationFits(job, sceneAssets);
  const scriptVersion = job.workflowSteps?.find((step) => step.id === "script")?.artifactVersionId ?? "script";
  const jobMedia = await store.listJobMedia(videoId);
  const audioUrls = await Promise.all(sceneAssets.map(async (asset, index) => {
    const sceneId = job.storyboard?.scenes[index]?.id;
    const existing = jobMedia.assets.find((candidate) => candidate.role === "narration_scene" && candidate.metadata.sceneId === sceneId && candidate.metadata.scriptVersion === scriptVersion);
    if (existing) return existing.url;
    const blob = await uploadPublicBlob({
      pathname: `videos/${videoId}/editorial/narration-${String(index + 1).padStart(2, "0")}-${scriptVersion}.${asset.narration.contentType === "audio/mpeg" ? "mp3" : "wav"}`,
      body: asset.narration.audio,
      contentType: asset.narration.contentType,
    });
    return blob.url;
  }));
  const transitionSfxBlob = await uploadPublicBlob({ pathname: `videos/${videoId}/editorial/transition.wav`, body: transitionSfxWav(), contentType: "audio/wav" });
  const projectMedia = await store.listProjectMedia(job.projectId);
  const score = projectMedia.assets.find((asset) => asset.videoJobId === videoId && asset.kind === "music" && asset.role === "music_track");
  const timeline = compileEditorialTimeline(job, job.storyboard, hybridPlanFor(job, job.storyboard), sceneAssets, audioUrls, getProviderMode() === "mock" ? undefined : score?.url, transitionSfxBlob.url);
  const narrationAssetId = job.narrationAssetId ?? randomUUID();
  await store.updateJob(videoId, { timelineManifest: timeline, narrationAssetId });
  await recordEditorialStep(videoId, "timeline", "complete");
  await recordEditorialStep(videoId, "preflight_qa", "running");
  const preflight = validateTimeline({ timeline, sourceBundle: job.sourceBundle, checkedAt: new Date().toISOString() });
  if (!preflight.passed) {
    throw new Error(`Editorial preflight failed: ${preflight.findings.filter((finding) => finding.severity === "error").map((finding) => finding.message).join("; ")}`);
  }
  await recordEditorialStep(videoId, "preflight_qa", "complete");
  return timeline;
}

export async function generateNewsDelivery(videoId: string) {
  const store = getStore();
  const job = await store.getJob(videoId);
  if (!job || (job.contentType !== "news_digest" && job.contentType !== "explainer") || !job.storyboard) {
    throw new Error("Approved editorial storyboard not found.");
  }
  if (job.status === "complete" && job.finalVideoUrl && job.thumbnailUrl) return job;
  assertCurrentApprovals(job);
  assertVisualQualityApproved(job);
  const storyboard = job.storyboard;
  const sources = await store.listProductionSources(job.projectId);
  const sourcesById = new Map(sources.map((source) => [source.id, source]));
  const documentVisualCache = new Map<string, Promise<Buffer>>();
  const plan = hybridPlanFor(job, storyboard);
  const sceneAssets = await loadSceneAssets(job, storyboard);
  assertNarrationFits(job, sceneAssets);
  const existingNarrationUrls = job.timelineManifest?.tracks.find((track) => track.kind === "narration")?.segments.map((segment) => segment.sourceUrl).filter((url): url is string => Boolean(url));
  const audioUrls = existingNarrationUrls?.length === sceneAssets.length ? existingNarrationUrls : await Promise.all(sceneAssets.map(async (asset, index) => (await uploadPublicBlob({
    pathname: `videos/${videoId}/editorial/narration-${String(index + 1).padStart(2, "0")}.${asset.narration.contentType === "audio/mpeg" ? "mp3" : "wav"}`,
    body: asset.narration.audio,
    contentType: asset.narration.contentType,
  })).url));
  const transitionSfx = transitionSfxWav();
  const transitionSfxBlob = await uploadPublicBlob({ pathname: `videos/${videoId}/editorial/transition.wav`, body: transitionSfx, contentType: "audio/wav" });
  const media = await store.listProjectMedia(job.projectId);
  const score = media.assets.find((asset) => asset.videoJobId === videoId && asset.kind === "music" && asset.role === "music_track");
  const scoreUrl = getProviderMode() === "mock" ? undefined : score?.url;
  const timeline = job.timelineManifest ?? compileEditorialTimeline(job, storyboard, plan, sceneAssets, audioUrls, scoreUrl, transitionSfxBlob.url);
  const narrationAssetId = job.narrationAssetId ?? randomUUID();
  await store.updateJob(videoId, { timelineManifest: timeline, narrationAssetId });
  await recordEditorialStep(videoId, "narration", "complete");
  await recordEditorialStep(videoId, "timeline", "complete");
  await recordEditorialStep(videoId, "preflight_qa", "running");
  const preflight = validateTimeline({ timeline, sourceBundle: job.sourceBundle, checkedAt: new Date().toISOString() });
  if (!preflight.passed) {
    throw new Error(`Editorial preflight failed: ${preflight.findings.filter((finding) => finding.severity === "error").map((finding) => finding.message).join("; ")}`);
  }
  await recordEditorialStep(videoId, "preflight_qa", "complete");
  await recordEditorialStep(videoId, "render", "running");
  const [renderBeats, scoreBytes] = await Promise.all([
    Promise.all(plan.beats.map((beat) => materializeBeat(beat, job, storyboard, sourcesById, documentVisualCache))),
    scoreUrl ? fetchMedia(scoreUrl) : Promise.resolve(undefined),
  ]);
  const srt = timelineToSrt(timeline);
  const vtt = timelineToVtt(timeline);
  const ass = timelineToAss(timeline, job.aspectRatio);
  const existingCandidate = [...job.artifactVersions].reverse().find((version) =>
    version.scope === "render_candidate" && version.label === "Editorial render candidate" && version.urls.video &&
    version.payload && typeof version.payload === "object" && (version.payload as Record<string, unknown>).timelineCompiledAt === timeline.compiledAt &&
    (version.payload as Record<string, unknown>).rendererVersion === EDITORIAL_RENDER_VERSION
  );
  let renderedVideo: Buffer;
  if (existingCandidate?.urls.video) {
    renderedVideo = await fetchMedia(existingCandidate.urls.video);
  } else {
    const rendered = await renderEditorialAssets(videoId, job, renderBeats, sceneAssets, scoreBytes, transitionSfx, ass);
    renderedVideo = rendered.video;
    const candidateId = randomUUID();
    const candidateBlob = await uploadPublicBlob({ pathname: `videos/${videoId}/render-candidate-${candidateId}.mp4`, body: renderedVideo, contentType: "video/mp4" });
    const latestBeforeCandidate = await store.getJob(videoId);
    if (!latestBeforeCandidate) throw new Error("Production disappeared before render persistence.");
    await store.updateJob(videoId, {
      artifactVersions: [...latestBeforeCandidate.artifactVersions, {
        id: candidateId,
        scope: "render_candidate",
        label: "Editorial render candidate",
        payload: { timelineCompiledAt: timeline.compiledAt, visualPlanVersion: plan.version, rendererVersion: EDITORIAL_RENDER_VERSION },
        urls: { video: candidateBlob.url },
        createdAt: new Date().toISOString(),
      }],
    });
  }
  await recordEditorialStep(videoId, "render", "complete");
  await recordEditorialStep(videoId, "final_qa", "running");
  const probeDirectory = await mkdtemp(join(tmpdir(), "cocoa-editorial-probe-"));
  let probe;
  let audiovisualQa: Awaited<ReturnType<typeof analyzeEditorialOutput>>;
  try {
    const filePath = join(probeDirectory, "final.mp4");
    await writeFile(filePath, renderedVideo);
    [probe, audiovisualQa] = await Promise.all([
      probeMediaFile(filePath),
      analyzeEditorialOutput(filePath, plan, sceneAssets),
    ]);
  } finally {
    await rm(probeDirectory, { recursive: true, force: true });
  }
  const frameMs = 1_000 / timeline.fps;
  if (Math.abs(probe.durationSeconds * 1_000 - timeline.durationMs) > frameMs + 2) {
    throw new Error(`Rendered editorial duration ${(probe.durationSeconds * 1_000).toFixed(1)}ms differs from timeline ${timeline.durationMs}ms by more than one frame.`);
  }
  if (Math.abs(timeline.durationMs - job.durationSeconds * 1_000) > frameMs + 1) {
    throw new Error("Compiled editorial timeline does not match the approved target duration within one frame.");
  }
  if (Math.abs(probe.avStartOffsetMs ?? 0) > frameMs + 1) throw new Error("Rendered editorial audio/video start alignment exceeds one frame.");
  const sourceManifest = buildSourceManifest(job, sources, timeline, plan);
  const humanManifest = humanReadableSourceManifest(sourceManifest);
  const deliveryId = randomUUID();
  const thumbnail = await thumbnailFor(renderBeats[0]);
  const [videoBlob, thumbnailBlob, srtBlob, vttBlob, sourceJsonBlob, sourceTextBlob, claimsBlob] = await Promise.all([
    uploadPublicBlob({ pathname: `videos/${videoId}/final-editorial-${deliveryId}.mp4`, body: renderedVideo, contentType: "video/mp4" }),
    uploadPublicBlob({ pathname: `videos/${videoId}/thumbnail-editorial-${deliveryId}.png`, body: thumbnail, contentType: "image/png" }),
    uploadPublicBlob({ pathname: `videos/${videoId}/captions-${deliveryId}.srt`, body: srt, contentType: "application/x-subrip" }),
    uploadPublicBlob({ pathname: `videos/${videoId}/captions-${deliveryId}.vtt`, body: vtt, contentType: "text/vtt" }),
    uploadPublicBlob({ pathname: `videos/${videoId}/sources-${deliveryId}.json`, body: JSON.stringify(sourceManifest, null, 2), contentType: "application/json" }),
    uploadPublicBlob({ pathname: `videos/${videoId}/sources-${deliveryId}.txt`, body: humanManifest, contentType: "text/plain" }),
    uploadPublicBlob({ pathname: `videos/${videoId}/claims-${deliveryId}.json`, body: JSON.stringify(job.sourceBundle?.claims ?? [], null, 2), contentType: "application/json" }),
  ]);
  const qaReport = validateTimeline({ timeline, sourceBundle: job.sourceBundle, checkedAt: new Date().toISOString() });
  qaReport.findings.push(...audiovisualQa.findings);
  const visualIntegrity = visualIntegrityFindings(job, plan);
  qaReport.findings.push(...visualIntegrity.findings);
  qaReport.passed = qaReport.findings.every((finding) => finding.severity !== "error");
  const duplicateHoldMs = longestExplicitHold(plan);
  qaReport.metrics = {
    ...qaReport.metrics,
    avStartOffsetMs: probe.avStartOffsetMs ?? 0,
    captionCueCount: captionSegments(timeline).length,
    visualBeatCount: plan.beats.length,
    cinematicCoverage: plan.metrics.cinematicCoverage,
    cinematicBeatCount: plan.metrics.cinematicBeatCount,
    evidenceBeatCount: plan.metrics.evidenceBeatCount,
    longestExplicitHoldMs: duplicateHoldMs,
    ...audiovisualQa.metrics,
    ...visualIntegrity.metrics,
  };
  if (!qaReport.passed) throw new Error(`Editorial render failed QA: ${qaReport.findings.filter((finding) => finding.severity === "error").map((finding) => finding.message).join("; ")}`);
  const latestJob = await store.getJob(videoId);
  if (!latestJob) throw new Error("Production disappeared before delivery finalization.");
  const workflowSteps = completeDeliverySteps(latestJob.workflowSteps ?? [], new Date().toISOString());
  return store.updateJob(videoId, {
    timelineManifest: timeline,
    qaReport,
    narrationAssetId,
    finalVideoUrl: videoBlob.url,
    thumbnailUrl: thumbnailBlob.url,
    artifactVersions: [
      ...latestJob.artifactVersions,
      {
        id: deliveryId,
        scope: "render",
        label: "Hybrid cinematic editorial delivery",
        payload: { sourceManifest, probe, visualPlanVersion: plan.version },
        urls: {
          video: videoBlob.url,
          thumbnail: thumbnailBlob.url,
          srt: srtBlob.url,
          vtt: vttBlob.url,
          sourceManifestJson: sourceJsonBlob.url,
          sourceManifestText: sourceTextBlob.url,
          claimLedger: claimsBlob.url,
        },
        createdAt: new Date().toISOString(),
      },
    ],
    workflowSteps,
    status: "complete",
    error: undefined,
  });
}

async function loadSceneAssets(job: VideoJob, storyboard: NewsStoryboard) {
  const sceneAssets = new Array<SceneAsset>(storyboard.scenes.length);
  for (let index = 0; index < storyboard.scenes.length; index += 4) {
    const completed = await Promise.all(storyboard.scenes.slice(index, index + 4).map(async (scene, batchIndex) => ({
      index: index + batchIndex,
      asset: {
        narration: await existingNarrationForScene(job, scene.id) ?? await synthesizeNarration(scene.narration, job, index + batchIndex),
        targetDurationMs: scene.endMs - scene.startMs,
      },
    })));
    for (const item of completed) sceneAssets[item.index] = item.asset;
  }
  return sceneAssets;
}

async function synthesizeNarration(text: string, job: VideoJob, sceneIndex: number): Promise<SceneNarration> {
  if (getProviderMode() !== "live") return mockNarration(text);
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY is required for editorial narration.");
  const voiceId = process.env.ELEVENLABS_NEWS_VOICE_ID ?? process.env.ELEVENLABS_VOICE_ID ?? "JBFqnCBsd6RMkjVDRZzb";
  const startedAt = Date.now();
  await reserveProviderAttempt({ scope: "elevenlabs:narration", videoId: job.id,
    key: `${job.id}:${job.workflowSteps?.find((step) => step.id === "script")?.artifactVersionId ?? "script"}:${sceneIndex}`,
    costCents: Math.ceil(text.length * 0.04) });
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps?output_format=mp3_44100_128`, {
    method: "POST",
    signal: AbortSignal.timeout(180_000),
    headers: { "Content-Type": "application/json", "xi-api-key": apiKey },
    body: JSON.stringify({
      text,
      model_id: process.env.ELEVENLABS_TTS_MODEL_ID ?? "eleven_multilingual_v2",
      voice_settings: { stability: 0.55, similarity_boost: 0.75, style: 0.18, use_speaker_boost: true },
    }),
  });
  const requestId = response.headers.get("request-id") ?? response.headers.get("x-request-id") ?? `tts-${job.id}-${sceneIndex + 1}`;
  const scriptVersion = job.workflowSteps?.find((step) => step.id === "script")?.artifactVersionId ?? "script";
  const ttsIdempotencyKey = `${job.id}:narration:${scriptVersion}:${sceneIndex + 1}`;
  if (!response.ok) {
    const message = `ElevenLabs narration failed: ${response.status} ${(await response.text()).slice(0, 500)}`;
    await getStore().addProviderCall({ videoJobId: job.id, phaseNumber: 4, provider: "elevenlabs", model: process.env.ELEVENLABS_TTS_MODEL_ID ?? "eleven_multilingual_v2", requestId, idempotencyKey: ttsIdempotencyKey, latencyMs: Date.now() - startedAt, costCents: 0, status: "failed", error: message });
    throw new Error(message);
  }
  const payload = await response.json() as {
    audio_base64: string;
    alignment?: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] };
    normalized_alignment?: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] };
  };
  const alignment = payload.normalized_alignment ?? payload.alignment;
  const words = alignment ? wordsFromCharacterAlignment(alignment) : distributeWords(text, estimateNarrationDuration(text));
  const durationMs = Math.max(1_000, (words.at(-1)?.endMs ?? estimateNarrationDuration(text)) + 250);
  const costCents = estimatedTtsCostCents(text);
  await getStore().addProviderCall({ videoJobId: job.id, phaseNumber: 4, provider: "elevenlabs", model: process.env.ELEVENLABS_TTS_MODEL_ID ?? "eleven_multilingual_v2", requestId, idempotencyKey: ttsIdempotencyKey, latencyMs: Date.now() - startedAt, costCents, status: "success" });
  return { audio: Buffer.from(payload.audio_base64, "base64"), durationMs, words, contentType: "audio/mpeg", costCents, requestId };
}

async function existingNarrationForScene(job: VideoJob, sceneId: string): Promise<SceneNarration | undefined> {
  const scriptVersion = job.workflowSteps?.find((step) => step.id === "script")?.artifactVersionId ?? "script";
  const media = await getStore().listJobMedia(job.id);
  const asset = media.assets.find((candidate) => candidate.role === "narration_scene" && candidate.metadata.sceneId === sceneId && candidate.metadata.scriptVersion === scriptVersion);
  if (asset) {
    const words = Array.isArray(asset.metadata.words) ? asset.metadata.words.filter(isWordTiming) : [];
    return {
      audio: await fetchMedia(asset.url),
      durationMs: typeof asset.metadata.durationMs === "number" ? asset.metadata.durationMs : 1_000,
      words,
      contentType: asset.mimeType,
      costCents: 0,
      requestId: media.generations.find((generation) => generation.id === asset.generationId)?.requestId,
    };
  }
  const segment = job.timelineManifest?.tracks.find((track) => track.kind === "narration")?.segments.find((candidate) => candidate.metadata.sceneId === sceneId && candidate.sourceUrl);
  if (!segment?.sourceUrl) return undefined;
  const cues = job.timelineManifest?.tracks.find((track) => track.kind === "captions")?.segments.filter((candidate) => candidate.metadata.sceneId === sceneId) ?? [];
  const words = cues.flatMap((cue) => {
    const text = typeof cue.metadata.text === "string" ? cue.metadata.text : "";
    return distributeWords(text, cue.endMs - cue.startMs).map((word) => ({ ...word, startMs: word.startMs + cue.startMs - segment.startMs, endMs: word.endMs + cue.startMs - segment.startMs }));
  });
  return {
    audio: await fetchMedia(segment.sourceUrl),
    durationMs: segment.actualDurationMs ?? segment.endMs - segment.startMs,
    words,
    contentType: segment.sourceUrl.toLowerCase().includes(".mp3") ? "audio/mpeg" : "audio/wav",
    costCents: 0,
  };
}

function isWordTiming(value: unknown): value is WordTiming {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<WordTiming>;
  return typeof candidate.text === "string" && typeof candidate.startMs === "number" && typeof candidate.endMs === "number";
}

function mockNarration(text: string): SceneNarration {
  const durationMs = estimateNarrationDuration(text);
  return { audio: silentWav(durationMs), durationMs, words: distributeWords(text, durationMs), contentType: "audio/wav", costCents: 0 };
}

function estimatedTtsCostCents(text: string) {
  const dollarsPerThousandCharacters = Number(process.env.ELEVENLABS_TTS_USD_PER_1000_CHARACTERS ?? "0.30");
  return Math.max(1, Math.round(text.length / 1_000 * (Number.isFinite(dollarsPerThousandCharacters) ? dollarsPerThousandCharacters : 0.30) * 100));
}

function estimateNarrationDuration(text: string) {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1_500, Math.round(words / DEFAULT_NARRATION_WORDS_PER_SECOND * 1_000));
}

function wordsFromCharacterAlignment(alignment: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] }) {
  const result: WordTiming[] = [];
  let token = "";
  let startIndex = 0;
  const flush = (endIndex: number) => {
    const text = token.trim();
    if (!text) return;
    result.push({
      text,
      startMs: Math.round((alignment.character_start_times_seconds[startIndex] ?? 0) * 1_000),
      endMs: Math.max(1, Math.round((alignment.character_end_times_seconds[Math.max(startIndex, endIndex - 1)] ?? 0) * 1_000)),
    });
    token = "";
  };
  alignment.characters.forEach((character, index) => {
    if (/\s/.test(character)) { flush(index); startIndex = index + 1; }
    else { if (!token) startIndex = index; token += character; }
  });
  flush(alignment.characters.length);
  return result;
}

function distributeWords(text: string, durationMs: number) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const slot = durationMs / Math.max(1, words.length);
  return words.map((word, index) => ({ text: word, startMs: Math.round(index * slot), endMs: Math.round((index + 1) * slot) }));
}

export function compileEditorialTimeline(
  job: VideoJob,
  storyboard: NewsStoryboard,
  plan: HybridVisualPlanV2,
  assets: SceneAsset[],
  audioUrls: string[],
  scoreUrl?: string,
  transitionSfxUrl?: string,
): TimelineManifestV2 {
  const video: TimelineSegment[] = [];
  const graphics: TimelineSegment[] = [];
  const narration: TimelineSegment[] = [];
  const captions: TimelineSegment[] = [];
  const citations: TimelineSegment[] = [];
  const disclosures: TimelineSegment[] = [];
  for (const beat of plan.beats) {
    const sourceAsset = [...beat.assets]
      .sort((left, right) => Number(Boolean(right.immutableStorageKey)) - Number(Boolean(left.immutableStorageKey)))
      .find((asset) => asset.status === "ready" && asset.url && asset.kind === "video")
      ?? [...beat.assets].sort((left, right) => Number(Boolean(right.immutableStorageKey)) - Number(Boolean(left.immutableStorageKey))).find((asset) => asset.status === "ready" && asset.url && asset.kind === "image");
    if (sourceAsset?.url) {
      if (sourceAsset.kind === "video" && sourceAsset.probe) {
        assertMediaCoversSlot(sourceAsset.probe.durationSeconds, (beat.endMs - beat.startMs) / 1_000);
      }
      video.push({
        id: `visual-${beat.id}`,
        trackId: "visual-main",
        kind: sourceAsset.kind === "video" ? "video" : "image",
        startMs: beat.startMs,
        endMs: beat.endMs,
        sourceUrl: sourceAsset.url,
        requestedDurationMs: beat.endMs - beat.startMs,
        actualDurationMs: sourceAsset.probe ? Math.round(sourceAsset.probe.durationSeconds * 1_000) : undefined,
        sourceInMs: 0,
        sourceOutMs: sourceAsset.probe ? Math.round(sourceAsset.probe.durationSeconds * 1_000) : undefined,
        usableInMs: 0,
        usableOutMs: sourceAsset.probe ? Math.round(sourceAsset.probe.durationSeconds * 1_000) : undefined,
        hold: false,
        transitionIn: { type: timelineTransitionType(beat.shotSpec?.transition), durationMs: beat.shotSpec?.transition === "dissolve" ? 180 : 0 },
        provenance: sourceAsset.provenance,
        probe: sourceAsset.probe,
        metadata: { beatId: beat.id, sceneId: beat.sceneId, kind: beat.kind, disclosure: beat.disclosure, shotSpec: beat.shotSpec, sequencePattern: beat.sequencePattern, contentSha256: sourceAsset.contentSha256 },
      });
    }
    graphics.push({
      id: `graphic-${beat.id}`,
      trackId: "graphics-main",
      kind: "graphic",
      startMs: beat.startMs,
      endMs: beat.endMs,
      sourceInMs: 0,
      usableInMs: 0,
      hold: beat.hold,
      transitionIn: { type: timelineTransitionType(beat.shotSpec?.transition), durationMs: beat.shotSpec?.transition === "dissolve" ? 180 : 0 },
      metadata: { beatId: beat.id, sceneId: beat.sceneId, title: storyboard.scenes.find((scene) => scene.id === beat.sceneId)?.title, kind: beat.kind, intent: beat.intent, graphicSpec: beat.graphicSpec, sourceVisual: beat.sourceVisual, motionCues: beat.motionCues, fullScreen: beat.fullScreen, sequencePattern: beat.sequencePattern },
    });
    if (beat.disclosure.required) disclosures.push({
      id: `disclosure-${beat.id}`,
      trackId: "disclosures",
      kind: "graphic",
      startMs: beat.startMs,
      endMs: beat.endMs,
      sourceInMs: 0,
      usableInMs: 0,
      hold: true,
      metadata: { label: beat.disclosure.label, persistent: beat.disclosure.persistent, publicFigures: beat.disclosure.publicFigures },
    });
  }
  storyboard.scenes.forEach((scene, index) => {
    const timing = plan.timingPlan?.scenes.find((candidate) => candidate.sceneId === scene.id);
    const targetDurationMs = timing ? timing.speechEndMs - timing.speechStartMs : scene.endMs - scene.startMs;
    const actualDurationMs = assets[index].narration.durationMs;
    narration.push({
      id: `narration-${scene.id}`,
      trackId: "narration-main",
      kind: "narration",
      startMs: timing?.speechStartMs ?? scene.startMs,
      endMs: timing?.speechEndMs ?? scene.endMs,
      sourceUrl: audioUrls[index],
      sourceInMs: 0,
      sourceOutMs: actualDurationMs,
      requestedDurationMs: targetDurationMs,
      actualDurationMs,
      usableInMs: 0,
      usableOutMs: actualDurationMs,
      hold: false,
      provenance: { origin: "generated", creator: "ElevenLabs", permittedUse: "Generated narration for this production", acquiredAt: new Date().toISOString(), transformations: actualDurationMs > targetDurationMs ? ["bounded tempo normalization", "loudness normalization"] : ["loudness normalization"], c2paValidated: false },
      metadata: { sceneId: scene.id, measuredSpeechStartMs: timing?.speechStartMs ?? scene.startMs, measuredSpeechEndMs: timing?.speechEndMs ?? scene.endMs, pauseAfterId: timing?.pauseAfterId },
    });
    const timingScale = targetDurationMs / Math.max(1, actualDurationMs);
    captionGroups(assets[index].narration.words).forEach((cue, cueIndex) => {
      const speechStartMs = timing?.speechStartMs ?? scene.startMs;
      const speechEndMs = timing?.speechEndMs ?? scene.endMs;
      const cueStart = Math.min(speechEndMs - 1, speechStartMs + Math.round(cue.startMs * timingScale));
      const cueEnd = Math.min(speechEndMs, Math.max(cueStart + 1, speechStartMs + Math.round(cue.endMs * timingScale)));
      captions.push({ id: `caption-${scene.id}-${cueIndex}`, trackId: "captions-main", kind: "caption", startMs: cueStart, endMs: cueEnd, sourceInMs: 0, usableInMs: 0, hold: false, metadata: { text: cue.text, sceneId: scene.id } });
    });
    if (scene.citationLabels.length > 0) citations.push({ id: `citation-${scene.id}`, trackId: "citations", kind: "graphic", startMs: scene.startMs, endMs: scene.endMs, sourceInMs: 0, usableInMs: 0, hold: true, metadata: { labels: scene.citationLabels, sourceIds: scene.sourceIds } });
  });
  const targetDurationMs = job.durationSeconds * 1_000;
  const music = scoreUrl ? [{
    id: "editorial-score",
    trackId: "music-main",
    kind: "music" as const,
    startMs: 0,
    endMs: targetDurationMs,
    sourceUrl: scoreUrl,
    sourceInMs: 0,
    requestedDurationMs: targetDurationMs,
    usableInMs: 0,
    hold: false,
    metadata: { mixRole: "ducked_editorial_score" },
  }] : [];
  const sfx = transitionSfxUrl ? storyboard.scenes.slice(1).map((scene, index) => ({
    id: `transition-sfx-${index + 1}`,
    trackId: "sfx-main",
    kind: "sfx" as const,
    startMs: scene.startMs,
    endMs: Math.min(targetDurationMs, scene.startMs + 240),
    sourceUrl: transitionSfxUrl,
    sourceInMs: 0,
    usableInMs: 0,
    hold: false,
    metadata: { mixRole: "restrained_editorial_transition" },
  })) : [];
  return {
    version: 2,
    productionId: job.id,
    contentType: job.contentType === "explainer" ? "explainer" : "news_digest",
    durationMs: targetDurationMs,
    fps: FPS,
    aspectRatio: job.aspectRatio,
    tracks: [
      { id: "visual-main", kind: "video", segments: video },
      { id: "graphics-main", kind: "graphics", segments: graphics },
      { id: "narration-main", kind: "narration", segments: narration },
      { id: "captions-main", kind: "captions", segments: captions },
      { id: "citations", kind: "graphics", segments: citations },
      { id: "disclosures", kind: "graphics", segments: disclosures },
      { id: "music-main", kind: "music", segments: music },
      { id: "sfx-main", kind: "sfx", segments: sfx },
    ],
    metadata: {
      measuredSpeechBounds: plan.timingPlan?.scenes.map((scene) => ({ sceneId: scene.sceneId, startMs: scene.speechStartMs, endMs: scene.speechEndMs })) ?? [],
      pauseIds: plan.timingPlan?.pauses.map((pause) => pause.id) ?? [],
      sourceFragmentIds: [...new Set(plan.beats.map((beat) => beat.sourceVisual?.fragmentId).filter((value): value is string => Boolean(value)))],
      excerptHashes: [...new Set(plan.beats.map((beat) => beat.sourceVisual?.excerptHash).filter((value): value is string => Boolean(value)))],
      graphicPayloads: Object.fromEntries(plan.beats.filter((beat) => beat.graphicSpec).map((beat) => [beat.id, beat.graphicSpec])),
      motionCues: Object.fromEntries(plan.beats.map((beat) => [beat.id, beat.motionCues])),
    },
    compiledAt: new Date().toISOString(),
  };
}

function captionGroups(words: WordTiming[]) {
  const groups: WordTiming[][] = [];
  let current: WordTiming[] = [];
  for (const word of words) {
    current.push(word);
    if (current.length >= 6 || /[.!?]$/.test(word.text)) { groups.push(current); current = []; }
  }
  if (current.length > 0) groups.push(current);
  return groups.map((group) => ({ text: group.map((word) => word.text).join(" "), startMs: group[0].startMs, endMs: group.at(-1)?.endMs ?? group[0].endMs }));
}

async function materializeBeat(
  beat: VisualBeat,
  job: VideoJob,
  storyboard: NewsStoryboard,
  sourcesById: Map<string, ProductionSource>,
  documentVisualCache: Map<string, Promise<Buffer>>,
): Promise<RenderBeat> {
  const scene = storyboard.scenes.find((candidate) => candidate.id === beat.sceneId);
  if (!scene) throw new Error(`Storyboard scene missing for visual beat ${beat.id}.`);
  const sourceTitles = new Map([...sourcesById].map(([id, source]) => [id, source.title]));
  const videoAsset = beat.assets.find((asset) => asset.status === "ready" && asset.kind === "video" && asset.url);
  const imageAsset = beat.assets.find((asset) => asset.status === "ready" && asset.kind === "image" && asset.url);
  if (videoAsset?.url) {
    const probe = await probeMediaUrl(videoAsset.url);
    const requestedSeconds = (beat.endMs - beat.startMs) / 1_000;
    const shortage = requestedSeconds - probe.durationSeconds;
    if (shortage > Math.max(0.25, requestedSeconds * 0.08)) throw new Error(`Visual asset for ${beat.id} does not cover its timeline slot.`);
    return { beat, base: await fetchMedia(videoAsset.url), baseType: "video", measuredDurationMs: Math.round(probe.durationSeconds * 1_000), overlay: await renderBeatOverlay(beat, scene, job, sourceTitles) };
  }
  if (imageAsset?.url) {
    return { beat, base: await fetchMedia(imageAsset.url), baseType: "image", overlay: await renderBeatOverlay(beat, scene, job, sourceTitles) };
  }
  if (beat.kind === "document_excerpt" || beat.kind === "documentary_source") {
    const documentSource = beat.sourceIds.map((sourceId) => sourcesById.get(sourceId)).find((source) => source?.kind === "document" && source.blobUrl);
    if (documentSource) {
      const pageNumber = sourcePageForBeat(job, beat, documentSource.id);
      const cacheKey = `${documentSource.id}:${pageNumber}`;
      const page = documentVisualCache.get(cacheKey) ?? renderProductionSourcePdfPage(documentSource, pageNumber);
      documentVisualCache.set(cacheKey, page);
      const { width, height } = dimensions(job.aspectRatio, job.qualityTier === "premium");
      return { beat, base: await fitEditorialDocumentPage(await page, width, height, job.visualPlan?.continuityKit.palette[0]), baseType: "image", overlay: await renderBeatOverlay(beat, scene, job, sourceTitles, true) };
    }
  }
  if (job.visualPlan?.version === 4 && (beat.kind === "document_excerpt" || beat.kind === "documentary_source" || beat.kind === "data_visualization")) {
    const validation = validateGraphicPayload(beat);
    if (!validation.valid) throw new Error(`Visual treatment unavailable for ${beat.id}: ${validation.reason}`);
  }
  const liveGenerationRequired = getProviderMode() === "live" && ["editorial_image", "cinematic_broll", "synthetic_reenactment", "composite"].includes(beat.kind);
  if (liveGenerationRequired) throw new Error(`Missing visual asset for approved cinematic beat ${beat.id}; Cocoa will not silently substitute a static card.`);
  return { beat, base: await renderBeatBackground(beat, scene, job), baseType: "image", overlay: await renderBeatOverlay(beat, scene, job, sourceTitles) };
}

function sourcePageForBeat(job: VideoJob, beat: VisualBeat, sourceId: string) {
  for (const claimId of beat.evidenceIds) {
    const claim = job.sourceBundle?.claims.find((candidate) => candidate.id === claimId);
    const page = claim?.evidenceRefs.find((evidence) => evidence.sourceId === sourceId && evidence.pageNumber)?.pageNumber;
    if (page) return page;
  }
  return 1;
}

async function renderBeatBackground(beat: VisualBeat, scene: NewsStoryboard["scenes"][number], job: VideoJob) {
  const { width, height } = dimensions(job.aspectRatio, job.qualityTier === "premium");
  const colors = job.visualPlan?.continuityKit.palette ?? ["#07110e", "#15233a", "#75eaa5", "#d9e3dd"];
  const { background, surface } = editorialSurfaceColors(colors);
  if (beat.sourceVisual && isLayeredEditorialCompositorEnabled()) {
    const metric = beat.graphicSpec && "values" in beat.graphicSpec ? beat.graphicSpec.values[0] : undefined;
    return sharp(outlineEditorialText(sourceCardSvg(beat.sourceVisual, scene.title, width, height, colors, metric))).png().toBuffer();
  }
  const nodes = Array.from({ length: 22 }, (_, index) => {
    const x = ((index * 137) % 1000) / 1000 * width;
    const y = ((index * 251 + beat.index * 83) % 1000) / 1000 * height;
    const r = 2 + (index % 5) * 1.4;
    return `<circle cx="${x}" cy="${y}" r="${r}" fill="${colors[2] ?? "#75eaa5"}" opacity="${0.08 + (index % 4) * 0.04}"/>`;
  }).join("");
  const chart = semanticGraphicSvg(beat, width, height, colors);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs>
      <radialGradient id="glow" cx="75%" cy="20%"><stop stop-color="${colors[2] ?? "#75eaa5"}" stop-opacity=".34"/><stop offset="1" stop-color="${colors[0] ?? "#07110e"}" stop-opacity="0"/></radialGradient>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${background}"/><stop offset=".55" stop-color="${surface}"/><stop offset="1" stop-color="#05070a"/></linearGradient>
      <filter id="blur"><feGaussianBlur stdDeviation="${height * 0.035}"/></filter>
    </defs>
    <rect width="100%" height="100%" fill="url(#bg)"/><rect width="100%" height="100%" fill="url(#glow)"/>
    <circle cx="${width * 0.79}" cy="${height * 0.27}" r="${height * 0.22}" fill="${colors[2] ?? "#75eaa5"}" opacity=".11" filter="url(#blur)"/>
    ${nodes}${chart}
    <rect x="${width * 0.07}" y="${height * 0.08}" width="${width * 0.86}" height="${height * 0.8}" rx="${height * 0.035}" fill="#ffffff" fill-opacity=".025" stroke="#ffffff" stroke-opacity=".09"/>
  </svg>`;
  return sharp(outlineEditorialText(svg)).png().toBuffer();
}

async function renderBeatOverlay(beat: VisualBeat, scene: NewsStoryboard["scenes"][number], job: VideoJob, sourceTitles: Map<string, string>, hasDocumentPage = false) {
  const { width, height } = dimensions(job.aspectRatio, job.qualityTier === "premium");
  const sourceLabel = scene.sourceIds.map((id) => sourceTitles.get(id) ?? id).slice(0, 2).join("  •  ");
  const kindLabel = job.contentType === "explainer" ? "EXPLAINED" : beatKindLabel(beat.kind);
  const accent = job.visualPlan?.continuityKit.palette[2] ?? "#75eaa5";
  const placement = height > width ? "left" : beat.graphicSpec?.overlayPlacement ?? (beat.index % 2 === 0 ? "left" : "right");
  const textX = placement === "right" ? width * 0.56 : width * 0.1;
  const ruleX = placement === "right" ? width * 0.525 : width * 0.065;
  const directedTitle = fitEditorialText(scene.title, width * .9 - textX, Math.min(width, height) * .057, 2, 700);
  const disclosure = beat.disclosure.required
    ? `<rect x="${width * 0.06}" y="${height * 0.055}" width="${width * 0.4}" height="${height * 0.048}" rx="${height * 0.012}" fill="#ffb85c" fill-opacity=".94"/><text x="${width * 0.08}" y="${height * 0.087}" fill="#11151a" font-family="Arial" font-size="${Math.round(height * 0.019)}" font-weight="800" letter-spacing="1">${escapeXml(beat.disclosure.label ?? "AI-GENERATED REENACTMENT")}</text>`
    : "";
  if (beat.sourceVisual) {
    const hasSourceCard = !hasDocumentPage && isLayeredEditorialCompositorEnabled()
      && !beat.assets.some((asset) => asset.status === "ready" && asset.url && (asset.kind === "image" || asset.kind === "video"));
    const citation = beat.sourceVisual.domain ?? (sourceLabel || "SUPPLIED SOURCE");
    const scale = Math.min(width, height);
    const portrait = height > width;
    const panelX = width * (portrait ? .1 : .53);
    const panelWidth = width * (portrait ? .8 : .37);
    const evidenceTitle = fitEditorialText(scene.title, panelWidth, scale * .046, 2, 700);
    const excerpt = fitEditorialText(beat.sourceVisual.excerpt, panelWidth, scale * .032, portrait ? 5 : 7);
    const citationText = fitEditorialText([...new Set([citation, beat.sourceVisual.locator])].join(" · "), width * .84, scale * .021, 1);
    const citedValues = beat.graphicSpec && "version" in beat.graphicSpec && "values" in beat.graphicSpec ? beat.graphicSpec.values : [];
    const metricPanel = citedValues.length > 0 && beat.assets.some((asset) => asset.status === "ready" && asset.url)
      ? `<rect x="${width * .54}" y="${height * .19}" width="${width * .36}" height="${height * .34}" rx="${height * .025}" fill="#07110e" fill-opacity=".93" stroke="#75eaa5" stroke-opacity=".65"/><text x="${width * .58}" y="${height * .25}" fill="#75eaa5" font-family="Arial" font-size="${Math.round(height * .018)}" font-weight="800" letter-spacing="2">CITED VALUE</text><text x="${width * .58}" y="${height * .39}" fill="#f4f7f5" font-family="Arial" font-size="${Math.round(height * .085)}" font-weight="850">${escapeXml(`${citedValues[0].value.toLocaleString()} ${citedValues[0].unit ?? ""}`.trim())}</text><text x="${width * .58}" y="${height * .465}" fill="#b8c7c0" font-family="Arial" font-size="${Math.round(height * .021)}">${escapeXml(citedValues[0].label)}</text>`
      : "";
    const evidencePanel = !hasSourceCard && citedValues.length === 0 && (hasDocumentPage || beat.kind === "composite")
      ? `<rect x="${panelX - width * .025}" y="${height * (portrait ? .49 : .14)}" width="${panelWidth + width * .05}" height="${height * (portrait ? .34 : .65)}" rx="${scale * .018}" fill="#07110e" fill-opacity=".9"/>
        ${editorialTextSvg(evidenceTitle, panelX, height * (portrait ? .535 : .23), "#f4f7f5", 700, 1.15)}
        ${editorialTextSvg(excerpt, panelX, height * (portrait ? .63 : .415), "#d9e3dd")}`
      : "";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      ${disclosure}
      ${evidencePanel}
      ${metricPanel}
      ${hasSourceCard ? "" : `<rect x="${width * 0.06}" y="${height * 0.9}" width="${width * 0.88}" height="${height * 0.052}" rx="${height * 0.012}" fill="#020607" fill-opacity=".76"/>
      ${editorialTextSvg(citationText, width * .08, height * .933, "#b8c7c0")}`}
    </svg>`;
    return sharp(outlineEditorialText(svg)).png().toBuffer();
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs><linearGradient id="shade" x1="0" y1="0" x2="0" y2="1"><stop offset=".35" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#020607" stop-opacity=".82"/></linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#shade)"/>
    ${disclosure}
    <rect x="${ruleX}" y="${height * 0.64}" width="${height * 0.008}" height="${height * 0.17}" rx="4" fill="${escapeXml(accent)}"/>
    <text x="${textX}" y="${height * 0.675}" fill="${escapeXml(accent)}" font-family="Arial" font-size="${Math.round(height * 0.018)}" font-weight="700" letter-spacing="3">${escapeXml(kindLabel)}</text>
    ${editorialTextSvg(directedTitle, textX, height * .725, "#f4f7f5", 700, 1.12)}
    <rect x="${width * 0.065}" y="${height * 0.91}" width="${width * 0.87}" height="${height * 0.052}" rx="${height * 0.016}" fill="#07110e" fill-opacity=".76" stroke="#ffffff" stroke-opacity=".12"/>
    ${editorialTextSvg(fitEditorialText(sourceLabel ? `Sources: ${sourceLabel}` : "Editorial visualization · Cocoa Director", width * .82, Math.min(width, height) * .021, 1), width * .085, height * .943, "#b8c7c0")}
  </svg>`;
  return sharp(outlineEditorialText(svg)).png().toBuffer();
}

async function renderEditorialAssets(videoId: string, job: VideoJob, beats: RenderBeat[], scenes: SceneAsset[], score: Buffer | undefined, transitionSfx: Buffer, captionsAss: string) {
  const { width, height } = dimensions(job.aspectRatio, job.qualityTier === "premium");
  const args: string[] = ["-y"];
  const files: Array<{ name: string; content: Buffer }> = [];
  beats.forEach((renderBeat, index) => {
    const baseName = `beat-${index}.${renderBeat.baseType === "video" ? "mp4" : "png"}`;
    const overlayName = `overlay-${index}.png`;
    if (renderBeat.baseType === "image") args.push("-loop", "1", "-framerate", String(FPS));
    args.push("-i", baseName, "-loop", "1", "-framerate", String(FPS), "-i", overlayName);
    files.push({ name: baseName, content: renderBeat.base }, { name: overlayName, content: renderBeat.overlay });
  });
  const narrationStartIndex = beats.length * 2;
  scenes.forEach((scene, index) => {
    const extension = scene.narration.contentType === "audio/mpeg" ? "mp3" : "wav";
    const name = `narration-${index}.${extension}`;
    args.push("-i", name);
    files.push({ name, content: scene.narration.audio });
  });
  const scoreIndex = narrationStartIndex + scenes.length;
  if (score) {
    args.push("-stream_loop", "-1", "-i", "score.mp3");
    files.push({ name: "score.mp3", content: score });
  }
  const sfxIndex = scoreIndex + (score ? 1 : 0);
  args.push("-i", "transition.wav");
  files.push({ name: "transition.wav", content: transitionSfx });
  files.push({ name: "captions.ass", content: Buffer.from(captionsAss) });
  files.push(...await Promise.all(renderFontFiles.map(async (font) => ({ name: `fonts/${font.name}`, content: await readFile(font.path) }))));
  const filters: string[] = [];
  beats.forEach((renderBeat, index) => {
    const frames = Math.max(1, Math.round((renderBeat.beat.endMs - renderBeat.beat.startMs) * FPS / 1_000));
    const durationSeconds = frames / FPS;
    const baseIndex = index * 2;
    const overlayIndex = baseIndex + 1;
    if (renderBeat.baseType === "video") {
      const sourceSeconds = Math.max(0.001, (renderBeat.measuredDurationMs ?? renderBeat.beat.endMs - renderBeat.beat.startMs) / 1_000);
      const retime = sourceSeconds < durationSeconds ? `setpts=${(durationSeconds / sourceSeconds).toFixed(6)}*PTS,` : "";
      filters.push(`[${baseIndex}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=${FPS},${retime}trim=end_frame=${frames},setpts=PTS-STARTPTS[base${index}]`);
    } else {
      const zoomStep = job.visualPlan?.resolvedPreset === "cinematic_social" ? "0.0014" : "0.0008";
      filters.push(`[${baseIndex}:v]scale=${Math.round(width * 1.1)}:${Math.round(height * 1.1)}:force_original_aspect_ratio=increase,crop=${Math.round(width * 1.1)}:${Math.round(height * 1.1)},zoompan=z='min(zoom+${zoomStep},1.10)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${width}x${height}:fps=${FPS},trim=end_frame=${frames},setpts=PTS-STARTPTS[base${index}]`);
    }
    const fadeOutStart = Math.max(0, durationSeconds - 0.18).toFixed(3);
    filters.push(`[${overlayIndex}:v]scale=${width}:${height},format=rgba,trim=duration=${durationSeconds.toFixed(6)},fade=t=in:st=0:d=0.18:alpha=1,fade=t=out:st=${fadeOutStart}:d=0.18:alpha=1,setpts=PTS-STARTPTS[overlay${index}]`);
    filters.push(`[base${index}][overlay${index}]overlay=shortest=1:format=auto,format=yuv420p[v${index}]`);
  });
  filters.push(`${beats.map((_, index) => `[v${index}]`).join("")}concat=n=${beats.length}:v=1:a=0[vraw]`);
  filters.push("[vraw]ass=captions.ass:fontsdir=fonts[v]");
  scenes.forEach((scene, index) => {
    const sceneId = job.storyboard?.scenes[index]?.id;
    const timing = job.visualPlan?.timingPlan?.scenes.find((candidate) => candidate.sceneId === sceneId);
    const targetSeconds = timing ? (timing.speechEndMs - timing.speechStartMs) / 1_000 : scene.targetDurationMs / 1_000;
    const actualSeconds = scene.narration.durationMs / 1_000;
    const tempo = Math.max(0.97, Math.min(1.03, actualSeconds / Math.max(0.001, targetSeconds)));
    const delayMs = timing?.speechStartMs ?? job.storyboard?.scenes[index]?.startMs ?? 0;
    filters.push(`[${narrationStartIndex + index}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=0:${actualSeconds.toFixed(6)},atempo=${tempo.toFixed(6)},adelay=${delayMs}|${delayMs},asetpts=PTS-STARTPTS[n${index}]`);
  });
  filters.push(`${scenes.map((_, index) => `[n${index}]`).join("")}amix=inputs=${scenes.length}:duration=longest:dropout_transition=0,loudnorm=I=-18:TP=-1.5:LRA=7[narr]`);
  const targetSeconds = job.durationSeconds.toFixed(6);
  const sfxStarts = (job.storyboard?.scenes ?? []).slice(1).map((scene) => scene.startMs);
  if (sfxStarts.length > 0) {
    filters.push(`[${sfxIndex}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asplit=${sfxStarts.length}${sfxStarts.map((_, index) => `[sfx${index}]`).join("")}`);
    sfxStarts.forEach((startMs, index) => filters.push(`[sfx${index}]adelay=${startMs}|${startMs},volume=0.24[sfxd${index}]`));
    filters.push(`${sfxStarts.map((_, index) => `[sfxd${index}]`).join("")}amix=inputs=${sfxStarts.length}:duration=longest:dropout_transition=0[sfxmix]`);
  }
  if (score) {
    filters.push(`[${scoreIndex}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=0:${targetSeconds},asetpts=PTS-STARTPTS,volume=0.16[music]`);
    filters.push("[narr]asplit=2[narr-sidechain][narr-mix]");
    filters.push("[music][narr-sidechain]sidechaincompress=threshold=0.025:ratio=10:attack=18:release=320[ducked]");
    filters.push("[narr-mix][ducked]amix=inputs=2:duration=longest:dropout_transition=0,atrim=0:" + targetSeconds + "[premix]");
  } else {
    filters.push(`[narr]apad,atrim=0:${targetSeconds}[premix]`);
  }
  filters.push(sfxStarts.length > 0
    ? "[premix][sfxmix]amix=inputs=2:duration=first:dropout_transition=0,loudnorm=I=-16:TP=-1.5:LRA=9[a]"
    : "[premix]loudnorm=I=-16:TP=-1.5:LRA=9[a]");
  args.push("-filter_complex", filters.join(";"), "-map", "[v]", "-map", "[a]", "-t", targetSeconds, "-r", String(FPS), "-c:v", "libx264", "-preset", "veryfast", "-crf", job.qualityTier === "premium" ? "18" : "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-metadata", `cocoa-video-id=${videoId}`, "-metadata", "cocoa-provenance=hybrid-editorial-v2", "-movflags", "+faststart", "final.mp4");
  const video = process.env.VERCEL === "1" ? await renderInSandbox(args, files) : await renderLocally(args, files);
  console.log(JSON.stringify({ event: "hybrid_editorial_render_succeeded", videoId, visualBeatCount: beats.length, layeredEditorial: isLayeredEditorialCompositorEnabled() }));
  return { video };
}

async function renderLocally(args: string[], files: Array<{ name: string; content: Buffer }>) {
  const directory = await mkdtemp(join(tmpdir(), "cocoa-editorial-render-"));
  await mkdir(join(directory, "fonts"));
  try {
    await Promise.all(files.map((file) => writeFile(join(directory, file.name), file.content)));
    await runCommand((await mediaTools()).ffmpeg, args, directory);
    return readFile(join(directory, "final.mp4"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function renderInSandbox(args: string[], files: Array<{ name: string; content: Buffer }>) {
  const credentials = process.env.VERCEL_TOKEN && process.env.VERCEL_TEAM_ID && process.env.VERCEL_PROJECT_ID
    ? { token: process.env.VERCEL_TOKEN, teamId: process.env.VERCEL_TEAM_ID, projectId: process.env.VERCEL_PROJECT_ID }
    : {};
  const workdir = "/vercel/sandbox/cocoa-editorial";
  await reserveProviderAttempt({ scope: "vercel:editorial-render", costCents: 50 });
  const sandbox = await Sandbox.create({ ...credentials, runtime: "node24", timeout: 1000 * 60 * 12, resources: { vcpus: 2 } });
  try {
    await prepareSandboxMediaTools(sandbox);
    await sandbox.mkDir(workdir);
    await sandbox.mkDir(`${workdir}/fonts`);
    await sandbox.writeFiles([
      { path: `${workdir}/media-tools.mjs`, content: await mediaToolsSource() },
      { path: `${workdir}/render.mjs`, content: sandboxScript(args) },
      ...files.map((file) => ({ path: `${workdir}/${file.name}`, content: file.content })),
    ]);
    await assertSandbox(sandbox, { cmd: "node", args: ["render.mjs"], cwd: workdir }, "Editorial renderer");
    const result = await sandbox.readFileToBuffer({ path: `${workdir}/final.mp4` });
    if (!result) throw new Error("Editorial renderer completed without final.mp4.");
    return result;
  } finally {
    await sandbox.stop().catch(() => undefined);
  }
}

function sandboxScript(args: string[]) {
  return `import { spawn } from "node:child_process"; import { installMediaTools } from "./media-tools.mjs"; const tools=await installMediaTools(); const args=${JSON.stringify(args)}; const child=spawn(tools.ffmpeg,args,{stdio:["ignore","inherit","inherit"]}); const code=await new Promise((resolve,reject)=>{child.on("error",reject);child.on("close",resolve)}); if(code!==0) throw new Error("ffmpeg exited "+code);`;
}

async function assertSandbox(sandbox: Awaited<ReturnType<typeof Sandbox.create>>, command: { cmd: string; args: string[]; cwd: string }, label: string) {
  const result = await sandbox.runCommand(command);
  if (result.exitCode === 0) return;
  const [stdout, stderr] = await Promise.all([result.stdout(), result.stderr()]);
  throw new Error(`${label} failed: ${(stderr || stdout).replace(/\s+/g, " ").slice(-2_000)}`);
}

function runCommand(command: string, args: string[], cwd: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
    let stderrHead = "";
    let stderrTail = "";
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      if (stderrHead.length < 8_000) stderrHead = (stderrHead + text).slice(0, 8_000);
      stderrTail = (stderrTail + text).slice(-12_000);
    });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Media process exceeded its time limit.")); }, 120_000);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", () => clearTimeout(timer));
    child.on("close", (code) => code === 0
      ? resolve()
      : reject(new Error(`Editorial FFmpeg render failed (${code}).\n${stderrHead}\n--- FFmpeg tail ---\n${stderrTail}`)));
  });
}

async function analyzeEditorialOutput(filePath: string, plan: HybridVisualPlanV2, scenes: SceneAsset[]) {
  const [videoLog, audioLog, dialogue] = await Promise.all([
    runCommandCapture((await mediaTools()).ffmpeg, ["-hide_banner", "-i", filePath, "-vf", "freezedetect=n=-60dB:d=0.134,blackdetect=d=0.1:pix_th=0.02:pic_th=0.99", "-an", "-f", "null", "-"]),
    runCommandCapture((await mediaTools()).ffmpeg, ["-hide_banner", "-i", filePath, "-af", "silencedetect=n=-50dB:d=0.5,ebur128=framelog=verbose", "-vn", "-f", "null", "-"]),
    analyzeNarrationAssets(scenes),
  ]);
  const freezeRuns = [...videoLog.matchAll(/freeze_start:\s*([0-9.]+)[\s\S]*?freeze_duration:\s*([0-9.]+)/g)].map((match) => ({ start: Number(match[1]), duration: Number(match[2]) }));
  const blackDurations = [...videoLog.matchAll(/black_duration:([0-9.]+)/g)].map((match) => Number(match[1]));
  const silenceDurations = [...audioLog.matchAll(/silence_duration:\s*([0-9.]+)/g)].map((match) => Number(match[1]));
  const loudnessMatches = [...audioLog.matchAll(/\bI:\s*(-?[0-9.]+)\s*LUFS/g)];
  const integratedLoudness = loudnessMatches.length > 0 ? Number(loudnessMatches.at(-1)?.[1]) : undefined;
  const shortTermMatches = [...audioLog.matchAll(/\bS:\s*(-?[0-9.]+)\s*LUFS/g)].map((match) => Number(match[1])).filter(Number.isFinite);
  const peakMatches = [...audioLog.matchAll(/\bPeak:\s*(-?[0-9.]+)\s*dBFS/g)].map((match) => Number(match[1])).filter(Number.isFinite);
  const truePeak = peakMatches.at(-1);
  const boundaries = new Set(plan.beats.slice(0, -1).map((beat) => beat.endMs / 1_000));
  const findings: NonNullable<VideoJob["qaReport"]>["findings"] = [];
  for (const run of freezeRuns.filter((candidate) => candidate.duration > 4 / FPS)) {
    const end = run.start + run.duration;
    const touchesBoundary = [...boundaries].some((boundary) => Math.abs(end - boundary) <= 2 / FPS || (run.start <= boundary && end >= boundary));
    const explicitHold = plan.beats.some((beat) => beat.hold && run.start >= beat.startMs / 1_000 - 0.05 && end <= beat.endMs / 1_000 + 0.05);
    if (explicitHold) continue;
    const informationalComposition = getProviderMode() === "mock" || plan.beats.some((beat) => ["documentary_source", "document_excerpt", "data_visualization"].includes(beat.kind) && run.start >= beat.startMs / 1_000 - 0.05 && end <= beat.endMs / 1_000 + 0.05);
    const severity = touchesBoundary && run.duration >= 0.5 && (!informationalComposition || run.duration > 3) ? "error" as const : "warning" as const;
    findings.push(audiovisualFinding(touchesBoundary ? "freeze.boundary" : "freeze.motion", severity, `Detected a ${run.duration.toFixed(3)}s near-identical-frame run${touchesBoundary ? " at an edit boundary" : ""}.`));
  }
  for (const duration of blackDurations.filter((value) => value > 0.1)) findings.push(audiovisualFinding("black.detected", "error", `Detected an unexplained ${duration.toFixed(3)}s black-frame run.`));
  for (const duration of silenceDurations.filter((value) => value > 1)) findings.push(audiovisualFinding("audio.silence", "warning", `Detected ${duration.toFixed(3)}s of silence.`));
  if (integratedLoudness !== undefined && (integratedLoudness < -18 || integratedLoudness > -10)) findings.push(audiovisualFinding("audio.loudness", "warning", `Integrated loudness is ${integratedLoudness.toFixed(1)} LUFS; target is -16 LUFS.`));
  if (truePeak !== undefined && truePeak > -1.5) findings.push(audiovisualFinding("audio.true_peak", "error", `True peak is ${truePeak.toFixed(1)} dBTP; maximum is -1.5 dBTP.`));
  if (getProviderMode() !== "mock" && dialogue.longestSilenceSeconds > 1.5) findings.push(audiovisualFinding("dialogue.silence", "error", `Narration contains an unapproved ${dialogue.longestSilenceSeconds.toFixed(2)}-second speech gap.`));
  return {
    findings,
    metrics: {
      freezeRunCount: freezeRuns.length,
      blackRunCount: blackDurations.length,
      silenceRunCount: silenceDurations.length,
      ...(integratedLoudness === undefined ? {} : { integratedLoudness }),
      ...(shortTermMatches.length === 0 ? {} : { maximumShortTermLoudness: Math.max(...shortTermMatches) }),
      ...(truePeak === undefined ? {} : { truePeak }),
      ...(dialogue.integratedLoudness === undefined ? {} : { dialogueIntegratedLoudness: dialogue.integratedLoudness }),
      dialogueLongestInternalSilenceMs: Math.round(dialogue.longestSilenceSeconds * 1_000),
      ...(plan.timingPlan ? { dialogueSpokenCoverage: plan.timingPlan.coverage.spokenCoverage, longestNarrationGapMs: Math.max(0, ...plan.timingPlan.pauses.map((pause) => pause.durationMs)) } : {}),
    },
  };
}

async function analyzeNarrationAssets(scenes: SceneAsset[]) {
  const directory = await mkdtemp(join(tmpdir(), "cocoa-dialogue-qa-"));
  try {
    const inputs = await Promise.all(scenes.map(async (scene, index) => {
      const extension = scene.narration.contentType === "audio/mpeg" ? "mp3" : "wav";
      const path = join(directory, `scene-${index}.${extension}`);
      await writeFile(path, scene.narration.audio);
      return path;
    }));
    const logs = await Promise.all(inputs.map(async (path) => runCommandCapture((await mediaTools()).ffmpeg, ["-hide_banner", "-i", path, "-af", "silencedetect=n=-50dB:d=0.1,ebur128=framelog=verbose", "-vn", "-f", "null", "-"])));
    const loudness = logs.map((log) => [...log.matchAll(/\bI:\s*(-?[0-9.]+)\s*LUFS/g)].at(-1)?.[1]).map(Number).filter(Number.isFinite);
    const silence = logs.flatMap((log) => [...log.matchAll(/silence_duration:\s*([0-9.]+)/g)].map((match) => Number(match[1]))).filter(Number.isFinite);
    const integratedLoudness = loudness.length === 0 ? undefined : 10 * Math.log10(loudness.reduce((sum, value) => sum + 10 ** (value / 10), 0) / loudness.length);
    return { integratedLoudness, longestSilenceSeconds: Math.max(0, ...silence) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function audiovisualFinding(code: string, severity: "warning" | "error", message: string) {
  return {
    id: `editorial-${code}-${Math.abs(hashString(message))}`,
    category: "audiovisual" as const,
    severity,
    code,
    message,
    retryable: code.startsWith("freeze"),
  };
}

function visualIntegrityFindings(job: VideoJob, plan: HybridVisualPlanV2) {
  const claims = new Map((job.sourceBundle?.claims ?? []).map((claim) => [claim.id, claim]));
  const generatedKinds = new Set(["editorial_image", "cinematic_broll", "synthetic_reenactment", "composite"]);
  const findings: NonNullable<VideoJob["qaReport"]>["findings"] = [];
  let supportedAssociations = 0;
  let totalAssociations = 0;
  for (const beat of plan.beats) {
    for (const claimId of beat.evidenceIds) {
      totalAssociations += 1;
      const claim = claims.get(claimId);
      if (job.contentType !== "news_digest" || claim?.status === "supported") supportedAssociations += 1;
      else findings.push({ id: `visual-claim-${beat.id}-${claimId}`, category: "factual", severity: "error", code: "visual.unsupported_claim", message: `Visual beat ${beat.id} is associated with an unsupported claim.`, segmentId: beat.id, startMs: beat.startMs, endMs: beat.endMs, retryable: false });
    }
    if (generatedKinds.has(beat.kind) && !beat.generationPrompt) findings.push({ id: `visual-prompt-${beat.id}`, category: "semantic", severity: "error", code: "visual.missing_direction", message: `Generated visual beat ${beat.id} has no approved generation direction.`, segmentId: beat.id, startMs: beat.startMs, endMs: beat.endMs, retryable: false });
    if (beat.kind === "synthetic_reenactment" && (!beat.disclosure.required || !beat.disclosure.persistent || beat.disclosure.label !== "AI-GENERATED REENACTMENT")) findings.push({ id: `visual-disclosure-${beat.id}`, category: "policy", severity: "error", code: "visual.disclosure_missing", message: `Synthetic reenactment ${beat.id} is missing its persistent disclosure.`, segmentId: beat.id, startMs: beat.startMs, endMs: beat.endMs, retryable: false });
    if (getProviderMode() === "live") {
      for (const asset of beat.assets.filter((candidate) => candidate.status === "ready" && (candidate.kind === "image" || candidate.kind === "video"))) {
        if (!asset.provenance) findings.push({ id: `visual-provenance-${asset.assetId ?? beat.id}`, category: "provenance", severity: "error", code: "visual.provenance_missing", message: `Generated asset for ${beat.id} is missing provider provenance.`, segmentId: beat.id, startMs: beat.startMs, endMs: beat.endMs, retryable: false });
      }
    }
  }
  return {
    findings,
    metrics: { visualClaimCoverage: totalAssociations === 0 ? 1 : supportedAssociations / totalAssociations },
  };
}

function runCommandCapture(command: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2_000_000); });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Media process exceeded its time limit.")); }, 120_000);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", () => clearTimeout(timer));
    child.on("close", (code) => code === 0 ? resolve(stderr) : reject(new Error(`Editorial audiovisual analysis failed (${code}): ${stderr.slice(-2_000)}`)));
  });
}

function hashString(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = (hash * 31 + value.charCodeAt(index)) | 0;
  return hash;
}

function buildSourceManifest(job: VideoJob, sources: Awaited<ReturnType<ReturnType<typeof getStore>["listProductionSources"]>>, timeline: TimelineManifestV2, visualPlan: HybridVisualPlanV2) {
  return {
    version: 2,
    productionId: job.id,
    asOf: job.sourceBundle?.asOf,
    generatedAt: new Date().toISOString(),
    sources: sources.map((source) => ({ ...source, blobUrl: undefined, downloadPath: source.kind === "document" ? `/api/projects/${job.projectId}/sources/${source.id}/download` : undefined })),
    claims: job.sourceBundle?.claims ?? [],
    sceneCitations: job.storyboard?.scenes.map((scene) => ({ sceneId: scene.id, sourceIds: scene.sourceIds, labels: scene.citationLabels })) ?? [],
    syntheticDisclosures: visualPlan.beats.filter((beat) => beat.disclosure.required).map((beat) => ({ beatId: beat.id, startMs: beat.startMs, endMs: beat.endMs, ...beat.disclosure })),
    visualAssets: visualPlan.beats.flatMap((beat) => beat.assets.map((asset) => ({ beatId: beat.id, kind: beat.kind, asset }))),
    timelineVersion: timeline.version,
    provenance: {
      editorialModel: process.env.OPENAI_AGENT_MODEL ?? "gpt-5.6-terra",
      factualAuditModel: process.env.OPENAI_FACTUAL_AUDIT_MODEL ?? "gpt-5.6-sol",
      narrationProvider: getProviderMode() === "live" ? "ElevenLabs" : "mock",
      graphicsRenderer: "Hybrid SVG/Sharp",
      finalAssembler: "FFmpeg",
      contentCredentialsState: "not_attached",
    },
  };
}

function humanReadableSourceManifest(manifest: ReturnType<typeof buildSourceManifest>) {
  return [
    "Cocoa Director source and disclosure manifest",
    `Production: ${manifest.productionId}`,
    `As of: ${manifest.asOf ?? "not supplied"}`,
    "",
    ...manifest.sources.map((source, index) => `${index + 1}. ${source.title}${source.url ? `\n   ${source.url}` : ""}\n   Rights: ${source.rights}`),
    "",
    "Synthetic disclosures",
    ...manifest.syntheticDisclosures.map((entry) => `- ${entry.beatId}: ${entry.label} (${entry.startMs}-${entry.endMs}ms)`),
  ].join("\n");
}

function hybridPlanFor(job: VideoJob, storyboard: NewsStoryboard): HybridVisualPlanV2 {
  if (isHybridVisualsV2Enabled() && job.visualPlan) return job.visualPlan;
  const beats = storyboard.scenes.map((scene): VisualBeat => ({
    id: `${scene.id}-legacy-beat`, sceneId: scene.id, index: 0, startMs: scene.startMs, endMs: scene.endMs,
    kind: scene.visualKind === "document" ? "document_excerpt" : "data_visualization", intent: scene.visual,
    evidenceIds: scene.claimIds, sourceIds: scene.sourceIds, motionDirection: "Slow deterministic parallax and dimensional information reveal.",
    providerRoute: { fallback: "review_required" }, disclosure: { required: false, persistent: false, publicFigures: [], currentEvent: false },
    costEstimateCents: 0, locked: false, hold: false, assets: [], motionCues: [], fullScreen: true, reusePolicy: { mode: "unique", approved: false, minimumSeparationMs: 30_000 },
  }));
  return {
    version: 2, productionId: job.id, contentType: job.contentType === "explainer" ? "explainer" : "news_digest",
    requestedPreset: "auto", resolvedPreset: "prestige_documentary", qualityTier: job.qualityTier ?? "draft",
    continuityKit: { palette: ["#07110e", "#15233a", "#75eaa5", "#d9e3dd"], lighting: "motivated documentary light", lensLanguage: "slow editorial parallax", texture: "fine grain and tactile surfaces", motifs: ["source lines"], transitionLanguage: "graphic matches", graphicLanguage: "clear cited typography" },
    beats,
    metrics: { cinematicCoverage: 0, staticCoverage: 0, cinematicBeatCount: 0, evidenceBeatCount: beats.length, estimatedCostCents: 0, predictedNarrationDurationMs: storyboard.scenes.reduce((sum, scene) => sum + estimateNarrationDuration(scene.narration), 0), targetDurationMs: job.durationSeconds * 1_000 },
    createdAt: new Date().toISOString(),
    chapters: [],
  };
}

export function assertNarrationFits(job: VideoJob, assets: SceneAsset[]) {
  const timing = editorialNarrationTiming(job);
  const budget = narrationBudgetSummary(assets.map((asset) => asset.narration.words.map((word) => word.text).join(" ")).join(" "), job.durationSeconds, timing.pacing);
  if (timing.measured && timing.requiresRevision) throw new Error(timing.revisionMessage);
  if (!timing.measured && !budget.withinBudget) throw new Error(`Narration duration budget failed: ${budget.words} words exceed the ${budget.budgetWords}-word target. Revise and reapprove the script.`);
  assets.forEach((asset, index) => {
    if (asset.narration.durationMs > asset.targetDurationMs * MAX_NARRATION_OVERRUN) {
      throw new Error(`Narration duration for scene ${index + 1} is ${(asset.narration.durationMs / 1_000).toFixed(1)}s for a ${(asset.targetDurationMs / 1_000).toFixed(1)}s slot. Revise and reapprove the script; Cocoa will not truncate narration.`);
    }
  });
}

function timelineToAss(timeline: TimelineManifestV2, aspectRatio: VideoJob["aspectRatio"]) {
  const dimensionsValue = dimensions(aspectRatio, false);
  const cues = captionSegments(timeline);
  const events = cues.map((cue) => `Dialogue: 0,${assTime(cue.startMs)},${assTime(cue.endMs)},Default,,0,0,0,,${escapeAss(String(cue.metadata.text ?? ""))}`).join("\n");
  const fontSize = aspectRatio === "9:16" ? 34 : 28;
  const marginV = aspectRatio === "9:16" ? 150 : 78;
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: ${dimensionsValue.width}\nPlayResY: ${dimensionsValue.height}\nWrapStyle: 0\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\nStyle: Default,Liberation Sans,${fontSize},&H00F5F7F3,&H000000FF,&H00101815,&H99040807,-1,0,0,0,100,100,0,0,3,1,0,2,70,70,${marginV},1\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n${events}\n`;
}

function assTime(milliseconds: number) {
  const totalCentiseconds = Math.max(0, Math.round(milliseconds / 10));
  const hours = Math.floor(totalCentiseconds / 360000);
  const minutes = Math.floor(totalCentiseconds / 6000) % 60;
  const seconds = Math.floor(totalCentiseconds / 100) % 60;
  const centiseconds = totalCentiseconds % 100;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(centiseconds).padStart(2, "0")}`;
}

function escapeAss(value: string) { return value.replace(/\\/g, "\\\\").replace(/[{}]/g, "").replace(/\n/g, "\\N"); }
function beatKindLabel(kind: VisualBeat["kind"]) { return ({ documentary_source: "DOCUMENTARY SOURCE", document_excerpt: "SOURCE DOCUMENT", data_visualization: "DATA & CONTEXT", editorial_image: "EDITORIAL ILLUSTRATION", cinematic_broll: "CINEMATIC CONTEXT", synthetic_reenactment: "SYNTHETIC REENACTMENT", composite: "CINEMATIC EXPLAINER" })[kind]; }
function semanticGraphicSvg(beat: VisualBeat, width: number, height: number, colors: string[]) {
  const accent = colors[2] ?? "#75eaa5";
  const warm = colors[3] ?? "#d8a75d";
  const family = beat.graphicSpec?.family ?? "process_flow";
  const values = beat.graphicSpec && "values" in beat.graphicSpec ? beat.graphicSpec.values : [];
  if (family === "hero_number" && values[0]) {
    const value = `${values[0].value.toLocaleString()}${values[0].unit ?? ""}`;
    return `<text x="${width * 0.12}" y="${height * 0.5}" fill="${accent}" font-family="Arial" font-size="${Math.round(height * 0.18)}" font-weight="800">${escapeXml(value)}</text><line x1="${width * 0.12}" y1="${height * 0.57}" x2="${width * 0.66}" y2="${height * 0.57}" stroke="${warm}" stroke-width="${height * 0.008}"/>`;
  }
  if ((family === "magnitude_comparison" || family === "ranking") && values.length > 0) {
    const maximum = Math.max(1, ...values.map((value) => Math.abs(value.value)));
    return values.slice(0, 5).map((value, index) => {
      const barWidth = width * 0.52 * Math.abs(value.value) / maximum;
      const y = height * (0.24 + index * 0.105);
      return `<text x="${width * 0.12}" y="${y - height * 0.012}" fill="#d9e3dd" font-size="${Math.round(height * 0.022)}" font-family="Arial">${escapeXml(value.label)}</text><rect x="${width * 0.12}" y="${y}" width="${barWidth}" height="${height * 0.052}" rx="${height * 0.012}" fill="${index % 2 ? warm : accent}" opacity=".82"/>`;
    }).join("");
  }
  if (family === "change_over_time" && values.length > 1) {
    const maximum = Math.max(1, ...values.map((value) => Math.abs(value.value)));
    const points = values.map((value, index) => `${width * (0.14 + index * 0.58 / Math.max(1, values.length - 1))},${height * (0.7 - 0.42 * Math.abs(value.value) / maximum)}`).join(" ");
    return `<polyline points="${points}" fill="none" stroke="${accent}" stroke-width="${height * 0.014}" stroke-linejoin="round"/>${points.split(" ").map((point) => { const [x, y] = point.split(","); return `<circle cx="${x}" cy="${y}" r="${height * 0.018}" fill="${warm}"/>`; }).join("")}`;
  }
  if (family === "part_to_whole" && values.length > 0) {
    const total = values.reduce((sum, value) => sum + Math.abs(value.value), 0) || 1;
    let offset = 0;
    return values.slice(0, 5).map((value, index) => {
      const portion = Math.abs(value.value) / total;
      const element = `<circle cx="${width * 0.4}" cy="${height * 0.43}" r="${height * 0.2}" fill="none" stroke="${index % 2 ? warm : accent}" stroke-width="${height * 0.065}" stroke-dasharray="${portion * 100} ${100 - portion * 100}" stroke-dashoffset="${-offset}" pathLength="100" transform="rotate(-90 ${width * 0.4} ${height * 0.43})"/>`;
      offset += portion * 100;
      return element;
    }).join("");
  }
  if (family === "source_excerpt") {
    return `<g transform="translate(${width * 0.17} ${height * 0.16}) rotate(-2)"><rect width="${width * 0.58}" height="${height * 0.55}" rx="${height * 0.018}" fill="#e9ece7" opacity=".92"/>${Array.from({ length: 9 }, (_, index) => `<rect x="${width * 0.055}" y="${height * (0.08 + index * 0.045)}" width="${width * (index === 3 ? 0.38 : 0.46)}" height="${height * 0.009}" fill="${index === 3 ? warm : "#23312d"}" opacity="${index === 3 ? .9 : .34}"/>`).join("")}</g>`;
  }
  if (family === "timeline") {
    return `<line x1="${width * 0.12}" y1="${height * 0.48}" x2="${width * 0.78}" y2="${height * 0.48}" stroke="${accent}" stroke-width="${height * 0.009}"/>${Array.from({ length: 4 }, (_, index) => `<circle cx="${width * (0.15 + index * 0.2)}" cy="${height * 0.48}" r="${height * 0.026}" fill="${index % 2 ? warm : accent}"/><line x1="${width * (0.15 + index * 0.2)}" y1="${height * 0.41}" x2="${width * (0.15 + index * 0.2)}" y2="${height * 0.55}" stroke="#fff" opacity=".28"/>`).join("")}`;
  }
  if (family === "geographic_map") {
    return `<path d="M ${width * .16} ${height * .3} L ${width * .31} ${height * .2} L ${width * .44} ${height * .28} L ${width * .59} ${height * .2} L ${width * .74} ${height * .34} L ${width * .67} ${height * .62} L ${width * .48} ${height * .7} L ${width * .26} ${height * .62} Z" fill="${accent}" opacity=".18" stroke="${accent}" stroke-width="${height * .008}"/>${Array.from({ length: 5 }, (_, index) => `<circle cx="${width * (.25 + index * .1)}" cy="${height * (.38 + (index % 2) * .13)}" r="${height * .018}" fill="${index % 2 ? warm : accent}"/>`).join("")}`;
  }
  if (family === "relationship_network") {
    const nodes = [[.2,.35],[.42,.22],[.64,.34],[.31,.62],[.58,.65]];
    return `${nodes.slice(1).map((node) => `<line x1="${width * nodes[0][0]}" y1="${height * nodes[0][1]}" x2="${width * node[0]}" y2="${height * node[1]}" stroke="${accent}" stroke-width="${height * .006}" opacity=".55"/>`).join("")}${nodes.map((node, index) => `<circle cx="${width * node[0]}" cy="${height * node[1]}" r="${height * (index === 0 ? .055 : .032)}" fill="${index % 2 ? warm : accent}"/>`).join("")}`;
  }
  return `<path d="M ${width * .12} ${height * .3} H ${width * .32} V ${height * .48} H ${width * .52} V ${height * .66} H ${width * .75}" fill="none" stroke="${accent}" stroke-width="${height * .014}" stroke-linejoin="round"/>${[[.12,.3],[.32,.48],[.52,.66],[.75,.66]].map(([x,y], index) => `<circle cx="${width * x}" cy="${height * y}" r="${height * .028}" fill="${index % 2 ? warm : accent}"/>`).join("")}`;
}
function completeDeliverySteps(steps: WorkflowStep[], completedAt: string): WorkflowStep[] {
  const ids = new Set(["narration", "timing_reconciliation", "imagery", "score", "generation", "visual_rough_cut_qa", "timeline", "preflight_qa", "qa", "review", "render", "final_qa"]);
  return steps.map((step): WorkflowStep => ids.has(step.id) ? { ...step, state: "complete", completedAt, error: undefined } : step);
}
function assertCurrentApprovals(job: VideoJob) { for (const gate of ["script", "storyboard"] as const) { const versionId = job.workflowSteps?.find((step) => step.id === gate)?.artifactVersionId; if (!versionId || !job.approvals?.some((approval) => approval.gate === gate && approval.artifactVersionId === versionId)) throw new Error(`Current ${gate} version has not been approved.`); } }
function assertVisualQualityApproved(job: VideoJob) {
  if ((job.visualPlan?.version ?? 2) < 3) return;
  const report = job.visualPlan?.qualityReport;
  if (!report?.passed) throw new Error("Visual rough-cut QA has not passed; timeline and render are blocked.");
  const keys = new Map<string, string[]>();
  for (const beat of job.visualPlan?.beats ?? []) {
    const asset = [...beat.assets].sort((left, right) => Number(Boolean(right.immutableStorageKey)) - Number(Boolean(left.immutableStorageKey))).find((candidate) => candidate.status === "ready" && (candidate.kind === "video" || candidate.kind === "image"));
    const key = asset?.contentSha256 ?? asset?.url;
    if (key) keys.set(key, [...(keys.get(key) ?? []), beat.id]);
  }
  const collision = [...keys.values()].find((beatIds) => beatIds.length > 1 && beatIds.some((beatId) => {
    const policy = job.visualPlan?.beats.find((beat) => beat.id === beatId)?.reusePolicy;
    return policy?.mode !== "motif_callback" || policy.approved !== true;
  }));
  if (collision) throw new Error(`Pre-render invariant failed: generated beats ${collision.join(", ")} resolve to the same asset.`);
}
function timelineTransitionType(transition?: string): "cut" | "crossfade" | "dip_to_color" | "graphic_match" {
  if (transition === "dissolve") return "crossfade";
  if (transition === "match_cut" || transition === "source_wipe") return "graphic_match";
  if (transition === "j_cut" || transition === "l_cut") return "dip_to_color";
  return "cut";
}
function captionSegments(timeline: TimelineManifestV2) { return timeline.tracks.filter((track) => track.kind === "captions").flatMap((track) => track.segments); }
function dimensions(aspectRatio: VideoJob["aspectRatio"], premium: boolean) { if (aspectRatio === "16:9") return premium ? { width: 1920, height: 1080 } : { width: 1280, height: 720 }; if (aspectRatio === "1:1") return { width: 1080, height: 1080 }; return premium ? { width: 1080, height: 1920 } : { width: 720, height: 1280 }; }
function escapeXml(value: string) { return value.replace(/[<>&"']/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[character] ?? character); }
function longestExplicitHold(plan: HybridVisualPlanV2) { return plan.beats.filter((beat) => beat.hold).reduce((longest, beat) => Math.max(longest, beat.endMs - beat.startMs), 0); }
async function fetchMedia(url: string) { const response = await fetchBlobUrl(url); if (!response.ok) throw new Error(`Could not fetch visual asset: HTTP ${response.status}`); return Buffer.from(await response.arrayBuffer()); }
export async function fitEditorialDocumentPage(page: Buffer, width: number, height: number, background = "#07110e") {
  // Keep the full source page in the evidence pane. Filling a widescreen frame by
  // cropping a portrait PDF can remove all of its text before the overlay is added.
  const portrait = height > width;
  const fitted = await sharp(page).resize(Math.round(width * (portrait ? .8 : .36)), Math.round(height * (portrait ? .34 : .72)), {
    fit: "inside", withoutEnlargement: false,
  }).png().toBuffer();
  return sharp({ create: { width, height, channels: 3, background } })
    .composite([{ input: fitted, left: Math.round(width * (portrait ? .1 : .08)), top: Math.round(height * .1) }]).png().toBuffer();
}

export async function compositeEditorialThumbnail(base: Buffer, overlay: Buffer) {
  const { width, height } = await sharp(overlay).metadata();
  if (!width || !height) throw new Error("Editorial overlay has no image dimensions.");
  // Provider images and PDF pages have their own dimensions; match the render canvas
  // before applying the full-frame overlay, just as the video compositor does.
  return sharp(base).resize(width, height, { fit: "cover" }).composite([{ input: overlay }]).png().toBuffer();
}

async function thumbnailFor(beat?: RenderBeat) {
  if (!beat) return sharp({ create: { width: 1280, height: 720, channels: 3, background: "#07110e" } }).png().toBuffer();
  return beat.baseType === "image" ? compositeEditorialThumbnail(beat.base, beat.overlay) : beat.overlay;
}

function silentWav(durationMs: number) {
  const sampleRate = 48_000; const channels = 2; const bytesPerSample = 2; const samples = Math.max(1, Math.round(sampleRate * durationMs / 1_000)); const dataSize = samples * channels * bytesPerSample; const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0); buffer.writeUInt32LE(36 + dataSize, 4); buffer.write("WAVEfmt ", 8); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(channels, 22); buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28); buffer.writeUInt16LE(channels * bytesPerSample, 32); buffer.writeUInt16LE(16, 34); buffer.write("data", 36); buffer.writeUInt32LE(dataSize, 40); return buffer;
}

function transitionSfxWav() {
  const sampleRate = 48_000;
  const durationSeconds = 0.24;
  const channels = 2;
  const samples = Math.round(sampleRate * durationSeconds);
  const dataSize = samples * channels * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0); buffer.writeUInt32LE(36 + dataSize, 4); buffer.write("WAVE", 8); buffer.write("fmt ", 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(channels, 22); buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * channels * 2, 28); buffer.writeUInt16LE(channels * 2, 32); buffer.writeUInt16LE(16, 34); buffer.write("data", 36); buffer.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < samples; index += 1) {
    const progress = index / samples;
    const envelope = Math.sin(Math.PI * progress) * Math.pow(1 - progress, 0.45);
    const frequency = 160 + progress * 720;
    const sample = Math.round(Math.sin(2 * Math.PI * frequency * index / sampleRate) * envelope * 4_500);
    buffer.writeInt16LE(sample, 44 + index * 4);
    buffer.writeInt16LE(sample, 46 + index * 4);
  }
  return buffer;
}
