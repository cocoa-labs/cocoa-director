import { actionRequest } from "@/lib/server/action-request";
import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/server/api-error";

import { LibraryCollectionCreateRequest } from "@/lib/schemas";
import { getUserContext } from "@/lib/server/auth";
import { getStore } from "@/lib/server/store";

export const runtime = "nodejs";

async function handlePOST(request: Request, context: RouteContext<"/api/projects/[projectId]/library/collections">) {
  try {
    const user = await getUserContext(request);
    const { projectId } = await context.params;
    const store = getStore();
    const project = await store.getProject(projectId);
    if (!project || project.userId !== user.id) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    const body = LibraryCollectionCreateRequest.parse(await request.json());
    const collection = await store.createLibraryCollection({
      userId: user.id,
      name: body.name,
      metadata: body.metadata,
      assetIds: body.assetIds,
    });
    const [libraryAssets, libraryCollections, media, sessions] = await Promise.all([
      store.listLibraryAssets(user.id),
      store.listLibraryCollections(user.id),
      store.listProjectMedia(projectId),
      store.listMediaSessions(projectId),
    ]);
    return NextResponse.json({ projectId, collection, libraryAssets, libraryCollections, media, sessions }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Library collection creation failed";
    console.error("POST /api/projects/[projectId]/library/collections failed", error);
    return apiErrorResponse(error, message);
  }
}

export async function POST(request: Request, context: RouteContext<"/api/projects/[projectId]/library/collections">) {
  return actionRequest(request, () => handlePOST(request, context));
}
