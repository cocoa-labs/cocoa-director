import { createReadStream, createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { extract } from "tar-stream";
import xz from "xz-decompress";

/** Vercel Functions have no tar. Only call after verifying the pinned archive hash. */
export async function extractMediaArchive(archive: string, destination: string, archiveDirectory: string) {
  const expected = new Map(["ffmpeg", "ffprobe"].map((name) => [`${archiveDirectory}/bin/${name}`, name]));
  const found = new Set<string>();
  await mkdir(join(destination, "bin"), { recursive: true });
  const unpack = extract();
  const signal = AbortSignal.timeout(120_000);
  unpack.on("entry", (header, stream, next) => {
    const name = expected.get(header.name);
    if (!name) { stream.resume(); stream.on("end", next); return; }
    if (header.type !== "file" || found.has(name) || !header.size || header.size > 200 * 1024 * 1024) {
      unpack.destroy(new Error("Invalid media executable archive entry."));
      return;
    }
    found.add(name);
    // The destination comes from the allowlist, never an archive path or symlink.
    void pipeline(stream, createWriteStream(join(destination, "bin", name), { flags: "wx", mode: 0o600 }), { signal })
      .then(() => next(), (error: Error) => { unpack.destroy(error); });
  });
  let size = 0;
  const bounded = new Transform({ transform(chunk, _encoding, callback) {
    size += chunk.length;
    callback(size > 768 * 1024 * 1024 ? new Error("Expanded media archive exceeds its size limit.") : null, chunk);
  } });
  const compressed = Readable.toWeb(createReadStream(archive)) as ReadableStream<Uint8Array>;
  const reader = new xz.XzReadableStream(compressed).getReader();
  const decompressed = Readable.from((async function* () {
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; yield value; }
    } finally { await reader.cancel(); }
  })());
  await pipeline(decompressed, bounded, unpack, { signal });
  if (found.size !== expected.size) throw new Error("Media archive is missing required executables.");
}
