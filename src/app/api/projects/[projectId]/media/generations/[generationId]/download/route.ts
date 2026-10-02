import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/server/api-error";

import type { MediaAsset, MediaGeneration, MediaKind } from "@/lib/schemas";
import { fetchBlobUrl } from "@/lib/server/blob";
import { syncProjectMediaToLibrary } from "@/lib/server/library-vault";
import { pollProjectMediaGenerations } from "@/lib/server/media";
import { authorizeProjectRequest } from "@/lib/server/projects";
import { getStore } from "@/lib/server/store";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: RouteContext<"/api/projects/[projectId]/media/generations/[generationId]/download">,
) {
  try {
    const { projectId, generationId } = await context.params;
    const auth = await authorizeProjectRequest(request, projectId);
    if (auth.response) return auth.response;

    await pollProjectMediaGenerations(projectId);
    await syncProjectMediaToLibrary(projectId);
    const store = getStore();
    const generation = await store.getMediaGeneration(projectId, generationId);
    if (!generation) {
      return NextResponse.json({ error: "Media generation not found" }, { status: 404 });
    }

    const media = await store.listProjectMedia(projectId);
    const asset = primaryAssetForGeneration(media.assets, generation);
    if (!asset) {
      if (generation.status === "draft" || generation.status === "queued" || generation.status === "running") {
        return NextResponse.json({ error: "Media generation output is not ready yet" }, { status: 409 });
      }
      return NextResponse.json({ error: "Media generation output not found" }, { status: 404 });
    }

    const upstream = await fetchBlobUrl(asset.url);
    if (!upstream.ok || !upstream.body) {
      return NextResponse.json({ error: "Media generation output could not be downloaded" }, { status: 502 });
    }

    const headers = new Headers();
    headers.set("Content-Type", asset.mimeType || upstream.headers.get("content-type") || "application/octet-stream");
    headers.set("Content-Disposition", `attachment; filename="${contentDispositionFileName(downloadFileName(generation, asset))}"`);
    headers.set("Cache-Control", "no-store");

    const contentLength = upstream.headers.get("content-length");
    if (contentLength) headers.set("Content-Length", contentLength);

    return new Response(upstream.body, { headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Media generation download failed";
    console.error("GET /api/projects/[projectId]/media/generations/[generationId]/download failed", error);
    return apiErrorResponse(error, message);
  }
}

function primaryAssetForGeneration(assets: MediaAsset[], generation: MediaGeneration) {
  const assetId = stringMetadata(generation.metadata.assetId);
  return (
    (assetId ? assets.find((asset) => asset.id === assetId) : undefined) ??
    assets.find((asset) => asset.generationId === generation.id) ??
    assetFromOutputUrls(generation)
  );
}

function assetFromOutputUrls(generation: MediaGeneration): MediaAsset | null {
  const entry = Object.entries(generation.outputUrls)[0];
  if (!entry) return null;
  return {
    id: generation.id,
    projectId: generation.projectId,
    videoJobId: generation.videoJobId,
    generationId: generation.id,
    kind: generation.kind,
    role: entry[0],
    url: entry[1],
    mimeType: mimeTypeForKind(generation.kind),
    metadata: {},
    createdAt: generation.updatedAt,
  };
}

function downloadFileName(generation: MediaGeneration, asset: MediaAsset) {
  return `cocoa-director-${generation.kind}-${generation.id.slice(0, 8)}.${extensionForMimeType(asset.mimeType, generation.kind)}`;
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

function mimeTypeForKind(kind: MediaKind) {
  if (kind === "image") return "image/png";
  if (kind === "music") return "audio/mpeg";
  if (kind === "video" || kind === "render") return "video/mp4";
  return "application/octet-stream";
}

function contentDispositionFileName(fileName: string) {
  return fileName.replace(/["\\\r\n]/g, "-");
}

function stringMetadata(value: unknown) {
  return typeof value === "string" ? value : undefined;
}
