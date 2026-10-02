import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { mediaTools } from "@/lib/server/media-tools";

import type { BeatGrid, MusicPlan, MusicTrack } from "@/lib/schemas";
import { fetchBlobUrl } from "@/lib/server/blob";

const ANALYSIS_SAMPLE_RATE = 22_050;
const ANALYSIS_HOP_SIZE = 512;
const MAX_AUDIO_BYTES = 200 * 1024 * 1024;

export type PcmBeatAnalysis = {
  bpm: number;
  beatDurationMs: number;
  phaseMs: number;
  confidence: number;
  onsetTimesMs: number[];
};

export async function extractBeatGrid(track: MusicTrack, plan: MusicPlan): Promise<BeatGrid> {
  try {
    const pcm = await decodeTrackToMonoPcm(track.url);
    const analysis = analyzePcmBeats(pcm, ANALYSIS_SAMPLE_RATE, plan.bpm);
    if (analysis.onsetTimesMs.length < 4 || analysis.confidence < 0.12) {
      throw new Error("Audio analysis did not find a stable onset pattern.");
    }
    return gridFromAnalysis(track, plan, analysis);
  } catch (error) {
    console.warn(JSON.stringify({
      event: "beat_analysis_fallback",
      videoId: track.videoId,
      reason: error instanceof Error ? error.message : "Unknown beat-analysis error",
    }));
    return plannedFallbackGrid(track, plan);
  }
}

export function analyzePcmBeats(
  samples: Float32Array,
  sampleRate: number,
  bpmHint = 120,
): PcmBeatAnalysis {
  if (samples.length < sampleRate) throw new Error("At least one second of PCM audio is required.");
  const hopSize = Math.max(128, Math.round((ANALYSIS_HOP_SIZE * sampleRate) / ANALYSIS_SAMPLE_RATE));
  const windowSize = hopSize * 2;
  const envelope: number[] = [];
  let previousEnergy = 0;

  for (let start = 0; start + windowSize <= samples.length; start += hopSize) {
    let sumSquares = 0;
    for (let index = start; index < start + windowSize; index += 1) {
      const sample = samples[index];
      sumSquares += sample * sample;
    }
    const energy = Math.log1p(Math.sqrt(sumSquares / windowSize) * 80);
    envelope.push(Math.max(0, energy - previousEnergy));
    previousEnergy = previousEnergy * 0.65 + energy * 0.35;
  }

  const frameMs = (hopSize / sampleRate) * 1_000;
  const medianValue = median(envelope);
  const deviation = median(envelope.map((value) => Math.abs(value - medianValue)));
  const threshold = medianValue + Math.max(0.015, deviation * 2.5);
  const minimumPeakFrames = Math.max(1, Math.round(120 / frameMs));
  const peakFrames: number[] = [];
  let lastPeak = -minimumPeakFrames;
  for (let index = 1; index < envelope.length - 1; index += 1) {
    const value = envelope[index];
    if (
      value >= threshold &&
      value >= envelope[index - 1] &&
      value > envelope[index + 1] &&
      index - lastPeak >= minimumPeakFrames
    ) {
      peakFrames.push(index);
      lastPeak = index;
    }
  }

  const onsetTimesMs = peakFrames.map((frame) => frame * frameMs);
  const bpm = estimateBpm(envelope, frameMs, bpmHint, onsetTimesMs);
  const beatDurationMs = 60_000 / bpm;
  const phaseMs = estimatePhase(onsetTimesMs, envelope, frameMs, beatDurationMs);
  const periodicity = periodicityScore(envelope, Math.round(beatDurationMs / frameMs));
  const densityScore = Math.min(1, onsetTimesMs.length / Math.max(4, samples.length / sampleRate / 2));
  const confidence = clamp01(periodicity * 0.75 + densityScore * 0.25);
  return { bpm, beatDurationMs, phaseMs, confidence, onsetTimesMs };
}

export function medianOnsetOffsetMs(events: BeatGrid["events"], onsetTimesMs: number[]) {
  const beats = events.filter((event) => event.type === "beat" || event.type === "downbeat");
  if (beats.length === 0 || onsetTimesMs.length === 0) return undefined;
  return median(onsetTimesMs.map((onset) => {
    let closest = Number.POSITIVE_INFINITY;
    for (const beat of beats) closest = Math.min(closest, Math.abs(beat.timeMs - onset));
    return closest;
  }));
}

function gridFromAnalysis(track: MusicTrack, plan: MusicPlan, analysis: PcmBeatAnalysis): BeatGrid {
  const durationMs = Math.round(track.durationSeconds * 1_000);
  const sectionStarts = sectionStartEvents(plan, durationMs);
  const events: BeatGrid["events"] = [...sectionStarts];
  let beatIndex = 0;
  let beatTime = analysis.phaseMs;
  while (beatTime - analysis.beatDurationMs >= 0) beatTime -= analysis.beatDurationMs;
  while (beatTime < 0) beatTime += analysis.beatDurationMs;
  for (; beatTime <= durationMs; beatTime += analysis.beatDurationMs) {
    const roundedTime = Math.round(beatTime);
    const sectionId = sectionAt(sectionStarts, roundedTime);
    const nearestOnset = nearestDistance(analysis.onsetTimesMs, roundedTime);
    const strength = nearestOnset <= 80 ? 0.95 : nearestOnset <= 150 ? 0.75 : 0.55;
    events.push({
      timeMs: roundedTime,
      type: beatIndex % 4 === 0 ? "downbeat" : "beat",
      strength,
      sectionId,
    });
    beatIndex += 1;
  }
  const offset = medianOnsetOffsetMs(events, analysis.onsetTimesMs);
  return {
    videoId: track.videoId,
    bpm: Number(analysis.bpm.toFixed(2)),
    source: "audio_analysis",
    analysis: {
      confidence: Number(analysis.confidence.toFixed(3)),
      onsetCount: analysis.onsetTimesMs.length,
      medianOnsetOffsetMs: offset === undefined ? undefined : Number(offset.toFixed(2)),
      analyzedAt: new Date().toISOString(),
    },
    events: events.sort((left, right) => left.timeMs - right.timeMs || priority(left.type) - priority(right.type)),
  };
}

function plannedFallbackGrid(track: MusicTrack, plan: MusicPlan): BeatGrid {
  const beatDurationMs = 60_000 / plan.bpm;
  const durationMs = Math.round(track.durationSeconds * 1_000);
  const sectionStarts = sectionStartEvents(plan, durationMs);
  const events: BeatGrid["events"] = [...sectionStarts];
  for (let index = 0, timeMs = 0; timeMs <= durationMs; index += 1, timeMs += beatDurationMs) {
    events.push({
      timeMs: Math.round(timeMs),
      type: index % 4 === 0 ? "downbeat" : "beat",
      strength: index % 4 === 0 ? 0.9 : 0.6,
      sectionId: sectionAt(sectionStarts, timeMs),
    });
  }
  return {
    videoId: track.videoId,
    bpm: plan.bpm,
    source: "plan_fallback",
    events: events.sort((left, right) => left.timeMs - right.timeMs || priority(left.type) - priority(right.type)),
  };
}

async function decodeTrackToMonoPcm(url: string) {
  const response = await fetchBlobUrl(url);
  if (!response.ok) throw new Error(`Could not fetch the rendered track: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_AUDIO_BYTES) throw new Error("Rendered track is too large for beat analysis.");
  const directory = await mkdtemp(join(tmpdir(), "cocoa-beats-"));
  const inputPath = join(directory, "track.audio");
  try {
    await writeFile(inputPath, bytes);
    const raw = await runFfmpegToBuffer([
      "-hide_banner", "-loglevel", "error", "-i", inputPath,
      "-vn", "-ac", "1", "-ar", String(ANALYSIS_SAMPLE_RATE),
      "-f", "f32le", "pipe:1",
    ]);
    const pcm = new Float32Array(Math.floor(raw.length / 4));
    for (let index = 0; index < pcm.length; index += 1) pcm[index] = raw.readFloatLE(index * 4);
    return pcm;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function runFfmpegToBuffer(args: string[]) {
  const tools = await mediaTools();
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(tools.ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";
    let byteLength = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      byteLength += chunk.byteLength;
      if (byteLength > MAX_AUDIO_BYTES) { child.kill("SIGKILL"); reject(new Error("Decoded audio exceeds the analysis limit.")); return; }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-12_000); });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Media process exceeded its time limit.")); }, 120_000);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", () => clearTimeout(timer));
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`Audio decode failed with code ${code ?? "unknown"}: ${stderr}`));
    });
  });
}

function estimateBpm(envelope: number[], frameMs: number, bpmHint: number, onsetTimesMs: number[]) {
  let bestBpm = clampBpm(bpmHint);
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let bpm = 60; bpm <= 180; bpm += 0.5) {
    const lag = Math.max(1, Math.round((60_000 / bpm) / frameMs));
    const correlation = periodicityScore(envelope, lag);
    const hintDistance = Math.abs(Math.log2(bpm / clampBpm(bpmHint)));
    const score = correlation * (1 - Math.min(0.22, hintDistance * 0.16));
    if (score > bestScore) {
      bestScore = score;
      bestBpm = bpm;
    }
  }
  const bestPeriodicity = periodicityScore(envelope, Math.round((60_000 / bestBpm) / frameMs));
  for (const harmonic of [bestBpm * 2, bestBpm / 2]) {
    if (harmonic < 60 || harmonic > 180) continue;
    const harmonicPeriodicity = periodicityScore(envelope, Math.round((60_000 / harmonic) / frameMs));
    const harmonicIsCloserToHint = Math.abs(Math.log2(harmonic / bpmHint)) < Math.abs(Math.log2(bestBpm / bpmHint));
    if (harmonicIsCloserToHint && harmonicPeriodicity >= bestPeriodicity * 0.82) bestBpm = harmonic;
  }
  if (onsetTimesMs.length >= 4) {
    const intervals = onsetTimesMs.slice(1)
      .map((time, index) => time - onsetTimesMs[index])
      .filter((interval) => interval >= 250 && interval <= 1_000);
    const center = median(intervals);
    const inliers = intervals.filter((interval) => Math.abs(interval - center) <= center * 0.2);
    const representativeInterval = inliers.reduce((sum, interval) => sum + interval, 0) / Math.max(1, inliers.length);
    const intervalBpm = 60_000 / representativeInterval;
    if (
      Number.isFinite(intervalBpm) &&
      intervalBpm >= 60 &&
      intervalBpm <= 180 &&
      Math.abs(Math.log2(intervalBpm / bpmHint)) < Math.abs(Math.log2(bestBpm / bpmHint))
    ) {
      bestBpm = intervalBpm;
    }
  }
  return bestBpm;
}

function periodicityScore(envelope: number[], lag: number) {
  if (lag <= 0 || lag >= envelope.length) return 0;
  let product = 0;
  let leftEnergy = 0;
  let rightEnergy = 0;
  for (let index = lag; index < envelope.length; index += 1) {
    const left = envelope[index];
    const right = envelope[index - lag];
    product += left * right;
    leftEnergy += left * left;
    rightEnergy += right * right;
  }
  return product / Math.max(1e-9, Math.sqrt(leftEnergy * rightEnergy));
}

function estimatePhase(onsets: number[], envelope: number[], frameMs: number, beatDurationMs: number) {
  if (onsets.length === 0) return 0;
  let bestPhase = onsets[0] % beatDurationMs;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const onset of onsets.slice(0, 80)) {
    const phase = ((onset % beatDurationMs) + beatDurationMs) % beatDurationMs;
    let score = 0;
    for (let time = phase; time < envelope.length * frameMs; time += beatDurationMs) {
      score += envelope[Math.min(envelope.length - 1, Math.round(time / frameMs))] ?? 0;
    }
    if (score > bestScore) {
      bestScore = score;
      bestPhase = phase;
    }
  }
  return bestPhase;
}

function sectionStartEvents(plan: MusicPlan, durationMs: number): BeatGrid["events"] {
  const events: BeatGrid["events"] = [];
  let cursorMs = 0;
  for (const section of plan.sections) {
    if (cursorMs > durationMs) break;
    events.push({ timeMs: cursorMs, type: "section_change", strength: 1, sectionId: section.id });
    cursorMs += section.durationSeconds * 1_000;
  }
  return events;
}

function sectionAt(sectionStarts: BeatGrid["events"], timeMs: number) {
  let sectionId = sectionStarts[0]?.sectionId ?? "music";
  for (const section of sectionStarts) {
    if (section.timeMs > timeMs) break;
    sectionId = section.sectionId;
  }
  return sectionId;
}

function nearestDistance(values: number[], target: number) {
  let closest = Number.POSITIVE_INFINITY;
  for (const value of values) closest = Math.min(closest, Math.abs(value - target));
  return closest;
}

function median(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function clampBpm(value: number) {
  return Math.min(180, Math.max(60, value));
}

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

function priority(type: BeatGrid["events"][number]["type"]) {
  return type === "section_change" ? 0 : type === "downbeat" ? 1 : 2;
}
