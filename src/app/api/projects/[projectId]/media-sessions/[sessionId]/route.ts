import { actionRequest } from "@/lib/server/action-request";
import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/server/api-error";

import { getUserContext } from "@/lib/server/auth";
import { getStore } from "@/lib/server/store";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: RouteContext<"/api/projects/[projectId]/media-sessions/[sessionId]">,
) {
  try {
    const user = await getUserContext(request);
    const { projectId, sessionId } = await context.params;
    const project = await getStore().getProject(projectId);
    if (!project || project.userId !== user.id) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    const session = await getStore().getMediaSession(projectId, sessionId);
    if (!session) return NextResponse.json({ error: "Media session not found" }, { status: 404 });
    const media = await getStore().listProjectMedia(projectId);
    return NextResponse.json({ projectId, session, media });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Media session lookup failed";
    console.error("GET /api/projects/[projectId]/media-sessions/[sessionId] failed", error);
    return apiErrorResponse(error, message);
  }
}

async function handleDELETE(
  request: Request,
  context: RouteContext<"/api/projects/[projectId]/media-sessions/[sessionId]">,
) {
  try {
    const user = await getUserContext(request);
    const { projectId, sessionId } = await context.params;
    const project = await getStore().getProject(projectId);
    if (!project || project.userId !== user.id) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    const session = await getStore().archiveMediaSession(projectId, sessionId);
    if (!session) return NextResponse.json({ error: "Media session not found" }, { status: 404 });
    const [media, sessions] = await Promise.all([
      getStore().listProjectMedia(projectId),
      getStore().listMediaSessions(projectId),
    ]);
    return NextResponse.json({ projectId, archivedSessionId: session.id, media, sessions });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Media session archive failed";
    console.error("DELETE /api/projects/[projectId]/media-sessions/[sessionId] failed", error);
    return apiErrorResponse(error, message);
  }
}

export async function DELETE(
  request: Request,
  context: RouteContext<"/api/projects/[projectId]/media-sessions/[sessionId]">,
) {
  return actionRequest(request, () => handleDELETE(request, context));
}
