import { actionRequest } from "@/lib/server/action-request";
import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/server/api-error";

import { MediaGenerationCreateRequest } from "@/lib/schemas";
import { createProjectMediaGeneration } from "@/lib/server/media";
import { authorizeProjectRequest } from "@/lib/server/projects";
import { assertMediaGenerationAllowed, SpendGuardError } from "@/lib/server/spend-guard";
import { getStore } from "@/lib/server/store";

export const runtime = "nodejs";

async function handlePOST(
  request: Request,
  context: RouteContext<"/api/projects/[projectId]/media/generations">,
) {
  try {
    const { projectId } = await context.params;
    const auth = await authorizeProjectRequest(request, projectId);
    if (auth.response) return auth.response;

    const payload = await request.json();
    const idempotencyKey = request.headers.get("idempotency-key") ?? payload.idempotencyKey;
    const body = MediaGenerationCreateRequest.parse({ ...payload, idempotencyKey });
    if (body.execute && !body.idempotencyKey) {
      return NextResponse.json({ error: "Missing Idempotency-Key header" }, { status: 400 });
    }
    await assertMediaGenerationAllowed(auth.user, body, { projectId });
    if (body.videoJobId) {
      const job = await getStore().getJob(body.videoJobId);
      if (!job || job.projectId !== projectId) {
        return NextResponse.json({ error: "Video job does not belong to this project" }, { status: 404 });
      }
    }

    const result = await createProjectMediaGeneration(projectId, body);
    if (body.execute) {
      const auditStatus =
        result.generation.status === "success"
          ? "success"
          : result.generation.status === "failed"
            ? "failed"
            : "submitted";
      await getStore().createProviderAuditEvent({
        userId: auth.user.id,
        projectId,
        videoJobId: body.videoJobId,
        mediaGenerationId: result.generation.id,
        provider: result.generation.provider,
        model: result.generation.model,
        status: auditStatus,
        estimatedCostCents: 0,
        actualCostCents: result.generation.costCents,
        requestId: result.generation.requestId,
        idempotencyKey: body.idempotencyKey,
        error: result.generation.error,
        metadata: { kind: body.kind, source: "project_media_generation" },
      });
    }
    const [media, libraryAssets, libraryCollections] = await Promise.all([
      getStore().listProjectMedia(projectId),
      getStore().listLibraryAssets(auth.user.id),
      getStore().listLibraryCollections(auth.user.id),
    ]);
    return NextResponse.json({ projectId, ...result, library: media, libraryAssets, libraryCollections }, { status: body.execute ? 201 : 202 });
  } catch (error) {
    if (error instanceof SpendGuardError) {
      return NextResponse.json({ error: error.message, ...error.details }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : "Media generation failed";
    console.error("POST /api/projects/[projectId]/media/generations failed", error);
    return apiErrorResponse(error, message);
  }
}

export async function POST(
  request: Request,
  context: RouteContext<"/api/projects/[projectId]/media/generations">,
) {
  return actionRequest(request, () => handlePOST(request, context));
}
