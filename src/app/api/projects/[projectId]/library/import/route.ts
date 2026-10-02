import { actionRequest } from "@/lib/server/action-request";
import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/server/api-error";

import { LibraryUrlImportRequest } from "@/lib/schemas";
import { getUserContext } from "@/lib/server/auth";
import { importLibraryUrlForProject } from "@/lib/server/media-sessions";
import { SsrfError } from "@/lib/server/ssrf";
import { getStore } from "@/lib/server/store";

export const runtime = "nodejs";

async function handlePOST(request: Request, context: RouteContext<"/api/projects/[projectId]/library/import">) {
  try {
    const user = await getUserContext(request);
    const { projectId } = await context.params;
    const project = await getStore().getProject(projectId);
    if (!project || project.userId !== user.id) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    const body = LibraryUrlImportRequest.parse(await request.json());
    const result = await importLibraryUrlForProject(projectId, user.id, body);
    const [libraryAssets, libraryCollections, media, sessions] = await Promise.all([
      getStore().listLibraryAssets(user.id),
      getStore().listLibraryCollections(user.id),
      getStore().listProjectMedia(projectId),
      getStore().listMediaSessions(projectId),
    ]);
    return NextResponse.json({ projectId, ...result, libraryAssets, libraryCollections, media, sessions }, { status: 201 });
  } catch (error) {
    if (error instanceof SsrfError) {
      // User-supplied URL pointed at an internal/blocked host — client error.
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    const message = error instanceof Error ? error.message : "URL import failed";
    console.error("POST /api/projects/[projectId]/library/import failed", error);
    return apiErrorResponse(error, message);
  }
}

export async function POST(request: Request, context: RouteContext<"/api/projects/[projectId]/library/import">) {
  return actionRequest(request, () => handlePOST(request, context));
}
