import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { ApiRequestError } from "@/lib/server/api-error";
import { getProviderMode } from "@/lib/server/config";
import { mediaCommand, mediaTools } from "@/lib/server/media-tools";
import { mockImageDataUrl } from "@/lib/mock-assets";

const inFlight = new Map<string, Promise<Buffer>>();
export const DEMO_MEDIA_PATH = "/api/demo/media";

export async function demoMedia(url: string): Promise<{ body: Buffer; contentType: string }> {
  if (getProviderMode() !== "mock") throw new ApiRequestError("Demo media is unavailable in live mode.", 404, "not_found");
  const parsed = new URL(url, "https://demo.invalid");
  if (parsed.pathname !== DEMO_MEDIA_PATH) throw new ApiRequestError("Invalid demo media path.", 400, "invalid_demo_media");
  const kind = parsed.searchParams.get("kind");
  const duration = Number(parsed.searchParams.get("duration") ?? "4");
  const aspect = parsed.searchParams.get("aspect") ?? "9:16";
  const variant = Number(parsed.searchParams.get("variant") ?? "0");
  if (!["video", "audio", "image"].includes(kind ?? "") || !Number.isInteger(duration) || duration < 1 || duration > 300 ||
      !["9:16", "16:9", "1:1"].includes(aspect) || !Number.isInteger(variant) || variant < 0 || variant > 7) {
    throw new ApiRequestError("Invalid demo media options.", 400, "invalid_demo_media");
  }
  const contentType = kind === "video" ? "video/mp4" : kind === "audio" ? "audio/mpeg" : "image/png";
  const key = `${kind}-${duration}-${aspect.replace(":", "x")}-${variant}`;
  let pending = inFlight.get(key);
  if (!pending) {
    if (inFlight.size >= 4) throw new ApiRequestError("Demo media is busy. Retry shortly.", 429, "demo_media_busy");
    pending = createMedia(key, kind!, duration, aspect, variant).finally(() => { inFlight.delete(key); });
    inFlight.set(key, pending);
  }
  return { body: await pending, contentType };
}

async function createMedia(key: string, kind: string, duration: number, aspect: string, variant: number) {
  const directory = join(tmpdir(), "cocoa-demo-media-v1"); await mkdir(directory, { recursive: true });
  const extension = kind === "video" ? "mp4" : kind === "audio" ? "mp3" : "png";
  const destination = join(directory, `${key}.${extension}`);
  try { if ((await stat(destination)).size > 0) return await readFile(destination); } catch { /* Not generated yet. */ }
  const temporary = join(directory, `${createHash("sha256").update(key).digest("hex")}-${randomUUID()}.${extension}`);
  try {
    if (kind === "image") {
      const svg = decodeURIComponent(mockImageDataUrl("Synthetic demo", ["#a8ff60", "#60d5ff", "#ffd166"][variant % 3]).split(",").slice(1).join(","));
      await sharp(Buffer.from(svg)).resize(aspect === "16:9" ? 640 : 360, aspect === "9:16" ? 640 : 360, { fit: "cover" }).png().toFile(temporary);
    } else {
      const { ffmpeg } = await mediaTools();
      const audio = `aevalsrc=0.08*(sin(2*PI*220*t)+sin(2*PI*277.18*t)+sin(2*PI*329.63*t)):s=44100`;
      const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y"];
      if (kind === "video") {
        const size = aspect === "16:9" ? "640x360" : aspect === "1:1" ? "360x360" : "360x640";
        args.push("-f", "lavfi", "-i", `testsrc2=size=${size}:rate=24`, "-f", "lavfi", "-i", audio, "-c:v", "libx264", "-preset", "ultrafast", "-crf", "26", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart");
      } else args.push("-f", "lavfi", "-i", audio, "-c:a", "libmp3lame", "-b:a", "96k");
      args.push("-t", String(duration), "-threads", "2", "-metadata", "comment=Cocoa Director synthetic demo; no AI provider calls", temporary);
      await mediaCommand(ffmpeg, args, { timeout: 120_000 });
    }
    await rename(temporary, destination);
    return await readFile(destination);
  } finally { await rm(temporary, { force: true }); }
}
