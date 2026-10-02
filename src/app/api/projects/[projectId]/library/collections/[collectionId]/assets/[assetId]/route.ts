import { actionRequest } from "@/lib/server/action-request";
import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/server/api-error";

import { getUserContext } from "@/lib/server/auth";
import { getStore } from "@/lib/server/store";

export const runtime = "nodejs";

async function handlePOST(
  request: Request,
  context: RouteContext<"/api/projects/[projectId]/library/collections/[collectionId]/assets/[assetId]">,
) {
  return updateCollectionAsset(request, context, "add");
}

async function handleDELETE(
  request: Request,
  context: RouteContext<"/api/projects/[projectId]/library/collections/[collectionId]/assets/[assetId]">,
) {
  return updateCollectionAsset(request, context, "remove");
}

async function updateCollectionAsset(
  request: Request,
  context: RouteContext<"/api/projects/[projectId]/library/collections/[collectionId]/assets/[assetId]">,
  action: "add" | "remove",
) {
  try {
    const user = await getUserContext(request);
    const { projectId, collectionId, assetId } = await context.params;
    const store = getStore();
    const project = await store.getProject(projectId);
    if (!project || project.userId !== user.id) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    const collection = action === "add"
      ? await store.addLibraryAssetToCollection(user.id, collectionId, assetId)
      : await store.removeLibraryAssetFromCollection(user.id, collectionId, assetId);
    if (!collection) {
      return NextResponse.json({ error: "Library collection or asset not found" }, { status: 404 });
    }
    const [libraryAssets, libraryCollections, media, sessions] = await Promise.all([
      store.listLibraryAssets(user.id),
      store.listLibraryCollections(user.id),
      store.listProjectMedia(projectId),
      store.listMediaSessions(projectId),
    ]);
    return NextResponse.json({ projectId, collection, libraryAssets, libraryCollections, media, sessions });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Library collection asset update failed";
    console.error("POST/DELETE /api/projects/[projectId]/library/collections/[collectionId]/assets/[assetId] failed", error);
    return apiErrorResponse(error, message);
  }
}

export async function POST(
  request: Request,
  context: RouteContext<"/api/projects/[projectId]/library/collections/[collectionId]/assets/[assetId]">,
) {
  return actionRequest(request, () => handlePOST(request, context));
}

export async function DELETE(
  request: Request,
  context: RouteContext<"/api/projects/[projectId]/library/collections/[collectionId]/assets/[assetId]">,
) {
  return actionRequest(request, () => handleDELETE(request, context));
}
