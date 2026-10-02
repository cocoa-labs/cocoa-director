import { actionRequest } from "@/lib/server/action-request";
import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/server/api-error";

import { createArtifactSnapshot, restorePatchForVersion } from "@/lib/editor";
import { getStore } from "@/lib/server/store";
import { authorizeVideoRequest } from "@/lib/server/videos";

export const runtime = "nodejs";

async function handlePOST(
  request: Request,
  context: RouteContext<"/api/videos/[id]/versions/[versionId]/restore">,
) {
  try {
    const { id, versionId } = await context.params;
    const store = getStore();
    const auth = await authorizeVideoRequest(request, id);
    if (auth.response) return auth.response;
    const job = auth.job;

    const version = job.artifactVersions.find((candidate) => candidate.id === versionId);
    if (!version) {
      return NextResponse.json({ error: "Version not found" }, { status: 404 });
    }

    const snapshot = createArtifactSnapshot(
      job,
      { scope: version.scope, phase: version.phase, targetId: version.targetId },
      `Before restoring ${version.label}`,
    );
    const updated = await store.updateJob(id, {
      ...restorePatchForVersion(job, version),
      artifactVersions: snapshot ? [...job.artifactVersions, snapshot] : job.artifactVersions,
      error: undefined,
    });

    return NextResponse.json({ videoId: updated.id, restoredVersionId: version.id, job: updated });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Version restore failed";
    console.error("POST /api/videos/[id]/versions/[versionId]/restore failed", error);
    return apiErrorResponse(error, message);
  }
}

export async function POST(
  request: Request,
  context: RouteContext<"/api/videos/[id]/versions/[versionId]/restore">,
) {
  return actionRequest(request, () => handlePOST(request, context));
}
