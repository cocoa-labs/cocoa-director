import { actionRequest } from "@/lib/server/action-request";
import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/server/api-error";

import { MediaSessionCreateRequest } from "@/lib/schemas";
import { getUserContext } from "@/lib/server/auth";
import { createMediaSession } from "@/lib/server/media-sessions";
import { getStore } from "@/lib/server/store";

export const runtime = "nodejs";

export async function GET(request: Request, context: RouteContext<"/api/projects/[projectId]/media-sessions">) {
  try {
    const user = await getUserContext(request);
    const { projectId } = await context.params;
    const project = await getStore().getProject(projectId);
    if (!project || project.userId !== user.id) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    const sessions = await getStore().listMediaSessions(projectId);
    return NextResponse.json({ projectId, sessions });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Media session lookup failed";
    console.error("GET /api/projects/[projectId]/media-sessions failed", error);
    return apiErrorResponse(error, message);
  }
}

async function handlePOST(request: Request, context: RouteContext<"/api/projects/[projectId]/media-sessions">) {
  try {
    const user = await getUserContext(request);
    const { projectId } = await context.params;
    const project = await getStore().getProject(projectId);
    if (!project || project.userId !== user.id) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    const body = MediaSessionCreateRequest.parse(await request.json());
    const session = await createMediaSession(projectId, body);
    const sessions = await getStore().listMediaSessions(projectId);
    return NextResponse.json({ projectId, session, sessions }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Media session creation failed";
    console.error("POST /api/projects/[projectId]/media-sessions failed", error);
    return apiErrorResponse(error, message);
  }
}

export async function POST(request: Request, context: RouteContext<"/api/projects/[projectId]/media-sessions">) {
  return actionRequest(request, () => handlePOST(request, context));
}
