import { actionRequest } from "@/lib/server/action-request";
import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/server/api-error";

import {
  MediaSessionAgentMessageRequest,
  MediaSessionAgentMessageResponse,
} from "@/lib/schemas";
import { createCocoaDirectorResponse } from "@/lib/server/project-agent";
import { authorizeProjectRequest } from "@/lib/server/projects";
import { getStore } from "@/lib/server/store";

export const runtime = "nodejs";

async function handlePOST(
  request: Request,
  context: RouteContext<"/api/projects/[projectId]/media-sessions/[sessionId]/agent/message">,
) {
  try {
    const { projectId, sessionId } = await context.params;
    const auth = await authorizeProjectRequest(request, projectId);
    if (auth.response) return auth.response;

    const body = MediaSessionAgentMessageRequest.parse(await request.json());
    const store = getStore();
    const session = await store.getMediaSession(projectId, sessionId);
    if (!session) {
      return NextResponse.json({ error: "Media session not found" }, { status: 404 });
    }

    const job = body.videoJobId ? await store.getJob(body.videoJobId) : null;
    if (body.videoJobId && (!job || job.projectId !== projectId)) {
      return NextResponse.json({ error: "Video job does not belong to this project" }, { status: 404 });
    }

    await store.createMediaSessionMessage({
      sessionId,
      role: "user",
      content: body.message,
    });

    const media = await store.listProjectMedia(projectId);
    const agentResponse = await createCocoaDirectorResponse({
      projectId,
      message: body.message,
      session,
      job,
      media,
      context: {},
    });
    const agentMessage = await store.createMediaSessionMessage({
      sessionId,
      role: "agent",
      content: agentResponse.reply,
      proposal: agentResponse.proposal,
    });
    await store.updateMediaSession(sessionId, {
      settings: {
        ...session.settings,
        lastAgentMessageId: agentMessage.id,
        lastAgentAt: agentMessage.createdAt,
      },
    });

    const messages = await store.listMediaSessionMessages(sessionId, 80);
    return NextResponse.json(MediaSessionAgentMessageResponse.parse({
      reply: agentResponse.reply,
      proposal: agentResponse.proposal,
      messages,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cocoa Director failed";
    console.error("POST /api/projects/[projectId]/media-sessions/[sessionId]/agent/message compatibility route failed", error);
    return apiErrorResponse(error, message);
  }
}

export async function POST(
  request: Request,
  context: RouteContext<"/api/projects/[projectId]/media-sessions/[sessionId]/agent/message">,
) {
  return actionRequest(request, () => handlePOST(request, context));
}
