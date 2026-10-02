import { MediaKind } from "@/lib/schemas";

export type UploadPayload = {
  projectId?: string;
  kind: MediaKind;
  name?: string;
  role?: string;
  tags: string[];
};

/** Parse the JSON clientPayload sent with an upload. Returns null on any malformed input. */
export function parseUploadPayload(payload: string | null | undefined): UploadPayload | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as {
      userId?: string;
      projectId?: string;
      kind?: unknown;
      name?: string;
      role?: string;
      tags?: string[];
    };
    const kind = MediaKind.parse(parsed.kind);
    return {
      projectId: parsed.projectId,
      kind,
      name: parsed.name,
      role: parsed.role,
      tags: parsed.tags ?? [],
    };
  } catch {
    return null;
  }
}

export function mimeTypeForKind(kind: MediaKind) {
  if (kind === "image") return "image/png";
  if (kind === "video") return "video/mp4";
  if (kind === "music") return "audio/mpeg";
  return "application/octet-stream";
}

export function allowedContentTypesForKind(kind: MediaKind) {
  if (kind === "image") return ["image/png", "image/jpeg", "image/webp"];
  if (kind === "video") return ["video/mp4", "video/quicktime", "video/webm"];
  if (kind === "music") return ["audio/mpeg", "audio/wav", "audio/mp4", "audio/x-m4a"];
  return ["application/octet-stream"];
}

export function uploadLimitForKind(kind: MediaKind) {
  if (kind === "image") return 25 * 1024 * 1024;
  if (kind === "video") return 200 * 1024 * 1024;
  if (kind === "music") return 50 * 1024 * 1024;
  return 10 * 1024 * 1024;
}

export function slugFilename(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "") || "asset";
}
