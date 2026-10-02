import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { stripTypeScriptTypes } from "node:module";
import type { Sandbox } from "@vercel/sandbox";

// Retained month-end build. No floating "latest" URLs or nonfree codec builds.
export const MEDIA_TOOLS_RELEASE = {
  version: "9.0.2",
  url: "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-30-13-08/ffmpeg-n9.0.2-17-g2a571b6068-linux64-gpl-9.0.tar.xz",
  sha256: "68ee646831adaae2495618346f3bba94ff207ff83bbd34d643e7004730d66269",
  directory: "ffmpeg-n9.0.2-17-g2a571b6068-linux64-gpl-9.0",
} as const;
export type MediaTools = { ffmpeg: string; ffprobe: string };
let installing: Promise<MediaTools> | undefined;

/** The Node 24 Sandbox image includes tar but omits its XZ decompressor. */
export async function prepareSandboxMediaTools(sandbox: Pick<Sandbox, "runCommand">) {
  const result = await sandbox.runCommand({ cmd: "dnf", args: ["install", "--assumeyes", "xz"], sudo: true, timeoutMs: 60_000 });
  if (result.exitCode !== 0) throw new Error(`Sandbox media prerequisites failed: ${(await result.stderr()).slice(-1_000)}`);
}

async function executable(path: string) {
  try { await access(path, constants.X_OK); return true; } catch { return false; }
}

/** Read-only discovery; importing this module never installs or executes anything. */
export async function findMediaTools(environment = process.env): Promise<MediaTools | undefined> {
  const names = ["ffmpeg", "ffprobe"] as const;
  const result: Partial<MediaTools> = {};
  for (const name of names) {
    const explicit = environment[name === "ffmpeg" ? "FFMPEG_PATH" : "FFPROBE_PATH"];
    if (explicit) {
      if (!isAbsolute(explicit) || !await executable(explicit)) throw new Error(`${name.toUpperCase()}_PATH must name an executable absolute path.`);
      result[name] = explicit;
      continue;
    }
    const candidates = [join(process.cwd(), ".cocoa-tools", "bin", name),
      join(tmpdir(), `cocoa-tools-${MEDIA_TOOLS_RELEASE.sha256.slice(0, 16)}`, "bin", name),
      ...(process.platform === "darwin" ? [join("/opt/homebrew/opt/ffmpeg-full/bin", name), join("/usr/local/opt/ffmpeg-full/bin", name)] : []),
      ...(environment.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, name))];
    for (const path of candidates) if (await executable(path)) { result[name] = path; break; }
  }
  return result.ffmpeg && result.ffprobe ? result as MediaTools : undefined;
}

export async function mediaTools(): Promise<MediaTools> {
  const found = await findMediaTools();
  if (found) return found;
  // Vercel Functions have no system FFmpeg. Cache the pinned tools in ephemeral
  // storage instead of including hundreds of megabytes in every function bundle.
  if (process.env.VERCEL === "1") {
    const { extractMediaArchive } = await import("./media-archive");
    return installMediaTools((archive, destination) => extractMediaArchive(archive, destination, MEDIA_TOOLS_RELEASE.directory));
  }
  throw new Error("FFmpeg and ffprobe are required. Install FFmpeg or run npm run media:setup on Linux x64. See docs/setup.md.");
}

type ArchiveExtractor = (archive: string, destination: string) => Promise<void>;

export async function installMediaTools(extractArchive?: ArchiveExtractor): Promise<MediaTools> {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("Automatic media installation supports Linux x64. Install system FFmpeg on macOS or other architectures; see docs/setup.md.");
  }
  if (installing) return installing;
  installing = install(extractArchive).catch((error) => { installing = undefined; throw error; });
  return installing;
}

async function install(extractArchive?: ArchiveExtractor): Promise<MediaTools> {
  const destination = join(tmpdir(), `cocoa-tools-${MEDIA_TOOLS_RELEASE.sha256.slice(0, 16)}`);
  const result = { ffmpeg: join(destination, "bin", "ffmpeg"), ffprobe: join(destination, "bin", "ffprobe") };
  if (await executable(result.ffmpeg) && await executable(result.ffprobe)) return result;
  const staging = await mkdtemp(join(tmpdir(), "cocoa-tools-install-"));
  try {
    const response = await fetch(MEDIA_TOOLS_RELEASE.url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok || !response.body) throw new Error("Pinned media tools could not be downloaded. Install your own FFmpeg/ffprobe pair instead.");
    const chunks: Uint8Array[] = []; let size = 0;
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 200 * 1024 * 1024) { await reader.cancel(); throw new Error("Media tools archive exceeds its size limit."); }
      chunks.push(value);
    }
    const archive = Buffer.concat(chunks);
    if (createHash("sha256").update(archive).digest("hex") !== MEDIA_TOOLS_RELEASE.sha256) throw new Error("Media tools checksum mismatch. Refusing to execute this download.");
    const archivePath = join(staging, "tools.tar.xz");
    await writeFile(archivePath, archive, { flag: "wx", mode: 0o600 });
    const extracted = join(staging, "extracted"); await mkdir(extracted);
    if (extractArchive) await extractArchive(archivePath, extracted);
    else await mediaCommand("tar", ["-xJf", archivePath, "-C", extracted, "--strip-components=1",
      `${MEDIA_TOOLS_RELEASE.directory}/bin/ffmpeg`, `${MEDIA_TOOLS_RELEASE.directory}/bin/ffprobe`]);
    for (const name of ["ffmpeg", "ffprobe"]) await chmod(join(extracted, "bin", name), 0o755);
    const version = await mediaCommand(join(extracted, "bin", "ffmpeg"), ["-version"]);
    if (!version.includes("--enable-gpl") || version.includes("--enable-nonfree")) throw new Error("Unexpected FFmpeg license configuration.");
    await writeFile(join(extracted, "PROVENANCE.json"), JSON.stringify(MEDIA_TOOLS_RELEASE, null, 2));
    try { await rename(extracted, destination); }
    catch (error) { if (!await executable(result.ffmpeg) || !await executable(result.ffprobe)) throw error; }
    return result;
  } finally { await rm(staging, { recursive: true, force: true }); }
}

export async function mediaCommand(command: string, args: string[], options: { timeout?: number; cwd?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Media command timed out.")); }, options.timeout ?? 120_000);
    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-100_000); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-12_000); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); if (code === 0) resolve(stdout); else reject(new Error(`Media command failed (${code}): ${stderr}`)); });
  });
}

/** A dependency-free module shared verbatim by local processes and cloud sandboxes. */
export async function mediaToolsSource() {
  return stripTypeScriptTypes(await readFile(join(process.cwd(), "src/lib/server/media-tools.ts"), "utf8"));
}
