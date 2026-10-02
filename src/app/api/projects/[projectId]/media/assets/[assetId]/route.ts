import { actionRequest } from "@/lib/server/action-request";
import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/server/api-error";

import { deleteBlobUrl } from "@/lib/server/blob";
import { authorizeProjectRequest } from "@/lib/server/projects";
import { getStore } from "@/lib/server/store";

export const runtime = "nodejs";

async function handleDELETE(
  request: Request,
  context: RouteContext<"/api/projects/[projectId]/media/assets/[assetId]">,
) {
  try {
    const { projectId, assetId } = await context.params;
    const auth = await authorizeProjectRequest(request, projectId);
    if (auth.response) return auth.response;

    const asset = await getStore().deleteMediaAsset(projectId, assetId);
    if (!asset) {
      return NextResponse.json({ error: "Media asset not found" }, { status: 404 });
    }
    await deleteBlobUrl(asset.url);
    const media = await getStore().listProjectMedia(projectId);
    return NextResponse.json({ projectId, deletedAssetId: asset.id, media });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Media asset delete failed";
    console.error("DELETE /api/projects/[projectId]/media/assets/[assetId] failed", error);
    return apiErrorResponse(error, message);
  }
}

export async function DELETE(
  request: Request,
  context: RouteContext<"/api/projects/[projectId]/media/assets/[assetId]">,
) {
  return actionRequest(request, () => handleDELETE(request, context));
}
