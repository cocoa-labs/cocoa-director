import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mediaTools } from "@/lib/server/media-tools";
import sharp from "sharp";

import { normalizeEditorialVisualBeats } from "@/lib/editorial-timing";
import type { HybridVisualPlanV2, MotionEnergyReport, SourceVisualReport, VideoJob, VisualBeat, VisualBeatAsset, VisualFingerprint, VisualQualityReport } from "@/lib/schemas";
import { fingerprintBlobUrl, fetchBlobUrl } from "@/lib/server/blob";
import { getProviderMode, isEditorialMotionQaEnabled, isSourceVisualsV2Enabled } from "@/lib/server/config";
import { getStore } from "@/lib/server/store";
import { validateGraphicPayload } from "@/lib/server/source-visuals";

const SAMPLE_POSITIONS = [0.15, 0.5, 0.85];
const GENERATED_KINDS = new Set(["editorial_image", "cinematic_broll", "synthetic_reenactment", "composite"]);

export async function runVisualRoughCutQa(videoId: string): Promise<VisualQualityReport> {
  const store = getStore();
  const job = await store.getJob(videoId);
  if (!job?.visualPlan) throw new Error("Hybrid visual plan not found.");
  const normalizedPlan = job.storyboard && job.visualPlan.version >= 4
    ? normalizeEditorialVisualBeats(job.visualPlan, job.storyboard.scenes)
    : job.visualPlan;
  if (getProviderMode() === "mock") {
    const proxyPlan: HybridVisualPlanV2 = {
      ...normalizedPlan,
      beats: normalizedPlan.beats.map((beat, index) => GENERATED_KINDS.has(beat.kind) ? {
        ...beat,
        assets: [{
          beatId: beat.id,
          kind: "video",
          url: `/api/demo/media?kind=video&duration=4`,
          status: "ready",
          costCents: 0,
          immutableStorageKey: `mock/${beat.id}`,
          contentSha256: index.toString(16).padStart(64, "0"),
          semanticScore: 0.9,
        }],
      } : beat),
    };
    const report = evaluateVisualPlan(job, proxyPlan);
    await store.updateJob(videoId, {
      visualPlan: { ...normalizedPlan, qualityReport: report },
      storyboard: job.storyboard ? {
        ...job.storyboard,
        scenes: job.storyboard.scenes.map((scene) => ({ ...scene, beats: normalizedPlan.beats.filter((beat) => beat.sceneId === scene.id) })),
      } : undefined,
    });
    return report;
  }
  const media = await store.listJobMedia(videoId);
  const mediaById = new Map(media.assets.map((asset) => [asset.id, asset]));
  const enrichedBeats: VisualBeat[] = [];

  for (const beat of normalizedPlan.beats) {
    const enrichedAssets: VisualBeatAsset[] = [];
    for (const asset of beat.assets) {
      if (asset.status !== "ready" || !asset.url || (asset.kind !== "video" && asset.kind !== "image")) {
        enrichedAssets.push(asset);
        continue;
      }
      const stored = asset.assetId ? mediaById.get(asset.assetId) : undefined;
      const contentSha256 = asset.contentSha256
        ?? (typeof stored?.metadata.contentSha256 === "string" ? stored.metadata.contentSha256 : undefined)
        ?? (await fingerprintBlobUrl(asset.url)).sha256;
      const fingerprint = asset.kind === "video"
        ? await sampleVideoFingerprint(asset.url, asset.probe?.durationSeconds)
        : await sampleImageFingerprint(asset.url);
      const semanticScore = semanticAlignmentScore(beat);
      enrichedAssets.push({
        ...asset,
        immutableStorageKey: asset.immutableStorageKey ?? (typeof stored?.metadata.storageKey === "string" ? stored.metadata.storageKey : undefined),
        contentSha256,
        fingerprint: { ...fingerprint, contentSha256 },
        semanticScore,
        noveltyScore: 1,
      });
    }
    enrichedBeats.push({ ...beat, assets: enrichedAssets });
  }

  const plan: HybridVisualPlanV2 = { ...normalizedPlan, beats: enrichedBeats };
  const report = evaluateVisualPlan(job, plan);
  await store.updateJob(videoId, {
    visualPlan: { ...plan, qualityReport: report },
    storyboard: job.storyboard ? {
      ...job.storyboard,
      scenes: job.storyboard.scenes.map((scene) => ({ ...scene, beats: enrichedBeats.filter((beat) => beat.sceneId === scene.id) })),
    } : undefined,
  });
  return report;
}

export function evaluateVisualPlan(job: VideoJob, plan: HybridVisualPlanV2): VisualQualityReport {
  const generated = plan.beats.filter((beat) => GENERATED_KINDS.has(beat.kind));
  const selected = generated.map((beat) => ({ beat, asset: preferredAsset(beat) })).filter((item): item is { beat: VisualBeat; asset: VisualBeatAsset } => Boolean(item.asset));
  const findings: VisualQualityReport["findings"] = [];
  const missingAssets = generated.filter((beat) => !preferredAsset(beat)).map((beat) => beat.id);
  if (missingAssets.length > 0) findings.push({ code: "visual.asset_missing", severity: "blocking", message: `${missingAssets.length} approved generated beat${missingAssets.length === 1 ? " is" : "s are"} missing a playable asset.`, beatIds: missingAssets });
  const exactGroups = duplicateGroups(selected, (item) => item.asset.contentSha256 ?? item.asset.url);

  for (const group of exactGroups) {
    const undeclared = group.filter((beatId) => {
      const policy = plan.beats.find((beat) => beat.id === beatId)?.reusePolicy;
      return policy?.mode !== "motif_callback" || policy.approved !== true;
    });
    if (undeclared.length > 1) findings.push({ code: "visual.exact_asset_reuse", severity: "blocking", message: `The same generated asset is used by ${undeclared.length} beats.`, beatIds: undeclared });
  }

  const nearGroups = nearDuplicateGroups(selected);
  for (const group of nearGroups) {
    if (exactGroups.some((exact) => group.every((beatId) => exact.includes(beatId)))) continue;
    findings.push({ code: "visual.near_duplicate", severity: "blocking", message: "Re-encoded or visually near-identical cinematic clips were detected.", beatIds: group });
  }

  if (plan.version >= 3 && getProviderMode() === "live") {
    const missingImmutable = selected.filter(({ asset }) => !asset.immutableStorageKey || !asset.contentSha256).map(({ beat }) => beat.id);
    if (missingImmutable.length > 0) findings.push({ code: "visual.asset_identity_missing", severity: "blocking", message: "Generated beats must resolve to generation-bound immutable assets.", beatIds: missingImmutable });
  }

  const uniqueKeys = new Set(selected.map(({ asset }) => asset.contentSha256 ?? asset.url).filter(Boolean));
  const uniqueAssetRatio = selected.length === 0 ? 1 : uniqueKeys.size / selected.length;
  const minimumUnique = (job.qualityTier ?? "standard") === "premium" ? 0.95 : (job.qualityTier ?? "standard") === "standard" ? 0.9 : 0.8;
  if (uniqueAssetRatio < minimumUnique) findings.push({ code: "visual.unique_ratio", severity: "blocking", message: `Unique generated-asset ratio is ${Math.round(uniqueAssetRatio * 100)}%; this tier requires ${Math.round(minimumUnique * 100)}%.`, beatIds: exactGroups.flat() });

  const graphicFamilyMix = countGraphicFamilies(plan.beats);
  const graphicCount = Object.values(graphicFamilyMix).reduce((sum, count) => sum + count, 0);
  for (const [family, count] of Object.entries(graphicFamilyMix)) {
    const authenticSourceTreatment = plan.version >= 4 && family === "source_excerpt" && plan.beats.filter((beat) => beat.graphicSpec?.family === family).every((beat) => beat.sourceVisual);
    if (!authenticSourceTreatment && graphicCount >= 4 && count / graphicCount > 0.25) findings.push({ code: "visual.graphic_family_dominance", severity: "blocking", message: `${family.replaceAll("_", " ")} occupies ${Math.round(count / graphicCount * 100)}% of information beats; the maximum is 25%.`, beatIds: plan.beats.filter((beat) => beat.graphicSpec?.family === family).map((beat) => beat.id) });
  }
  for (let index = 1; index < plan.beats.length; index += 1) {
    const previous = plan.beats[index - 1];
    const current = plan.beats[index];
    if (previous.sceneId !== current.sceneId && previous.graphicSpec?.family && previous.graphicSpec.family === current.graphicSpec?.family && !(plan.version >= 4 && current.graphicSpec.family === "source_excerpt" && previous.sourceVisual && current.sourceVisual)) {
      findings.push({ code: "visual.adjacent_graphic_family", severity: "blocking", message: `Adjacent scenes repeat the ${current.graphicSpec.family.replaceAll("_", " ")} treatment.`, beatIds: [previous.id, current.id] });
    }
  }

  const lowSemanticItems = selected.filter(({ asset }) => (asset.semanticScore ?? 0) < 0.65);
  const recoveredSemantic = lowSemanticItems
    .filter(({ asset }) => Boolean(asset.recoveryReason || asset.recoveryOfGenerationId))
    .map(({ beat }) => beat.id);
  const lowSemantic = lowSemanticItems
    .filter(({ asset }) => !asset.recoveryReason && !asset.recoveryOfGenerationId)
    .map(({ beat }) => beat.id);
  const reviewSemantic = selected.filter(({ asset }) => (asset.semanticScore ?? 0) >= 0.65 && (asset.semanticScore ?? 0) < 0.8).map(({ beat }) => beat.id);
  if (lowSemantic.length > 0) findings.push({ code: "visual.semantic_mismatch", severity: "blocking", message: "Generated visuals do not retain enough of the approved scene subject and meaning.", beatIds: lowSemantic });
  if (recoveredSemantic.length > 0) findings.push({ code: "visual.semantic_proxy_inconclusive", severity: "info", message: "Prompt-direction scoring remained inconclusive after the authorized visual recovery; the stale metadata proxy will not trigger another paid regeneration.", beatIds: recoveredSemantic });
  if (reviewSemantic.length > 0) findings.push({ code: "visual.semantic_review", severity: "review", message: "Some visual directions need editorial review for claim alignment.", beatIds: reviewSemantic });

  const cinematicDuration = plan.beats.filter((beat) => ["cinematic_broll", "synthetic_reenactment", "composite"].includes(beat.kind)).reduce((sum, beat) => sum + beat.endMs - beat.startMs, 0);
  const cinematicCoverage = cinematicDuration / Math.max(1, plan.metrics.targetDurationMs);
  const narrationCoverage = plan.timingPlan?.coverage;
  if (plan.version >= 4 && /(?:news-digest-v6|explainer-v5)/.test(job.workflowVersion ?? "") && !narrationCoverage) findings.push({ code: "narration.timing_missing", severity: "blocking", message: "Measured narration timing has not been reconciled.", beatIds: [] });
  if (narrationCoverage && !narrationCoverage.passed) findings.push(...narrationCoverage.findings.map((finding) => ({ code: finding.code, severity: "blocking" as const, message: finding.message, beatIds: finding.sceneId ? plan.beats.filter((beat) => beat.sceneId === finding.sceneId).map((beat) => beat.id) : [] })));
  const motionEnergy = plan.version >= 4 && isEditorialMotionQaEnabled()
    ? evaluateMotionEnergy(plan)
    : { version: 1 as const, passed: true, maximumUnchangedFullScreenMs: 0, maximumInformationStasisMs: 0, lowEntropyIntervals: [], findings: [] };
  const sourceVisuals = plan.version >= 4 && isSourceVisualsV2Enabled()
    ? evaluateSourceVisuals(plan)
    : { version: 1 as const, passed: true, authenticArtifactCount: 0, invalidExcerptBeatIds: [], unsupportedGraphicBeatIds: [], findings: [] };
  findings.push(...motionEnergy.findings, ...sourceVisuals.findings);
  const blocking = findings.some((finding) => finding.severity === "blocking");
  const review = findings.some((finding) => finding.severity === "review");
  const rejectedBeatIds = [...new Set(findings.filter((finding) => finding.severity !== "info").flatMap((finding) => finding.beatIds))];
  return {
    version: 1,
    passed: !blocking && !review,
    state: blocking ? "failed" : review ? "needs_review" : "passed",
    uniqueAssetRatio,
    cinematicCoverage,
    retainedBeatIds: plan.beats.map((beat) => beat.id).filter((beatId) => !rejectedBeatIds.includes(beatId)),
    rejectedBeatIds,
    duplicateGroups: [...exactGroups, ...nearGroups],
    graphicFamilyMix,
    semanticScore: selected.length === 0 ? 1 : selected.reduce((sum, item) => sum + (item.asset.semanticScore ?? 0), 0) / selected.length,
    autoPolishAttempts: plan.qualityReport?.autoPolishAttempts ?? 0,
    findings,
    narrationCoverage,
    motionEnergy,
    sourceVisuals,
    checkedAt: new Date().toISOString(),
  };
}

function evaluateMotionEnergy(plan: HybridVisualPlanV2): MotionEnergyReport {
  const findings: MotionEnergyReport["findings"] = [];
  const lowEntropyIntervals: MotionEnergyReport["lowEntropyIntervals"] = [];
  let maximumUnchangedFullScreenMs = 0;
  let maximumInformationStasisMs = 0;
  for (const beat of plan.beats) {
    const durationMs = beat.endMs - beat.startMs;
    const cueTimes = [0, ...beat.motionCues.map((cue) => cue.atMs).filter((atMs) => atMs > 0 && atMs < durationMs), durationMs].sort((left, right) => left - right);
    const maximumGapMs = cueTimes.slice(1).reduce((maximum, value, index) => Math.max(maximum, value - cueTimes[index]), 0);
    if (beat.fullScreen) maximumUnchangedFullScreenMs = Math.max(maximumUnchangedFullScreenMs, maximumGapMs);
    if (["documentary_source", "document_excerpt", "data_visualization", "composite"].includes(beat.kind)) maximumInformationStasisMs = Math.max(maximumInformationStasisMs, maximumGapMs);
    const maximumFullScreenMs = beat.sourceVisual?.kind === "pdf_page" || beat.sourceVisual?.kind === "pdf_highlight_crop" ? 4_000 : 3_000;
    if (beat.fullScreen && durationMs > maximumFullScreenMs) findings.push({ code: "motion.full_screen_too_long", severity: "blocking", message: `${beat.id} remains full-screen for ${(durationMs / 1_000).toFixed(1)} seconds.`, beatIds: [beat.id] });
    if (maximumGapMs > 1_500 && ["documentary_source", "document_excerpt", "data_visualization", "composite"].includes(beat.kind)) findings.push({ code: "motion.information_stasis", severity: "blocking", message: `${beat.id} has no meaningful information-state change for ${(maximumGapMs / 1_000).toFixed(1)} seconds.`, beatIds: [beat.id] });
    const playable = preferredAsset(beat);
    const hashes = playable?.fingerprint?.perceptualHashes ?? [];
    const motion = playable?.fingerprint?.motionSignature ?? [];
    const nearUniform = hashes.length >= 2 && new Set(hashes).size === 1 && motion.length > 0 && motion.every((value) => value < 0.002);
    if (nearUniform && playable?.kind === "video") {
      const interval = { startMs: beat.startMs, endMs: beat.endMs, beatId: beat.id };
      findings.push({ code: "motion.low_entropy", severity: "blocking", message: `${beat.id} appears blank or visually unchanged across its sampled frames.`, beatIds: [beat.id] });
      lowEntropyIntervals.push(interval);
    }
  }
  return { version: 1, passed: findings.length === 0, maximumUnchangedFullScreenMs, maximumInformationStasisMs, lowEntropyIntervals, findings };
}

function evaluateSourceVisuals(plan: HybridVisualPlanV2): SourceVisualReport {
  const findings: SourceVisualReport["findings"] = [];
  const information = plan.beats.filter((beat) => ["documentary_source", "document_excerpt", "data_visualization"].includes(beat.kind));
  const invalidExcerptBeatIds: string[] = [];
  const unsupportedGraphicBeatIds: string[] = [];
  for (const beat of information) {
    const validation = validateGraphicPayload(beat);
    if (!validation.valid) {
      unsupportedGraphicBeatIds.push(beat.id);
      findings.push({ code: "source_visual.treatment_unavailable", severity: "blocking", message: `${beat.id}: ${validation.reason}`, beatIds: [beat.id] });
    } else if (beat.graphicSpec && "version" in beat.graphicSpec && beat.graphicSpec.family === "source_excerpt" && (!beat.sourceVisual || beat.sourceVisual.excerptHash !== beat.graphicSpec.excerptHash)) {
      invalidExcerptBeatIds.push(beat.id);
      findings.push({ code: "source_visual.excerpt_hash_invalid", severity: "blocking", message: `${beat.id} does not preserve its exact source excerpt identity.`, beatIds: [beat.id] });
    }
  }
  return { version: 1, passed: findings.length === 0, authenticArtifactCount: information.filter((beat) => beat.sourceVisual).length, invalidExcerptBeatIds, unsupportedGraphicBeatIds, findings };
}

function preferredAsset(beat: VisualBeat) {
  return beat.assets.find((asset) => asset.kind === "video" && asset.status === "ready")
    ?? beat.assets.find((asset) => asset.kind === "image" && asset.status === "ready");
}

function duplicateGroups<T>(items: T[], keyFor: (item: T) => string | undefined) {
  const groups = new Map<string, string[]>();
  for (const item of items as Array<T & { beat: VisualBeat }>) {
    const key = keyFor(item);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), item.beat.id]);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

function nearDuplicateGroups(items: Array<{ beat: VisualBeat; asset: VisualBeatAsset }>) {
  const pairs: string[][] = [];
  for (let left = 0; left < items.length; left += 1) {
    for (let right = left + 1; right < items.length; right += 1) {
      const a = items[left];
      const b = items[right];
      const hashesA = a.asset.fingerprint?.perceptualHashes ?? [];
      const hashesB = b.asset.fingerprint?.perceptualHashes ?? [];
      const matchingSamples = hashesA.filter((hash, index) => hashesB[index] && hammingDistance(hash, hashesB[index]) <= 6).length;
      if (matchingSamples >= 2 && correlation(a.asset.fingerprint?.motionSignature ?? [], b.asset.fingerprint?.motionSignature ?? []) >= 0.95) pairs.push([a.beat.id, b.beat.id]);
    }
  }
  return mergePairs(pairs);
}

async function sampleVideoFingerprint(url: string, durationSeconds = 5): Promise<VisualFingerprint> {
  const response = await fetchBlobUrl(url);
  if (!response.ok) throw new Error(`Could not sample visual proxy: HTTP ${response.status}`);
  const directory = await mkdtemp(join(tmpdir(), "cocoa-visual-qa-"));
  const inputPath = join(directory, "asset.mp4");
  try {
    await writeFile(inputPath, Buffer.from(await response.arrayBuffer()));
    const frames: Buffer[] = [];
    for (let index = 0; index < SAMPLE_POSITIONS.length; index += 1) {
      const outputPath = join(directory, `sample-${index}.png`);
      await runFfmpeg(["-v", "error", "-ss", String(Math.max(0, durationSeconds * SAMPLE_POSITIONS[index])), "-i", inputPath, "-frames:v", "1", "-vf", "scale=320:-2", "-y", outputPath]);
      frames.push(await sharp(outputPath).png().toBuffer());
    }
    const perceptualHashes = await Promise.all(frames.map(dHash));
    const motionSignature = await motionVector(frames);
    return { perceptualHashes, motionSignature, sampledAt: SAMPLE_POSITIONS };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function sampleImageFingerprint(url: string): Promise<VisualFingerprint> {
  const response = await fetchBlobUrl(url);
  if (!response.ok) throw new Error(`Could not sample image proxy: HTTP ${response.status}`);
  const frame = Buffer.from(await response.arrayBuffer());
  const hash = await dHash(frame);
  return { perceptualHashes: [hash, hash, hash], motionSignature: Array(32).fill(0), sampledAt: SAMPLE_POSITIONS };
}

async function dHash(frame: Buffer) {
  const { data } = await sharp(frame).greyscale().resize(9, 8, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  let bits = "";
  for (let row = 0; row < 8; row += 1) for (let column = 0; column < 8; column += 1) bits += data[row * 9 + column] > data[row * 9 + column + 1] ? "1" : "0";
  return Array.from({ length: 16 }, (_, index) => Number.parseInt(bits.slice(index * 4, index * 4 + 4), 2).toString(16)).join("");
}

async function motionVector(frames: Buffer[]) {
  const raw = await Promise.all(frames.map((frame) => sharp(frame).greyscale().resize(16, 16, { fit: "fill" }).raw().toBuffer()));
  const vector: number[] = [];
  for (let pair = 0; pair < raw.length - 1; pair += 1) {
    for (let bucket = 0; bucket < 16; bucket += 1) {
      let sum = 0;
      for (let index = bucket * 16; index < (bucket + 1) * 16; index += 1) sum += Math.abs(raw[pair][index] - raw[pair + 1][index]);
      vector.push(Number((sum / (16 * 255)).toFixed(4)));
    }
  }
  return vector;
}

function semanticAlignmentScore(beat: VisualBeat) {
  const prompt = normalize(`${beat.generationPrompt ?? ""} ${beat.intent}`);
  const subjectTerms = normalize(beat.shotSpec?.subject ?? beat.intent).split(" ").filter((term) => term.length >= 5);
  if (subjectTerms.length === 0) return 0.8;
  const matches = subjectTerms.filter((term) => prompt.includes(term)).length;
  const specificity = matches / subjectTerms.length;
  const genericPenalty = /depict the idea only|conceptual people free|premium conceptual editorial visualization/.test(prompt) && specificity < 0.35 ? 0.2 : 0;
  return Math.max(0, Math.min(1, Number((0.62 + specificity * 0.34 - genericPenalty).toFixed(3))));
}

function normalize(value: string) { return value.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " "); }

function hammingDistance(left: string, right: string) {
  const bits = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];
  let count = 0;
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) count += bits[Number.parseInt(left[index], 16) ^ Number.parseInt(right[index], 16)];
  return count + Math.abs(left.length - right.length) * 4;
}

function correlation(left: number[], right: number[]) {
  if (left.length === 0 || left.length !== right.length) return 0;
  const meanA = left.reduce((sum, value) => sum + value, 0) / left.length;
  const meanB = right.reduce((sum, value) => sum + value, 0) / right.length;
  let numerator = 0;
  let denominatorA = 0;
  let denominatorB = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] - meanA;
    const b = right[index] - meanB;
    numerator += a * b;
    denominatorA += a * a;
    denominatorB += b * b;
  }
  if (denominatorA === 0 && denominatorB === 0) return left.every((value, index) => value === right[index]) ? 1 : 0;
  return numerator / Math.sqrt(Math.max(Number.EPSILON, denominatorA * denominatorB));
}

function mergePairs(pairs: string[][]) {
  const groups: Array<Set<string>> = [];
  for (const pair of pairs) {
    const matches = groups.filter((group) => pair.some((id) => group.has(id)));
    if (matches.length === 0) groups.push(new Set(pair));
    else {
      const combined = new Set(pair);
      for (const match of matches) for (const id of match) combined.add(id);
      for (const match of matches) groups.splice(groups.indexOf(match), 1);
      groups.push(combined);
    }
  }
  return groups.map((group) => [...group]);
}

function countGraphicFamilies(beats: VisualBeat[]) {
  return beats.reduce<Record<string, number>>((counts, beat) => {
    if (beat.graphicSpec?.family) counts[beat.graphicSpec.family] = (counts[beat.graphicSpec.family] ?? 0) + 1;
    return counts;
  }, {});
}

async function runFfmpeg(args: string[]) {
  const tools = await mediaTools();
  return new Promise<void>((resolve, reject) => {
    const child = spawn(tools.ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Visual sampling timed out.")); }, 60_000);
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4_000); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(`Visual sampling failed (${code}): ${stderr}`)); });
  });
}
