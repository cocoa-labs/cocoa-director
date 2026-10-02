import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/server/api-error";

import { syncProjectMediaToLibrary } from "@/lib/server/library-vault";
import { pollProjectMediaGenerations } from "@/lib/server/media";
import { authorizeProjectRequest } from "@/lib/server/projects";
import { getStore } from "@/lib/server/store";

export const runtime = "nodejs";

export async function GET(request: Request, context: RouteContext<"/api/projects/[projectId]/media">) {
  try {
    const { projectId } = await context.params;
    const auth = await authorizeProjectRequest(request, projectId);
    if (auth.response) return auth.response;

    await pollProjectMediaGenerations(projectId);
    await syncProjectMediaToLibrary(projectId);
    const media = await getStore().listProjectMedia(projectId);
    return NextResponse.json({ projectId, ...media });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Project media lookup failed";
    console.error("GET /api/projects/[projectId]/media failed", error);
    return apiErrorResponse(error, message);
  }
}
