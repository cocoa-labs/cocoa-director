import { actionRequest } from "@/lib/server/action-request";
import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/server/api-error";

import { MediaGenerationInjectRequest } from "@/lib/schemas";
import { injectMediaGeneration } from "@/lib/server/media";
import { authorizeProjectRequest } from "@/lib/server/projects";
import { getStore } from "@/lib/server/store";

export const runtime = "nodejs";

async function handlePOST(
  request: Request,
  context: RouteContext<"/api/projects/[projectId]/media/generations/[generationId]/inject">,
) {
  try {
    const { projectId, generationId } = await context.params;
    const auth = await authorizeProjectRequest(request, projectId);
    if (auth.response) return auth.response;

    const body = MediaGenerationInjectRequest.parse(await request.json());
    const result = await injectMediaGeneration(projectId, generationId, body);
    const library = await getStore().listProjectMedia(projectId);
    return NextResponse.json({ projectId, generationId, ...result, library });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Media injection failed";
    console.error("POST /api/projects/[projectId]/media/generations/[generationId]/inject failed", error);
    return apiErrorResponse(error, message);
  }
}

export async function POST(
  request: Request,
  context: RouteContext<"/api/projects/[projectId]/media/generations/[generationId]/inject">,
) {
  return actionRequest(request, () => handlePOST(request, context));
}
