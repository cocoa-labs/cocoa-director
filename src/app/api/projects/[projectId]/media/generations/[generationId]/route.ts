import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/server/api-error";

import { syncProjectMediaToLibrary } from "@/lib/server/library-vault";
import { pollProjectMediaGenerations } from "@/lib/server/media";
import { authorizeProjectRequest } from "@/lib/server/projects";
import { getStore } from "@/lib/server/store";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: RouteContext<"/api/projects/[projectId]/media/generations/[generationId]">,
) {
  try {
    const { projectId, generationId } = await context.params;
    const auth = await authorizeProjectRequest(request, projectId);
    if (auth.response) return auth.response;

    await pollProjectMediaGenerations(projectId);
    await syncProjectMediaToLibrary(projectId);
    const generation = await getStore().getMediaGeneration(projectId, generationId);
    if (!generation) {
      return NextResponse.json({ error: "Media generation not found" }, { status: 404 });
    }
    return NextResponse.json({ projectId, generation });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Media generation lookup failed";
    console.error("GET /api/projects/[projectId]/media/generations/[generationId] failed", error);
    return apiErrorResponse(error, message);
  }
}
