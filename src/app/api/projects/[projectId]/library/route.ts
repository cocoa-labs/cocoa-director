import { actionRequest } from "@/lib/server/action-request";
import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/server/api-error";

import { LibraryAssetCreateRequest } from "@/lib/schemas";
import { getUserContext } from "@/lib/server/auth";
import { pollProjectMediaGenerations } from "@/lib/server/media";
import { syncProjectMediaToLibrary } from "@/lib/server/library-vault";
import { createLibraryAssetForProject } from "@/lib/server/media-sessions";
import { getStore } from "@/lib/server/store";

export const runtime = "nodejs";

export async function GET(request: Request, context: RouteContext<"/api/projects/[projectId]/library">) {
  try {
    const user = await getUserContext(request);
    const { projectId } = await context.params;
    const project = await getStore().getProject(projectId);
    if (!project || project.userId !== user.id) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    await pollProjectMediaGenerations(projectId);
    await syncProjectMediaToLibrary(projectId);
    const [libraryAssets, libraryCollections, media, sessions] = await Promise.all([
      getStore().listLibraryAssets(user.id),
      getStore().listLibraryCollections(user.id),
      getStore().listProjectMedia(projectId),
      getStore().listMediaSessions(projectId),
    ]);
    return NextResponse.json({ projectId, libraryAssets, libraryCollections, media, sessions });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Library lookup failed";
    console.error("GET /api/projects/[projectId]/library failed", error);
    return apiErrorResponse(error, message);
  }
}

async function handlePOST(request: Request, context: RouteContext<"/api/projects/[projectId]/library">) {
  try {
    const user = await getUserContext(request);
    const { projectId } = await context.params;
    const project = await getStore().getProject(projectId);
    if (!project || project.userId !== user.id) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    const body = LibraryAssetCreateRequest.parse(await request.json());
    const result = await createLibraryAssetForProject(projectId, user.id, body);
    const [libraryAssets, libraryCollections, media, sessions] = await Promise.all([
      getStore().listLibraryAssets(user.id),
      getStore().listLibraryCollections(user.id),
      getStore().listProjectMedia(projectId),
      getStore().listMediaSessions(projectId),
    ]);
    return NextResponse.json({ projectId, ...result, libraryAssets, libraryCollections, media, sessions }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Library asset creation failed";
    console.error("POST /api/projects/[projectId]/library failed", error);
    return apiErrorResponse(error, message);
  }
}

export async function POST(request: Request, context: RouteContext<"/api/projects/[projectId]/library">) {
  return actionRequest(request, () => handlePOST(request, context));
}
