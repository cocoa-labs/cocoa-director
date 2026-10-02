import { actionRequest } from "@/lib/server/action-request";
import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/server/api-error";

import { getUserContext } from "@/lib/server/auth";
import { fetchBlobUrl } from "@/lib/server/blob";
import { exportMediaSessionVersion } from "@/lib/server/media-sessions";
import { getStore } from "@/lib/server/store";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: RouteContext<"/api/projects/[projectId]/media-sessions/[sessionId]/export">,
) {
  try {
    const user = await getUserContext(request);
    const { projectId, sessionId } = await context.params;
    const project = await getStore().getProject(projectId);
    if (!project || project.userId !== user.id) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const versionId = new URL(request.url).searchParams.get("versionId") ?? undefined;
    const result = await exportMediaSessionVersion(projectId, sessionId, versionId);
    const upstream = await fetchBlobUrl(result.asset.url);
    if (!upstream.ok || !upstream.body) {
      return NextResponse.json({ error: "Export asset could not be downloaded" }, { status: 502 });
    }

    const headers = new Headers();
    headers.set("Content-Type", result.asset.mimeType || upstream.headers.get("content-type") || "application/octet-stream");
    headers.set("Content-Disposition", `attachment; filename="${contentDispositionFileName(result.fileName)}"`);
    headers.set("Cache-Control", "no-store");

    const contentLength = upstream.headers.get("content-length");
    if (contentLength) headers.set("Content-Length", contentLength);

    return new Response(upstream.body, { headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Media session export failed";
    console.error("GET /api/projects/[projectId]/media-sessions/[sessionId]/export failed", error);
    return apiErrorResponse(error, message);
  }
}

async function handlePOST(
  request: Request,
  context: RouteContext<"/api/projects/[projectId]/media-sessions/[sessionId]/export">,
) {
  try {
    const user = await getUserContext(request);
    const { projectId, sessionId } = await context.params;
    const project = await getStore().getProject(projectId);
    if (!project || project.userId !== user.id) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    const body = await request.json().catch(() => ({} as { versionId?: string }));
    const result = await exportMediaSessionVersion(projectId, sessionId, body.versionId);
    const params = new URLSearchParams();
    if (body.versionId) params.set("versionId", body.versionId);
    const downloadPath = `/api/projects/${projectId}/media-sessions/${sessionId}/export${params.size ? `?${params.toString()}` : ""}`;
    return NextResponse.json({ projectId, ...result, downloadUrl: downloadPath, sourceUrl: result.downloadUrl });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Media session export failed";
    console.error("POST /api/projects/[projectId]/media-sessions/[sessionId]/export failed", error);
    return apiErrorResponse(error, message);
  }
}

function contentDispositionFileName(fileName: string) {
  return fileName.replace(/["\\\r\n]/g, "-");
}

export async function POST(
  request: Request,
  context: RouteContext<"/api/projects/[projectId]/media-sessions/[sessionId]/export">,
) {
  return actionRequest(request, () => handlePOST(request, context));
}
