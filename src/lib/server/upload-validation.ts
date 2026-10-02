import type { MediaKind } from "@/lib/schemas";
import { fetchGuarded } from "@/lib/server/ssrf";
import { uploadLimitForKind } from "@/lib/server/library-upload";
import { ApiRequestError } from "@/lib/server/api-error";

export class UploadValidationError extends ApiRequestError {
  constructor(
    message: string,
    status = 415,
  ) {
    super(message, status, "invalid_upload_type");
  }
}

export async function validateRemoteUpload(url: string, kind: MediaKind, declaredMime?: string | null) {
  if (kind === "render") throw new UploadValidationError("Render uploads are not supported.", 415);
  if (!declaredMime || declaredMime === "application/octet-stream") {
    throw new UploadValidationError("Upload type is not specific enough.", 415);
  }
  const response = await fetchGuarded(url, { maxBytes: uploadLimitForKind(kind) });
  if (!response.ok) throw new UploadValidationError("Uploaded file could not be inspected.", 400);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > uploadLimitForKind(kind)) throw new UploadValidationError("Uploaded file exceeds its size limit.", 413);
  if (bytes.length === 0) throw new UploadValidationError("Uploaded file is empty.", 400);
  const detected = detectMime(bytes);
  if (!detected || !mimeAllowedForKind(kind, detected) || detected !== normalizeMime(declaredMime)) {
    throw new UploadValidationError("Uploaded file does not match the selected media type.", 415);
  }
  return { mime: detected };
}

/**
 * Validate already-in-memory upload bytes (the leading bytes are enough for the magic-byte
 * sniff). Used by the direct/dev upload path, which has the file bytes in hand and can't
 * re-fetch a relative /dev-blob/ URL the way validateRemoteUpload does.
 */
export function validateUploadBytes(bytes: Uint8Array, kind: MediaKind, declaredMime?: string | null) {
  if (kind === "render") throw new UploadValidationError("Render uploads are not supported.", 415);
  if (!declaredMime || declaredMime === "application/octet-stream") {
    throw new UploadValidationError("Upload type is not specific enough.", 415);
  }
  if (bytes.length > uploadLimitForKind(kind)) throw new UploadValidationError("Uploaded file exceeds its size limit.", 413);
  if (bytes.length === 0) throw new UploadValidationError("Uploaded file is empty.", 400);
  const detected = detectMime(bytes);
  if (!detected || !mimeAllowedForKind(kind, detected) || detected !== normalizeMime(declaredMime)) {
    throw new UploadValidationError("Uploaded file does not match the selected media type.", 415);
  }
  return { mime: detected };
}

function detectMime(bytes: Uint8Array) {
  if (matches(bytes, [0x89, 0x50, 0x4e, 0x47])) return "image/png";
  if (matches(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";
  if (ascii(bytes, 4, 4) === "ftyp") {
    const brand = ascii(bytes, 8, 12);
    if (/qt  /.test(brand)) return "video/quicktime";
    if (/M4A|mp42|isom|iso2|avc1|mp41/.test(brand)) return "video/mp4";
  }
  if (matches(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return "video/webm";
  if (ascii(bytes, 0, 3) === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return "audio/mpeg";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE") return "audio/wav";
  return null;
}

function normalizeMime(mime: string) {
  if (mime === "audio/x-m4a" || mime === "audio/mp4") return "video/mp4";
  return mime;
}

function mimeAllowedForKind(kind: Exclude<MediaKind, "render">, mime: string) {
  if (kind === "image") return mime === "image/png" || mime === "image/jpeg" || mime === "image/webp";
  if (kind === "video") return mime === "video/mp4" || mime === "video/quicktime" || mime === "video/webm";
  if (kind === "music") return mime === "audio/mpeg" || mime === "audio/wav" || mime === "video/mp4";
  return false;
}

function matches(bytes: Uint8Array, signature: number[]) {
  return signature.every((byte, index) => bytes[index] === byte);
}

function ascii(bytes: Uint8Array, offset: number, length: number) {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}
