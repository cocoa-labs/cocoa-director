import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/server/api-error";

import { getUserContext } from "@/lib/server/auth";
import { pollProjectMediaGenerations } from "@/lib/server/media";
import { syncProjectMediaToLibrary } from "@/lib/server/library-vault";
import { getStore } from "@/lib/server/store";

export const runtime = "nodejs";

export async function GET(request: Request, context: RouteContext<"/api/projects/[projectId]">) {
  try {
    const user = await getUserContext(request);
    const { projectId } = await context.params;
    const project = await getStore().getProject(projectId);
    if (!project || project.userId !== user.id) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    await pollProjectMediaGenerations(projectId);
    await syncProjectMediaToLibrary(projectId);
    const [jobs, media, sessions, libraryAssets, libraryCollections] = await Promise.all([
      getStore().listProjectJobs(projectId),
      getStore().listProjectMedia(projectId),
      getStore().listMediaSessions(projectId),
      getStore().listLibraryAssets(user.id),
      getStore().listLibraryCollections(user.id),
    ]);
    return NextResponse.json({ project, jobs, media, sessions, libraryAssets, libraryCollections });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Project lookup failed";
    console.error("GET /api/projects/[projectId] failed", error);
    return apiErrorResponse(error, message);
  }
}
