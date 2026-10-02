import { actionRequest } from "@/lib/server/action-request";
import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/server/api-error";

import { LibraryCollectionUpdateRequest } from "@/lib/schemas";
import { getUserContext } from "@/lib/server/auth";
import { getStore } from "@/lib/server/store";

export const runtime = "nodejs";

async function handlePATCH(
  request: Request,
  context: RouteContext<"/api/projects/[projectId]/library/collections/[collectionId]">,
) {
  try {
    const user = await getUserContext(request);
    const { projectId, collectionId } = await context.params;
    const store = getStore();
    const project = await store.getProject(projectId);
    if (!project || project.userId !== user.id) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    const collection = await store.getLibraryCollection(user.id, collectionId);
    if (!collection) {
      return NextResponse.json({ error: "Library collection not found" }, { status: 404 });
    }
    const body = LibraryCollectionUpdateRequest.parse(await request.json());
    const updatedCollection = await store.updateLibraryCollection(user.id, collectionId, {
      name: body.name,
      metadata: body.metadata ? { ...collection.metadata, ...body.metadata } : undefined,
      archived: body.archived,
    });
    const [libraryAssets, libraryCollections, media, sessions] = await Promise.all([
      store.listLibraryAssets(user.id),
      store.listLibraryCollections(user.id),
      store.listProjectMedia(projectId),
      store.listMediaSessions(projectId),
    ]);
    return NextResponse.json({
      projectId,
      collection: updatedCollection,
      archivedCollectionId: body.archived ? collectionId : undefined,
      libraryAssets,
      libraryCollections,
      media,
      sessions,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Library collection update failed";
    console.error("PATCH /api/projects/[projectId]/library/collections/[collectionId] failed", error);
    return apiErrorResponse(error, message);
  }
}

export async function PATCH(
  request: Request,
  context: RouteContext<"/api/projects/[projectId]/library/collections/[collectionId]">,
) {
  return actionRequest(request, () => handlePATCH(request, context));
}
