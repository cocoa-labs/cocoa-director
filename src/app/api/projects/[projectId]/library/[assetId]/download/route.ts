import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/server/api-error";

import type { LibraryAsset, MediaKind } from "@/lib/schemas";
import { getUserContext } from "@/lib/server/auth";
import { fetchBlobUrl } from "@/lib/server/blob";
import { getStore } from "@/lib/server/store";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: RouteContext<"/api/projects/[projectId]/library/[assetId]/download">,
) {
  try {
    const user = await getUserContext(request);
    const { projectId, assetId } = await context.params;
    const store = getStore();
    const project = await store.getProject(projectId);
    if (!project || project.userId !== user.id) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const asset = await store.getLibraryAsset(user.id, assetId);
    if (!asset) {
      return NextResponse.json({ error: "Library asset not found" }, { status: 404 });
    }

    const upstream = await fetchBlobUrl(asset.url);
    if (!upstream.ok || !upstream.body) {
      return NextResponse.json({ error: "Library asset could not be downloaded" }, { status: 502 });
    }

    const headers = new Headers();
    headers.set("Content-Type", asset.mimeType || upstream.headers.get("content-type") || "application/octet-stream");
    headers.set("Content-Disposition", `attachment; filename="${contentDispositionFileName(libraryAssetFileName(asset))}"`);
    headers.set("Cache-Control", "no-store");

    const contentLength = upstream.headers.get("content-length");
    if (contentLength) headers.set("Content-Length", contentLength);

    return new Response(upstream.body, { headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Library asset download failed";
    console.error("GET /api/projects/[projectId]/library/[assetId]/download failed", error);
    return apiErrorResponse(error, message);
  }
}

function libraryAssetFileName(asset: LibraryAsset) {
  const base = slugFilename(asset.name) || `cocoa-vault-${asset.kind}`;
  return `${base}-${asset.id.slice(0, 8)}.${extensionForMimeType(asset.mimeType, asset.kind)}`;
}

function extensionForMimeType(mimeType: string, kind: MediaKind) {
  if (mimeType.includes("png")) return "png";
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return "jpg";
  if (mimeType.includes("webp")) return "webp";
  if (mimeType.includes("quicktime")) return "mov";
  if (mimeType.includes("webm")) return "webm";
  if (mimeType.includes("mp4")) return kind === "music" ? "m4a" : "mp4";
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3";
  if (kind === "image") return "png";
  if (kind === "video" || kind === "render") return "mp4";
  if (kind === "music") return "mp3";
  return "bin";
}

function contentDispositionFileName(fileName: string) {
  return fileName.replace(/["\\\r\n]/g, "-");
}

function slugFilename(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "") || "asset";
}
