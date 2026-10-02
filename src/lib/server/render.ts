import { reserveProviderAttempt } from "@/lib/server/budget-ledger";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { mediaToolsSource, prepareSandboxMediaTools } from "@/lib/server/media-tools";
import { Sandbox } from "@vercel/sandbox";

import type { MediaProbeMetadata, QAReport, RenderManifest } from "@/lib/schemas";
import { fetchBlobUrl, uploadPublicBlob } from "@/lib/server/blob";
import { isTransientSandboxError, sleep } from "@/lib/server/sandbox-retry";

const SANDBOX_WORKDIR = "/vercel/sandbox/cocoa-render";
const SANDBOX_TIMEOUT_MS = 1000 * 60 * 12;
const PRELOADED_URL_SCHEME = "preloaded://";
const MAX_RENDER_ATTEMPTS = 4;
const RENDER_RETRY_BASE_DELAY_MS = 2000;

type SandboxInstance = Awaited<ReturnType<typeof Sandbox.create>>;
type RenderProbeResult = { shotIndex: number; probe: MediaProbeMetadata };
type RenderProbeReport = { shots: RenderProbeResult[]; music: MediaProbeMetadata };
type RenderBackend = "local" | "sandbox";

export function renderBackendForEnvironment(
  environment: Record<string, string | undefined> = process.env,
): RenderBackend {
  const hasExplicitSandboxCredentials = Boolean(
    environment.VERCEL_TOKEN && environment.VERCEL_TEAM_ID && environment.VERCEL_PROJECT_ID,
  );
  return environment.VERCEL === "1" || hasExplicitSandboxCredentials ? "sandbox" : "local";
}

async function localizeAssetForSandbox(
  url: string,
  sandboxFilename: string,
  preloadedAssets: Array<{ path: string; content: Buffer }>,
): Promise<string> {
  const response = await fetchBlobUrl(url);
  if (!response.ok) throw new Error("Render asset could not be downloaded.");
  const content = Buffer.from(await response.arrayBuffer());
  const sandboxPath = `${SANDBOX_WORKDIR}/preloaded-${sandboxFilename}`;
  preloadedAssets.push({ path: sandboxPath, content });
  return `${PRELOADED_URL_SCHEME}${sandboxPath}`;
}

export async function renderManifestToBlob(manifest: RenderManifest) {
  if (manifest.shots.length === 0) {
    throw new Error("Render manifest does not contain any generated shots.");
  }

  const preloadedAssets: Array<{ path: string; content: Buffer }> = [];
  const localizedManifest = JSON.parse(JSON.stringify(manifest)) as RenderManifest;
  if (localizedManifest.music?.url) {
    localizedManifest.music.url = await localizeAssetForSandbox(
      localizedManifest.music.url,
      "music.mp3",
      preloadedAssets,
    );
  }
  for (const shot of localizedManifest.shots) {
    if (shot.videoUrl) {
      shot.videoUrl = await localizeAssetForSandbox(
        shot.videoUrl,
        `shot-${String(shot.shotIndex).padStart(2, "0")}.mp4`,
        preloadedAssets,
      );
    }
  }

  if (renderBackendForEnvironment() === "local") {
    return runLocalRenderAttempt(localizedManifest, preloadedAssets);
  }

  // The Vercel Sandbox API fails transiently — an intermittent 403 on create or a dropped
  // command stream ("Stream ended before command finished"). The render itself is fast
  // (~1 min) and deterministic, so retry those on a fresh sandbox instead of forcing the
  // user to hit retry by hand. Deterministic failures (ffmpeg errors) surface immediately.
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_RENDER_ATTEMPTS; attempt += 1) {
    try {
      await reserveProviderAttempt({ scope: "vercel:music-render", videoId: manifest.videoId, costCents: 50 });
      return await runRenderAttempt(localizedManifest, preloadedAssets, attempt);
    } catch (error) {
      lastError = error;
      if (!isTransientSandboxError(error)) throw error;
      console.warn(
        JSON.stringify({
          event: "render_attempt_transient_failure",
          videoId: manifest.videoId,
          attempt,
          maxAttempts: MAX_RENDER_ATTEMPTS,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      if (attempt >= MAX_RENDER_ATTEMPTS) {
        throw new Error(
          `Video render failed after ${MAX_RENDER_ATTEMPTS} attempts because the render service was ` +
            `temporarily unavailable. Your shots and music are saved — please retry the render. ` +
            `(last error: ${error instanceof Error ? error.message : String(error)})`,
          { cause: error },
        );
      }
      await sleep(attempt * RENDER_RETRY_BASE_DELAY_MS);
    }
  }
  // Unreachable: the loop always returns or throws.
  throw lastError instanceof Error ? lastError : new Error("Sandbox render failed.");
}

async function runRenderAttempt(
  localizedManifest: RenderManifest,
  preloadedAssets: Array<{ path: string; content: Buffer }>,
  attempt: number,
) {
  const startedAt = Date.now();
  const sandbox = await Sandbox.create({
    ...sandboxCredentials(),
    runtime: "node24",
    timeout: SANDBOX_TIMEOUT_MS,
    resources: { vcpus: 2 },
  });

  try {
    await prepareSandboxMediaTools(sandbox);
    await sandbox.mkDir(SANDBOX_WORKDIR);
    await sandbox.writeFiles([
      { path: `${SANDBOX_WORKDIR}/media-tools.mjs`, content: await mediaToolsSource() },
      {
        path: `${SANDBOX_WORKDIR}/manifest.json`,
        content: JSON.stringify(localizedManifest),
      },
      {
        path: `${SANDBOX_WORKDIR}/render.mjs`,
        content: sandboxRenderScript(),
      },
      ...preloadedAssets,
    ]);

    await runSandboxCommand(
      sandbox,
      {
        cmd: "node",
        args: ["render.mjs"],
        cwd: SANDBOX_WORKDIR,
      },
      "Sandbox video render",
    );

    const [videoBytes, thumbnailBytes, probeReportBytes, qaReportBytes] = await Promise.all([
      sandbox.readFileToBuffer({ path: `${SANDBOX_WORKDIR}/final.mp4` }),
      sandbox.readFileToBuffer({ path: `${SANDBOX_WORKDIR}/thumbnail.png` }),
      sandbox.readFileToBuffer({ path: `${SANDBOX_WORKDIR}/probe-report.json` }),
      sandbox.readFileToBuffer({ path: `${SANDBOX_WORKDIR}/qa-report.json` }),
    ]);

    return finalizeRenderOutputs({
      manifest: localizedManifest,
      videoBytes,
      thumbnailBytes,
      probeReportBytes,
      qaReportBytes,
      backend: "sandbox",
      attempt,
      startedAt,
    });
  } finally {
    await sandbox.stop().catch(() => undefined);
  }
}

function sandboxCredentials() {
  const { VERCEL_TOKEN: token, VERCEL_TEAM_ID: teamId, VERCEL_PROJECT_ID: projectId } = process.env;
  return token && teamId && projectId ? { token, teamId, projectId } : {};
}

async function runLocalRenderAttempt(
  localizedManifest: RenderManifest,
  preloadedAssets: Array<{ path: string; content: Buffer }>,
) {
  const startedAt = Date.now();
  const cacheRoot = join(process.cwd(), "node_modules", ".cache");
  await mkdir(cacheRoot, { recursive: true });
  const workdir = await mkdtemp(join(cacheRoot, "cocoa-render-"));
  const replaceWorkdir = (value: string) => value.replaceAll(SANDBOX_WORKDIR, workdir);
  const localManifest = JSON.parse(
    replaceWorkdir(JSON.stringify(localizedManifest)),
  ) as RenderManifest;

  try {
    await Promise.all([
      writeFile(join(workdir, "manifest.json"), JSON.stringify(localManifest)),
      writeFile(join(workdir, "render.mjs"), sandboxRenderScript()),
      writeFile(join(workdir, "media-tools.mjs"), await mediaToolsSource()),
      ...preloadedAssets.map((asset) => writeFile(replaceWorkdir(asset.path), asset.content)),
    ]);

    await runLocalCommand(process.execPath, ["render.mjs"], workdir, {
      COCOA_RENDER_WORKDIR: workdir,
      COCOA_RENDER_BACKEND: "local-process",
    });

    const [videoBytes, thumbnailBytes, probeReportBytes, qaReportBytes] = await Promise.all([
      readFile(join(workdir, "final.mp4")),
      readFile(join(workdir, "thumbnail.png")),
      readFile(join(workdir, "probe-report.json")),
      readFile(join(workdir, "qa-report.json")),
    ]);

    return finalizeRenderOutputs({
      manifest: localManifest,
      videoBytes,
      thumbnailBytes,
      probeReportBytes,
      qaReportBytes,
      backend: "local",
      attempt: 1,
      startedAt,
    });
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

async function runLocalCommand(
  command: string,
  args: string[],
  cwd: string,
  environment: Record<string, string>,
) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-12000);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Local render exceeded its time limit."));
    }, SANDBOX_TIMEOUT_MS);
    child.stdout.resume();
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Local FFmpeg render failed with exit code ${code ?? "unknown"}: ${trimCommandOutput(stderr)}`));
    });
  });
}

async function finalizeRenderOutputs(input: {
  manifest: RenderManifest;
  videoBytes: Buffer | null;
  thumbnailBytes: Buffer | null;
  probeReportBytes: Buffer | null;
  qaReportBytes: Buffer | null;
  backend: RenderBackend;
  attempt: number;
  startedAt: number;
}) {
  if (!input.videoBytes) throw new Error(`${input.backend} render completed without producing final.mp4.`);
  if (!input.thumbnailBytes) throw new Error(`${input.backend} render completed without producing thumbnail.png.`);
  if (!input.probeReportBytes || !input.qaReportBytes) {
    throw new Error(`${input.backend} render completed without media probe and QA reports.`);
  }

  const probeReport = JSON.parse(input.probeReportBytes.toString("utf8")) as RenderProbeReport;
  const qaReport = JSON.parse(input.qaReportBytes.toString("utf8")) as QAReport;
  if (!qaReport.passed) {
    const errors = qaReport.findings
      .filter((finding) => finding.severity === "error")
      .map((finding) => finding.message)
      .join("; ");
    throw new Error(`Rendered output failed deterministic QA: ${errors || "unknown quality finding"}`);
  }

  const renderId = randomUUID();
  const [videoBlob, thumbnailBlob] = await Promise.all([
    uploadPublicBlob({
      pathname: `videos/${input.manifest.videoId}/final-${renderId}.mp4`,
      body: input.videoBytes,
      contentType: "video/mp4",
    }),
    uploadPublicBlob({
      pathname: `videos/${input.manifest.videoId}/thumbnail-${renderId}.png`,
      body: input.thumbnailBytes,
      contentType: "image/png",
    }),
  ]);

  console.log(JSON.stringify({
    event: "render_succeeded",
    backend: input.backend,
    videoId: input.manifest.videoId,
    attempt: input.attempt,
    durationMs: Date.now() - input.startedAt,
  }));

  return {
    videoUrl: videoBlob.url,
    thumbnailUrl: thumbnailBlob.url,
    mediaProbes: probeReport.shots,
    musicProbe: probeReport.music,
    qaReport,
  };
}

async function runSandboxCommand(
  sandbox: SandboxInstance,
  command: { cmd: string; args?: string[]; cwd?: string },
  label: string,
) {
  const result = await sandbox.runCommand(command);
  if (result.exitCode === 0) return;

  const [stdout, stderr] = await Promise.all([result.stdout(), result.stderr()]);
  const output = trimCommandOutput(stderr || stdout || "no command output");
  throw new Error(`${label} failed with exit code ${result.exitCode}: ${output}`);
}

function trimCommandOutput(output: string) {
  return output.replace(/\s+/g, " ").trim().slice(-4000);
}

export function sandboxRenderScript() {
  return String.raw`
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { mediaTools, installMediaTools } from "./media-tools.mjs";
const tools = process.env.COCOA_RENDER_BACKEND === "local-process" ? await mediaTools() : await installMediaTools();

const SANDBOX_TIMEOUT_MS = 1000 * 60 * 12;
const WORKDIR = process.env.COCOA_RENDER_WORKDIR || "/vercel/sandbox/cocoa-render";
const ASSET_DIR = path.join(WORKDIR, "assets");
const OUTPUT_FILE = path.join(WORKDIR, "final.mp4");
const THUMBNAIL_FILE = path.join(WORKDIR, "thumbnail.png");
const PROBE_REPORT_FILE = path.join(WORKDIR, "probe-report.json");
const QA_REPORT_FILE = path.join(WORKDIR, "qa-report.json");
const manifest = JSON.parse(await readFile(path.join(WORKDIR, "manifest.json"), "utf8"));
const shots = [...manifest.shots].sort((left, right) => left.shotIndex - right.shotIndex);

if (!shots.length) {
  throw new Error("Render manifest does not contain any generated shots.");
}

await mkdir(ASSET_DIR, { recursive: true });


const musicFile = path.join(ASSET_DIR, "music.mp3");
await Promise.all([
  downloadToFile(manifest.music.url, musicFile),
  ...shots.map((shot) => downloadToFile(shot.videoUrl, shotFile(shot))),
]);

const probeResults = await Promise.all(
  shots.map(async (shot) => ({ shotIndex: shot.shotIndex, probe: await probeMedia(shotFile(shot)) })),
);
const musicProbe = await probeMedia(musicFile);
await writeFile(PROBE_REPORT_FILE, JSON.stringify({ shots: probeResults, music: musicProbe }, null, 2));
const timelineEntries = timelineVideoEntries(manifest, shots);
const clipPlans = timelineEntries.map(({ shot, segment }) =>
  buildClipPlan(shot, probeResults.find((item) => item.shotIndex === shot.shotIndex).probe, segment)
);

const dimensions = dimensionsFor(manifest.aspectRatio);
const renderDuration = Number(manifest.timeline?.durationMs) > 0
  ? Number(manifest.timeline.durationMs) / 1000
  : clipPlans.reduce((total, plan) => total + plan.timelineDurationSeconds, 0);
if (musicProbe.durationSeconds + 1 / 30 < renderDuration) {
  throw new Error(
    "Music returned " + musicProbe.durationSeconds.toFixed(3) + "s for a " + renderDuration.toFixed(3) +
    "s timeline. Regenerate or extend the audio; silent padding is disabled."
  );
}

await runFfmpeg([
  "-y",
  ...timelineEntries.flatMap(({ shot }) => ["-i", shotFile(shot)]),
  "-i",
  musicFile,
  "-filter_complex",
  videoFilter(clipPlans, dimensions.width, dimensions.height),
  "-map",
  "[v]",
  "-map",
  timelineEntries.length + ":a:0",
  "-t",
  String(Math.max(renderDuration, 1)),
  "-c:v",
  "libx264",
  "-preset",
  "veryfast",
  "-crf",
  "20",
  "-pix_fmt",
  "yuv420p",
  "-c:a",
  "aac",
  "-b:a",
  "192k",
  "-af",
  "asetpts=PTS-STARTPTS,loudnorm=I=-14:TP=-1.5:LRA=11,aresample=async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo",
  "-shortest",
  "-movflags",
  "+faststart",
  "-metadata",
  "cocoa-video-id=" + manifest.videoId,
  "-metadata",
  "cocoa-provenance=ai-generated-openai-gpt-image-2-seedance-elevenlabs-ffmpeg-" +
    (process.env.COCOA_RENDER_BACKEND || "vercel-sandbox"),
  OUTPUT_FILE,
]);

const qaReport = await analyzeRenderedOutput(OUTPUT_FILE, manifest.videoId, renderDuration, clipPlans);
await writeFile(QA_REPORT_FILE, JSON.stringify(qaReport, null, 2));
if (!qaReport.passed) {
  throw new Error(
    "Deterministic render QA failed: " +
    qaReport.findings.filter((finding) => finding.severity === "error").map((finding) => finding.message).join("; ")
  );
}

await runFfmpeg([
  "-y",
  "-ss",
  thumbnailTime(renderDuration),
  "-i",
  OUTPUT_FILE,
  "-frames:v",
  "1",
  "-vf",
  "scale=" + Math.min(dimensions.width, 720) + ":-1",
  THUMBNAIL_FILE,
]);

async function downloadToFile(url, filePath) {
  if (url.startsWith("preloaded://")) {
    const sourcePath = url.slice("preloaded://".length);
    if (sourcePath !== filePath) await copyFile(sourcePath, filePath);
    return;
  }
  throw new Error("Render asset was not validated and preloaded before execution.");
}

function shotFile(shot) {
  return path.join(ASSET_DIR, "shot-" + String(shot.shotIndex).padStart(2, "0") + ".mp4");
}

function videoFilter(clipPlans, width, height) {
  const prepared = clipPlans.map((plan, index) => {
    const sourceDuration = plan.sourceDurationSeconds.toFixed(6);
    const sourceStart = plan.usableInSeconds.toFixed(6);
    const ratio = plan.retimeRatio.toFixed(8);
    const cadence = plan.retimeRatio > 1.0001
      ? "setpts=" + ratio + "*(PTS-STARTPTS),fps=30"
      : "setpts=PTS-STARTPTS,fps=30";
    return "[" + index + ":v]scale=" + width + ":" + height + ":force_original_aspect_ratio=increase,crop=" + width + ":" + height + ",setsar=1,format=yuv420p,trim=start=" + sourceStart + ":duration=" + sourceDuration + "," + cadence + "[v" + index + "]";
  });
  const concatInputs = clipPlans.map((_, index) => "[v" + index + "]").join("");
  return prepared.join(";") + ";" + concatInputs + "concat=n=" + clipPlans.length + ":v=1:a=0[v]";
}

function buildClipPlan(shot, probe, segment) {
  const requested = Math.max(
    0.1,
    Number(segment ? (segment.endMs - segment.startMs) / 1000 : shot.requestedDurationSeconds ?? shot.durationSeconds) || 0.1,
  );
  const usableIn = Math.max(0, Number(segment?.sourceInMs) / 1000 || Number(shot.usableInSeconds) || 0);
  const explicitUsableOut = Number(segment?.sourceOutMs) / 1000 || Number(shot.usableOutSeconds);
  const sourceEnd = Math.min(
    probe.durationSeconds,
    Number.isFinite(explicitUsableOut) && explicitUsableOut > usableIn ? explicitUsableOut : probe.durationSeconds,
  );
  const available = Math.max(0.001, sourceEnd - usableIn);
  const shortage = requested - available;
  const retimeLimit = Math.max(0.25, requested * 0.08);
  if (shortage > retimeLimit) {
    throw new Error(
      "Shot " + (shot.shotIndex + 1) + " returned " + available.toFixed(3) +
      "s of usable media for a " + requested.toFixed(3) +
      "s timeline slot. Regenerate or extend the shot; frozen-frame padding is disabled.",
    );
  }
  const sourceDuration = Math.min(available, requested);
  return {
    shotIndex: shot.shotIndex,
    usableInSeconds: usableIn,
    sourceDurationSeconds: sourceDuration,
    timelineDurationSeconds: requested,
    retimeRatio: requested / sourceDuration,
  };
}

function timelineVideoEntries(renderManifest, shotList) {
  const segments = renderManifest.timeline?.tracks
    ?.find((track) => track.kind === "video")
    ?.segments
    ?.filter((segment) => segment.kind === "video")
    ?.sort((left, right) => left.startMs - right.startMs);
  if (!segments?.length) return shotList.map((shot) => ({ shot, segment: undefined }));

  let cursorMs = 0;
  return segments.map((segment) => {
    if (Math.abs(segment.startMs - cursorMs) > 1000 / 30) {
      throw new Error(
        "Timeline segment " + segment.id + " starts at " + segment.startMs +
        "ms but the preceding edit ends at " + cursorMs + "ms. Explicit gaps and undeclared overlaps cannot be concatenated."
      );
    }
    cursorMs = segment.endMs;
    const shotIndex = Number(segment.metadata?.shotIndex);
    const shot = shotList.find((candidate) => candidate.shotIndex === shotIndex);
    if (!shot) throw new Error("Timeline segment " + segment.id + " does not reference a generated shot.");
    return { shot, segment };
  });
}

async function probeMedia(filePath) {
  const result = await runCommandCapture(tools.ffprobe, [
    "-v", "error",
    "-count_frames",
    "-show_entries", "format=duration,start_time:stream=index,codec_type,codec_name,start_time,width,height,avg_frame_rate,nb_frames,nb_read_frames,color_space,color_transfer,color_primaries",
    "-of", "json",
    filePath,
  ]);
  const parsed = JSON.parse(result.stdout || "{}");
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const video = streams.find((stream) => stream.codec_type === "video") ?? {};
  const audioStreams = streams.filter((stream) => stream.codec_type === "audio");
  const audio = audioStreams[0];
  const durationSeconds = Number(parsed.format?.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("ffprobe could not determine a positive duration for " + path.basename(filePath));
  }
  return {
    durationSeconds,
    startTimeSeconds: finiteNumber(parsed.format?.start_time, 0),
    frameRate: parseFrameRate(video.avg_frame_rate),
    frameCount: optionalInteger(video.nb_frames ?? video.nb_read_frames),
    width: optionalInteger(video.width),
    height: optionalInteger(video.height),
    videoCodec: optionalString(video.codec_name),
    audioCodec: optionalString(audio?.codec_name),
    hasAudio: Boolean(audio),
    audioTrackCount: audioStreams.length,
    videoStartTimeSeconds: optionalFiniteNumber(video.start_time),
    audioStartTimeSeconds: optionalFiniteNumber(audio?.start_time),
    avStartOffsetMs: startOffsetMs(video.start_time, audio?.start_time),
    colorSpace: optionalString(video.color_space),
    colorTransfer: optionalString(video.color_transfer),
    colorPrimaries: optionalString(video.color_primaries),
    probedAt: new Date().toISOString(),
  };
}

async function analyzeRenderedOutput(filePath, productionId, expectedDurationSeconds, clipPlans) {
  const [probe, videoAnalysis, audioAnalysis] = await Promise.all([
    probeMedia(filePath),
    runCommandCapture(tools.ffmpeg, [
      "-hide_banner", "-i", filePath,
      "-vf", "freezedetect=n=-60dB:d=0.134,blackdetect=d=0.1:pix_th=0.02:pic_th=0.99",
      "-an", "-f", "null", "-",
    ], true),
    runCommandCapture(tools.ffmpeg, [
      "-hide_banner", "-i", filePath,
      "-af", "silencedetect=n=-50dB:d=0.5,ebur128=framelog=verbose",
      "-vn", "-f", "null", "-",
    ], true),
  ]);
  const findings = [];
  const freezeRuns = parseFreezeRuns(videoAnalysis.stderr, probe.durationSeconds);
  const freezeDurations = freezeRuns.map((run) => run.duration);
  const blackDurations = numericMatches(videoAnalysis.stderr, /black_duration:([0-9.]+)/g);
  const silenceDurations = numericMatches(audioAnalysis.stderr, /silence_duration:\s*([0-9.]+)/g);
  const integratedLoudness = lastNumericMatch(audioAnalysis.stderr, /\bI:\s*(-?[0-9.]+)\s*LUFS/g);
  const durationDeltaMs = Math.abs(probe.durationSeconds - expectedDurationSeconds) * 1000;
  const avStartOffsetMs = Math.abs(Number(probe.avStartOffsetMs) || 0);

  const editBoundaries = clipPlans.reduce((boundaries, plan) => {
    boundaries.push((boundaries.at(-1) || 0) + plan.timelineDurationSeconds);
    return boundaries;
  }, []);
  const maximumActiveFreezeSeconds = 4 / 30;
  const materialBoundaryFreezeSeconds = 0.5;
  let boundaryFreezeRunCount = 0;
  for (const run of freezeRuns.filter((value) => value.duration > maximumActiveFreezeSeconds)) {
    const touchedBoundary = editBoundaries.find((boundary) =>
      Math.abs(run.end - boundary) <= 2 / 30 || (run.start <= boundary && run.end >= boundary)
    );
    const touchesBoundary = touchedBoundary !== undefined;
    const isMaterialBoundaryFreeze = touchesBoundary && run.duration >= materialBoundaryFreezeSeconds;
    if (isMaterialBoundaryFreeze) boundaryFreezeRunCount += 1;
    findings.push(qaFinding(
      isMaterialBoundaryFreeze ? "freeze.boundary" : "freeze.short_motion",
      isMaterialBoundaryFreeze ? "error" : "warning",
      "Detected a " + run.duration.toFixed(3) + "s near-identical-frame run " +
        (touchesBoundary ? "at the " + touchedBoundary.toFixed(3) + "s edit boundary." : "inside a generated shot."),
    ));
  }
  for (const duration of blackDurations.filter((value) => value > 0.1)) {
    findings.push(qaFinding("black.detected", "error", "Detected an unexplained black-frame run of " + duration.toFixed(3) + "s."));
  }
  for (const duration of silenceDurations.filter((value) => value > 1)) {
    findings.push(qaFinding("audio.silence", "warning", "Detected an audio silence of " + duration.toFixed(3) + "s."));
  }
  if (durationDeltaMs > 1000 / 30 + 1) {
    findings.push(qaFinding("duration.mismatch", "error", "Final duration differs from the compiled timeline by " + durationDeltaMs.toFixed(1) + "ms."));
  }
  if (avStartOffsetMs > 1000 / 30 + 1) {
    findings.push(qaFinding("av.start_offset", "error", "Audio/video start alignment differs by " + avStartOffsetMs.toFixed(1) + "ms."));
  }
  if (integratedLoudness !== undefined && (integratedLoudness < -18 || integratedLoudness > -10)) {
    findings.push(qaFinding("audio.loudness", "warning", "Integrated loudness is " + integratedLoudness.toFixed(1) + " LUFS; target is -14 LUFS."));
  }

  return {
    version: 1,
    productionId,
    passed: findings.every((finding) => finding.severity !== "error"),
    findings,
    metrics: {
      durationMs: probe.durationSeconds * 1000,
      durationDeltaMs,
      avStartOffsetMs,
      freezeRunCount: freezeDurations.length,
      boundaryFreezeRunCount,
      blackRunCount: blackDurations.length,
      silenceRunCount: silenceDurations.length,
      ...(integratedLoudness === undefined ? {} : { integratedLoudness }),
    },
    checkedAt: new Date().toISOString(),
  };
}

function parseFreezeRuns(value, mediaEndSeconds) {
  const runs = [];
  let current;
  for (const match of value.matchAll(/freeze_(start|duration|end):\s*([0-9.]+)/g)) {
    const number = Number(match[2]);
    if (!Number.isFinite(number)) continue;
    if (match[1] === "start") current = { start: number, duration: 0, end: number };
    if (!current) continue;
    if (match[1] === "duration") current.duration = number;
    if (match[1] === "end") {
      current.end = number;
      if (!current.duration) current.duration = Math.max(0, current.end - current.start);
      runs.push(current);
      current = undefined;
    }
  }
  if (current && Number.isFinite(mediaEndSeconds) && mediaEndSeconds > current.start) {
    current.end = mediaEndSeconds;
    current.duration = Math.max(current.duration, current.end - current.start);
    runs.push(current);
  }
  return runs;
}

function qaFinding(code, severity, message) {
  return {
    id: code + "-" + Math.abs(hashText(message)),
    category: "audiovisual",
    severity,
    code,
    message,
    retryable: code === "freeze.boundary" || code === "duration.mismatch",
  };
}

function hashText(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = (hash * 31 + value.charCodeAt(index)) | 0;
  return hash;
}

function numericMatches(value, pattern) {
  return [...value.matchAll(pattern)].map((match) => Number(match[1])).filter(Number.isFinite);
}

function lastNumericMatch(value, pattern) {
  return numericMatches(value, pattern).at(-1);
}

function finiteNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function startOffsetMs(videoStart, audioStart) {
  const video = optionalFiniteNumber(videoStart);
  const audio = optionalFiniteNumber(audioStart);
  return video === undefined || audio === undefined ? undefined : (audio - video) * 1000;
}

function optionalInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : undefined;
}

function optionalString(value) {
  return typeof value === "string" && value ? value : undefined;
}

function parseFrameRate(value) {
  if (typeof value !== "string") return undefined;
  const [numerator, denominator = "1"] = value.split("/");
  const result = Number(numerator) / Number(denominator);
  return Number.isFinite(result) && result > 0 ? result : undefined;
}

function dimensionsFor(aspectRatio) {
  if (aspectRatio === "16:9") return { width: 1280, height: 720 };
  if (aspectRatio === "1:1") return { width: 1080, height: 1080 };
  return { width: 720, height: 1280 };
}

function thumbnailTime(durationSeconds) {
  return Math.min(Math.max(durationSeconds * 0.35, 1), Math.max(durationSeconds - 1, 1)).toFixed(2);
}

function totalShotDuration(shotList) {
  return shotList.reduce((total, shot) => total + Math.max(0, Number(shot.durationSeconds) || 0), 0);
}

async function runFfmpeg(args) {
  await runCommandCapture(tools.ffmpeg, args);
}

async function runCommandCapture(command, args, allowNonZero = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout = (stdout + chunk.toString("utf8")).slice(-1000000);
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-1000000);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Local render exceeded its time limit."));
    }, SANDBOX_TIMEOUT_MS);
    child.stdout.resume();
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 || allowNonZero) {
        resolve({ stdout, stderr, exitCode: code });
      } else {
        reject(new Error(path.basename(command) + " exited with code " + (code ?? "unknown") + ": " + stderr.slice(-12000)));
      }
    });
  });
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return "unknown host";
  }
}
`;
}
