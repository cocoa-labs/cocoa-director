import { createHash } from "node:crypto";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";

import { del, put } from "@vercel/blob";

import { DEV_BLOB_URL_PREFIX } from "@/lib/constants";
import { fetchGuarded } from "@/lib/server/ssrf";
import { checkedStoragePath } from "@/lib/server/storage-path";

const DEV_BLOB_DIR = "public/dev-blob";

function contentTypeForBlobUrl(url: string) {
  switch (extname(url).slice(1).toLowerCase()) {
    case "mp4": return "video/mp4";
    case "mp3": return "audio/mpeg";
    case "wav": return "audio/wav";
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "webp": return "image/webp";
    default: return "application/octet-stream";
  }
}

export async function fetchBlobUrl(url: string): Promise<Response> {
  if (url.startsWith("/api/demo/media?")) {
    const { demoMedia } = await import("@/lib/server/demo-media");
    const media = await demoMedia(url);
    return new Response(new Uint8Array(media.body), { headers: { "Content-Type": media.contentType, "Content-Length": String(media.body.length) } });
  }
  if (url.startsWith(DEV_BLOB_URL_PREFIX)) {
    const sanitized = url.slice(DEV_BLOB_URL_PREFIX.length);
    const filePath = await checkedStoragePath(join(process.cwd(), DEV_BLOB_DIR), sanitized);
    if ((await stat(filePath)).size > 250 * 1024 * 1024) throw new Error("Asset exceeds the download size limit.");
    const buffer = await readFile(filePath);
    return new Response(buffer, {
      status: 200,
      headers: {
        "Content-Type": contentTypeForBlobUrl(url),
        "Content-Length": String(buffer.length),
      },
    });
  }
  return fetchGuarded(url, { maxBytes: 250 * 1024 * 1024 });
}

async function writeLocalBlob(input: {
  pathname: string;
  body: Buffer | string;
  contentType: string;
  immutable?: boolean;
}) {
  const sanitized = input.pathname;
  const filePath = await checkedStoragePath(join(process.cwd(), DEV_BLOB_DIR), sanitized);
  await mkdir(dirname(filePath), { recursive: true });
  const body = typeof input.body === "string" ? Buffer.from(input.body) : input.body;
  const sha256 = contentSha256(body);
  if (input.immutable) {
    try { await writeFile(filePath, body, { flag: "wx" }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readFile(filePath);
      if (contentSha256(existing) !== sha256) throw new Error(`Immutable blob collision at ${sanitized}`);
    }
    return { url: `${DEV_BLOB_URL_PREFIX}${sanitized}`, pathname: sanitized, sha256 };
  }
  await writeFile(filePath, body);
  return { url: `${DEV_BLOB_URL_PREFIX}${sanitized}`, pathname: sanitized, sha256 };
}

export async function uploadPublicBlob(input: {
  pathname: string;
  body: Buffer | string;
  contentType: string;
  immutable?: boolean;
}) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return writeLocalBlob(input);
  }
  const body = typeof input.body === "string" ? Buffer.from(input.body) : input.body;
  const result = await put(input.pathname, body, {
    access: "public",
    allowOverwrite: input.immutable !== true,
    contentType: input.contentType,
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });
  return { ...result, sha256: contentSha256(body) };
}

export async function copyRemoteFileToBlob(input: {
  url: string;
  pathname: string;
  contentType: string;
  /** Legacy option retained for callers; every URL is guarded. */
  allowUntrustedHost?: boolean;
  immutable?: boolean;
}) {
  const response = await fetchBlobUrl(input.url);
  if (!response.ok) {
    throw new Error(`Failed to copy remote asset: ${response.status} ${await response.text()}`);
  }
  return uploadPublicBlob({
    pathname: input.pathname,
    body: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get("content-type") ?? input.contentType,
    immutable: input.immutable,
  });
}

export async function fingerprintBlobUrl(url: string) {
  const response = await fetchBlobUrl(url);
  if (!response.ok) throw new Error(`Failed to fingerprint asset: ${response.status}`);
  const body = Buffer.from(await response.arrayBuffer());
  return { sha256: contentSha256(body), byteLength: body.byteLength };
}

export function contentSha256(body: Buffer | string) {
  return createHash("sha256").update(body).digest("hex");
}

export async function deleteBlobUrl(url?: string | null) {
  if (!url) return;
  if (url.startsWith(DEV_BLOB_URL_PREFIX)) {
    const sanitized = url.slice(DEV_BLOB_URL_PREFIX.length);
    const path = await checkedStoragePath(join(process.cwd(), DEV_BLOB_DIR), sanitized);
    await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    return;
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN) return;
  try {
    await del(url, { token: process.env.BLOB_READ_WRITE_TOKEN });
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "blob_delete_failed",
        url,
        error: error instanceof Error ? error.message : "Unknown Blob delete error",
      }),
    );
  }
}

export function base64ToBuffer(value: string) {
  return Buffer.from(value.replace(/^data:[^;]+;base64,/, ""), "base64");
}
