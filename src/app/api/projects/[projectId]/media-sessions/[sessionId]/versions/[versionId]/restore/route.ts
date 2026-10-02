import { actionRequest } from "@/lib/server/action-request";
import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/server/api-error";

import { getUserContext } from "@/lib/server/auth";
import { restoreMediaSessionVersion } from "@/lib/server/media-sessions";
import { getStore } from "@/lib/server/store";

export const runtime = "nodejs";

async function handlePOST(
  request: Request,
  context: RouteContext<"/api/projects/[projectId]/media-sessions/[sessionId]/versions/[versionId]/restore">,
) {
  try {
    const user = await getUserContext(request);
    const { projectId, sessionId, versionId } = await context.params;
    const project = await getStore().getProject(projectId);
    if (!project || project.userId !== user.id) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    const result = await restoreMediaSessionVersion(projectId, sessionId, versionId);
    const sessions = await getStore().listMediaSessions(projectId);
    return NextResponse.json({ projectId, ...result, sessions });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Media session restore failed";
    console.error("POST /api/projects/[projectId]/media-sessions/[sessionId]/versions/[versionId]/restore failed", error);
    return apiErrorResponse(error, message);
  }
}

export async function POST(
  request: Request,
  context: RouteContext<"/api/projects/[projectId]/media-sessions/[sessionId]/versions/[versionId]/restore">,
) {
  return actionRequest(request, () => handlePOST(request, context));
}
