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
  context: RouteContext<"/api/projects/[projectId]/library/[assetId]/pin">,
) {
  try {
    const user = await getUserContext(request);
    const { projectId, assetId } = await context.params;
    const store = getStore();
    const project = await store.getProject(projectId);
    if (!project || project.userId !== user.id) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const libraryAsset = await store.getLibraryAsset(user.id, assetId);
    if (!libraryAsset) {
      return NextResponse.json({ error: "Library asset not found" }, { status: 404 });
    }

    const mediaAsset = await pinLibraryAssetToProject(projectId, libraryAsset);
    await store.updateLibraryAsset(user.id, assetId, {
      metadata: {
        ...libraryAsset.metadata,
        lastUsedAt: nowIso(),
        lastUsedProjectId: projectId,
      },
    });
    const [libraryAssets, libraryCollections, media, sessions] = await Promise.all([
      store.listLibraryAssets(user.id),
      store.listLibraryCollections(user.id),
      store.listProjectMedia(projectId),
      store.listMediaSessions(projectId),
    ]);

    return NextResponse.json({ projectId, libraryAsset, mediaAsset, libraryAssets, libraryCollections, media, sessions });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Library asset pin failed";
    console.error("POST /api/projects/[projectId]/library/[assetId]/pin failed", error);
    return apiErrorResponse(error, message);
  }
}

export async function POST(
  request: Request,
  context: RouteContext<"/api/projects/[projectId]/library/[assetId]/pin">,
) {
  return actionRequest(request, () => handlePOST(request, context));
}
