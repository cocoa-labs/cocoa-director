import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { del, get, put } from "@vercel/blob";
import { checkedStoragePath } from "@/lib/server/storage-path";

const LOCAL_SOURCE_DIR = ".cocoa-private/sources";
const LOCAL_SOURCE_PREFIX = "private-source://";

export async function uploadPrivateSource(input: {
  pathname: string;
  body: Buffer;
  contentType: string;
}) {
  const token = process.env.PRIVATE_BLOB_READ_WRITE_TOKEN;
  if (!token) {
    if (process.env.VERCEL === "1" && process.env.PROVIDER_MODE === "live") {
      throw new Error("PRIVATE_BLOB_READ_WRITE_TOKEN is required for production source uploads.");
    }
    const pathname = input.pathname;
    const filePath = await checkedStoragePath(join(process.cwd(), LOCAL_SOURCE_DIR), pathname);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, input.body);
    return { url: `${LOCAL_SOURCE_PREFIX}${pathname}`, pathname };
  }
  return put(input.pathname, input.body, {
    access: "private",
    allowOverwrite: false,
    contentType: input.contentType,
    token,
  });
}

export async function readPrivateSource(url: string) {
  if (url.startsWith(LOCAL_SOURCE_PREFIX)) {
    const pathname = url.slice(LOCAL_SOURCE_PREFIX.length);
    const filePath = await checkedStoragePath(join(process.cwd(), LOCAL_SOURCE_DIR), pathname);
    if ((await stat(filePath)).size > 50 * 1024 * 1024) throw new Error("PDF exceeds the 50 MB limit.");
    return readFile(filePath);
  }
  const token = process.env.PRIVATE_BLOB_READ_WRITE_TOKEN;
  if (!token) throw new Error("PRIVATE_BLOB_READ_WRITE_TOKEN is required to read this source.");
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !parsed.hostname.endsWith(".private.blob.vercel-storage.com")) throw new Error("Invalid private source origin.");
  const result = await get(url, { access: "private", token, useCache: false, abortSignal: AbortSignal.timeout(30_000) });
  if (!result || result.statusCode !== 200) throw new Error("Private source was not found.");
  const reader = result.stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > 50 * 1024 * 1024) { await reader.cancel(); throw new Error("PDF exceeds the 50 MB limit."); }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function privateSourceResponse(url: string, filename: string, contentType: string) {
  const body = await readPrivateSource(url);
  return new Response(body, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `inline; filename="${filename.replace(/["\\\r\n]/g, "")}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function deletePrivateSource(url?: string) {
  if (!url) return;
  if (url.startsWith(LOCAL_SOURCE_PREFIX)) {
    const pathname = url.slice(LOCAL_SOURCE_PREFIX.length);
    const path = await checkedStoragePath(join(process.cwd(), LOCAL_SOURCE_DIR), pathname);
    await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    return;
  }
  const token = process.env.PRIVATE_BLOB_READ_WRITE_TOKEN;
  if (token) await del(url, { token }).catch(() => undefined);
}
