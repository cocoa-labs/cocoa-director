import { actionRequest } from "@/lib/server/action-request";
import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/server/api-error";

import {
  RenderAgentMessageRequest,
  RenderAgentMessageResponse,
  type AgentActionProposal,
  type RenderAgentProposal,
} from "@/lib/schemas";
import { createCocoaDirectorResponse } from "@/lib/server/project-agent";
import { authorizeProjectRequest } from "@/lib/server/projects";
import { getStore } from "@/lib/server/store";

export const runtime = "nodejs";

async function handlePOST(
  request: Request,
  context: RouteContext<"/api/projects/[projectId]/render-agent/message">,
) {
  try {
    const { projectId } = await context.params;
    const auth = await authorizeProjectRequest(request, projectId);
    if (auth.response) return auth.response;

    const body = RenderAgentMessageRequest.parse(await request.json());
    const store = getStore();
    const job = body.videoJobId ? await store.getJob(body.videoJobId) : null;
    if (body.videoJobId && (!job || job.projectId !== projectId)) {
      return NextResponse.json({ error: "Video job does not belong to this project" }, { status: 404 });
    }
    const media = await store.listProjectMedia(projectId);
    const response = await createCocoaDirectorResponse({
      projectId,
      message: body.message,
      job,
      media,
      context: {},
    });
    return NextResponse.json(RenderAgentMessageResponse.parse({
      reply: response.reply,
      proposal: renderProposalFromAgentProposal(response.proposal),
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cocoa Director failed";
    console.error("POST /api/projects/[projectId]/render-agent/message compatibility route failed", error);
    return apiErrorResponse(error, message);
  }
}

function renderProposalFromAgentProposal(proposal?: AgentActionProposal): RenderAgentProposal | undefined {
  if (!proposal || proposal.actionType !== "media_generation" || !proposal.kind || !proposal.prompt) return undefined;
  return {
    title: proposal.title,
    rationale: proposal.rationale,
    kind: proposal.kind,
    provider: proposal.provider ?? "mock",
    prompt: proposal.prompt,
    controls: proposal.controls,
    inputAssetIds: proposal.inputAssetIds,
    injectionAction: proposal.injectionAction,
    targetId: proposal.targetId,
    costRisk: proposal.costRisk,
  };
}

export async function POST(
  request: Request,
  context: RouteContext<"/api/projects/[projectId]/render-agent/message">,
) {
  return actionRequest(request, () => handlePOST(request, context));
}
