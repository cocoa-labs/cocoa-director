import { actionRequest } from "@/lib/server/action-request";
import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/server/api-error";

import {
  ProjectAgentMessageRequest,
  ProjectAgentMessageResponse,
} from "@/lib/schemas";
import { createCocoaDirectorResponse } from "@/lib/server/project-agent";
import { authorizeProjectRequest } from "@/lib/server/projects";
import { getStore } from "@/lib/server/store";

export const runtime = "nodejs";

async function handlePOST(
  request: Request,
  context: RouteContext<"/api/projects/[projectId]/agent/message">,
) {
  try {
    const { projectId } = await context.params;
    const auth = await authorizeProjectRequest(request, projectId);
    if (auth.response) return auth.response;

    const body = ProjectAgentMessageRequest.parse(await request.json());
    const store = getStore();
    const [session, job] = await Promise.all([
      body.sessionId ? store.getMediaSession(projectId, body.sessionId) : Promise.resolve(null),
      body.videoJobId ? store.getJob(body.videoJobId) : Promise.resolve(null),
    ]);

    if (body.sessionId && !session) {
      return NextResponse.json({ error: "Media session not found" }, { status: 404 });
    }
    if (body.videoJobId && (!job || job.projectId !== projectId)) {
      return NextResponse.json({ error: "Video job does not belong to this project" }, { status: 404 });
    }

    if (session) {
      await store.createMediaSessionMessage({
        sessionId: session.id,
        role: "user",
        content: body.message,
      });
    }

    const media = await store.listProjectMedia(projectId);
    const agentResponse = await createCocoaDirectorResponse({
      projectId,
      message: body.message,
      session,
      job,
      media,
      context: {
        workspace: body.workspace,
        selectedAssetIds: body.selectedAssetIds,
        shotIndex: body.shotIndex,
      },
    });

    if (session) {
      const agentMessage = await store.createMediaSessionMessage({
        sessionId: session.id,
        role: "agent",
        content: agentResponse.reply,
        proposal: agentResponse.proposal,
      });
      await store.updateMediaSession(session.id, {
        settings: {
          ...session.settings,
          lastAgentMessageId: agentMessage.id,
          lastAgentAt: agentMessage.createdAt,
        },
      });
    }

    const messages = session ? await store.listMediaSessionMessages(session.id, 80) : [];
    return NextResponse.json(ProjectAgentMessageResponse.parse({
      reply: agentResponse.reply,
      proposal: agentResponse.proposal,
      messages,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cocoa Director failed";
    console.error("POST /api/projects/[projectId]/agent/message failed", error);
    return apiErrorResponse(error, message);
  }
}

export async function POST(
  request: Request,
  context: RouteContext<"/api/projects/[projectId]/agent/message">,
) {
  return actionRequest(request, () => handlePOST(request, context));
}
