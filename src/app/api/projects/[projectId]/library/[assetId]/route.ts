import { actionRequest } from "@/lib/server/action-request";
import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/server/api-error";

import { LibraryAssetUpdateRequest } from "@/lib/schemas";
import { deleteBlobUrl } from "@/lib/server/blob";
import { getUserContext } from "@/lib/server/auth";
import { getStore } from "@/lib/server/store";
import { nowIso } from "@/lib/trace";

export const runtime = "nodejs";

async function handlePATCH(
  request: Request,
  context: RouteContext<"/api/projects/[projectId]/library/[assetId]">,
) {
  try {
    const user = await getUserContext(request);
    const { projectId, assetId } = await context.params;
    const store = getStore();
    const project = await store.getProject(projectId);
    if (!project || project.userId !== user.id) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    const existing = await store.getLibraryAsset(user.id, assetId);
    if (!existing) {
      return NextResponse.json({ error: "Library asset not found" }, { status: 404 });
    }
    const body = LibraryAssetUpdateRequest.parse(await request.json());
    const patch = {
      name: body.name,
      tags: body.tags,
      metadata: body.metadata ? { ...existing.metadata, ...body.metadata } : undefined,
    } as Parameters<typeof store.updateLibraryAsset>[2];
    if (body.favorite !== undefined) {
      patch.favoriteAt = body.favorite ? existing.favoriteAt ?? nowIso() : undefined;
    }
    const asset = await store.updateLibraryAsset(user.id, assetId, patch);
    const [libraryAssets, libraryCollections, media, sessions] = await Promise.all([
      store.listLibraryAssets(user.id),
      store.listLibraryCollections(user.id),
      store.listProjectMedia(projectId),
      store.listMediaSessions(projectId),
    ]);
    return NextResponse.json({ projectId, libraryAsset: asset, libraryAssets, libraryCollections, media, sessions });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Library asset update failed";
    console.error("PATCH /api/projects/[projectId]/library/[assetId] failed", error);
    return apiErrorResponse(error, message);
  }
}

async function handleDELETE(
  request: Request,
  context: RouteContext<"/api/projects/[projectId]/library/[assetId]">,
) {
  try {
    const user = await getUserContext(request);
    const { projectId, assetId } = await context.params;
    const project = await getStore().getProject(projectId);
    if (!project || project.userId !== user.id) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    const asset = await getStore().deleteLibraryAsset(user.id, assetId);
    if (!asset) {
      return NextResponse.json({ error: "Library asset not found" }, { status: 404 });
    }
    if (asset.source === "upload" || asset.source === "url") {
      await deleteBlobUrl(asset.url);
    }
    const [libraryAssets, libraryCollections, media, sessions] = await Promise.all([
      getStore().listLibraryAssets(user.id),
      getStore().listLibraryCollections(user.id),
      getStore().listProjectMedia(projectId),
      getStore().listMediaSessions(projectId),
    ]);
    return NextResponse.json({ projectId, deletedAssetId: asset.id, libraryAssets, libraryCollections, media, sessions });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Library asset delete failed";
    console.error("DELETE /api/projects/[projectId]/library/[assetId] failed", error);
    return apiErrorResponse(error, message);
  }
}

export async function PATCH(
  request: Request,
  context: RouteContext<"/api/projects/[projectId]/library/[assetId]">,
) {
  return actionRequest(request, () => handlePATCH(request, context));
}

export async function DELETE(
  request: Request,
  context: RouteContext<"/api/projects/[projectId]/library/[assetId]">,
) {
  return actionRequest(request, () => handleDELETE(request, context));
}
