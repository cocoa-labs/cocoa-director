import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { spawn } from "node:child_process";

import { mediaTools } from "@/lib/server/media-tools";

import type { MediaProbeMetadata } from "@/lib/schemas";
import { fetchBlobUrl } from "@/lib/server/blob";

const MAX_PROBE_BYTES = 250 * 1024 * 1024;

export async function probeMediaUrl(url: string): Promise<MediaProbeMetadata> {
  const response = await fetchBlobUrl(url);
  if (!response.ok) throw new Error(`Could not inspect media: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_PROBE_BYTES) throw new Error("Media is too large for inspection.");
  const directory = await mkdtemp(join(tmpdir(), "cocoa-probe-"));
  const suffix = safeExtension(url);
  const inputPath = join(directory, `asset${suffix}`);
  try {
    await writeFile(inputPath, bytes);
    return await probeMediaFile(inputPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function probeMediaFile(filePath: string): Promise<MediaProbeMetadata> {
  const output = await runProbe([
    "-v", "error", "-count_frames",
    "-show_entries", "format=duration,start_time:stream=codec_type,codec_name,start_time,width,height,avg_frame_rate,nb_frames,nb_read_frames,color_space,color_transfer,color_primaries",
    "-of", "json", filePath,
  ]);
  const parsed = JSON.parse(output) as {
    format?: { duration?: string; start_time?: string };
    streams?: Array<Record<string, unknown>>;
  };
  const streams = parsed.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const audioStreams = streams.filter((stream) => stream.codec_type === "audio");
  const audio = audioStreams[0];
  const durationSeconds = Number(parsed.format?.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("ffprobe could not determine a positive media duration.");
  }
  return {
    durationSeconds,
    startTimeSeconds: finiteNumber(parsed.format?.start_time, 0),
    frameRate: parseFrameRate(video?.avg_frame_rate),
    frameCount: optionalInteger(video?.nb_frames ?? video?.nb_read_frames),
    width: optionalInteger(video?.width),
    height: optionalInteger(video?.height),
    videoCodec: optionalString(video?.codec_name),
    audioCodec: optionalString(audio?.codec_name),
    hasAudio: Boolean(audio),
    audioTrackCount: audioStreams.length,
    videoStartTimeSeconds: optionalFiniteNumber(video?.start_time),
    audioStartTimeSeconds: optionalFiniteNumber(audio?.start_time),
    avStartOffsetMs: startOffsetMs(video?.start_time, audio?.start_time),
    colorSpace: optionalString(video?.color_space),
    colorTransfer: optionalString(video?.color_transfer),
    colorPrimaries: optionalString(video?.color_primaries),
    probedAt: new Date().toISOString(),
  };
}

export function assertMediaCoversSlot(actualSeconds: number, requestedSeconds: number) {
  const shortage = requestedSeconds - actualSeconds;
  const retimeLimit = Math.max(0.25, requestedSeconds * 0.08);
  if (shortage > retimeLimit) {
    throw new Error(
      `Injected clip has ${actualSeconds.toFixed(3)}s of measured media for a ${requestedSeconds.toFixed(3)}s slot. ` +
      "Replace, extend, or rebalance the clip; frozen padding is disabled.",
    );
  }
}

async function runProbe(args: string[]) {
  const tools = await mediaTools();
  return new Promise<string>((resolve, reject) => {
    const child = spawn(tools.ffprobe, args, { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Media inspection timed out."));
    }, 60_000);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout = (stdout + chunk.toString("utf8")).slice(-1_000_000); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-12_000); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`ffprobe failed with code ${code ?? "unknown"}: ${stderr}`));
    });
  });
}

function safeExtension(url: string) {
  try {
    const extension = extname(new URL(url, "https://local.invalid").pathname).toLowerCase();
    return /^\.[a-z0-9]{1,5}$/.test(extension) ? extension : ".media";
  } catch {
    return ".media";
  }
}

function parseFrameRate(value: unknown) {
  if (typeof value !== "string") return undefined;
  const [numerator, denominator = "1"] = value.split("/");
  const rate = Number(numerator) / Number(denominator);
  return Number.isFinite(rate) && rate > 0 ? rate : undefined;
}

function finiteNumber(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalFiniteNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function startOffsetMs(videoStart: unknown, audioStart: unknown) {
  const video = optionalFiniteNumber(videoStart);
  const audio = optionalFiniteNumber(audioStart);
  return video === undefined || audio === undefined ? undefined : (audio - video) * 1_000;
}

function optionalInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : undefined;
}

function optionalString(value: unknown) {
  return typeof value === "string" && value ? value : undefined;
}
