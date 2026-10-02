import { actionRequest } from "@/lib/server/action-request";
import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/server/api-error";

import { getUserContext } from "@/lib/server/auth";
import { pinLibraryAssetToProject } from "@/lib/server/media-sessions";
import { getStore } from "@/lib/server/store";
import { nowIso } from "@/lib/trace";

export const runtime = "nodejs";

async function handlePOST(
  request: Request,
  context: RouteContext<"/api/projects/[projectId]/library/collections/[collectionId]/pin">,
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
    const mediaAssets = [];
    for (const assetId of collection.assetIds) {
      const asset = await store.getLibraryAsset(user.id, assetId);
      if (!asset) continue;
      mediaAssets.push(await pinLibraryAssetToProject(projectId, asset));
      await store.updateLibraryAsset(user.id, assetId, {
        metadata: {
          ...asset.metadata,
          lastUsedAt: nowIso(),
          lastUsedProjectId: projectId,
          lastUsedCollectionId: collectionId,
        },
      });
    }
    const [libraryAssets, libraryCollections, media, sessions] = await Promise.all([
      store.listLibraryAssets(user.id),
      store.listLibraryCollections(user.id),
      store.listProjectMedia(projectId),
      store.listMediaSessions(projectId),
    ]);
    return NextResponse.json({ projectId, collectionId, mediaAssets, libraryAssets, libraryCollections, media, sessions });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Library collection pin failed";
    console.error("POST /api/projects/[projectId]/library/collections/[collectionId]/pin failed", error);
    return apiErrorResponse(error, message);
  }
}

export async function POST(
  request: Request,
  context: RouteContext<"/api/projects/[projectId]/library/collections/[collectionId]/pin">,
) {
  return actionRequest(request, () => handlePOST(request, context));
}
