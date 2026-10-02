import { actionRequest } from "@/lib/server/action-request";
import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/server/api-error";

import { MediaSessionGenerationRequest } from "@/lib/schemas";
import { getUserContext } from "@/lib/server/auth";
import { createMediaSessionGeneration } from "@/lib/server/media-sessions";
import { assertMediaGenerationAllowed, SpendGuardError } from "@/lib/server/spend-guard";
import { getStore } from "@/lib/server/store";

export const runtime = "nodejs";

async function handlePOST(
  request: Request,
  context: RouteContext<"/api/projects/[projectId]/media-sessions/[sessionId]/generations">,
) {
  try {
    const user = await getUserContext(request);
    const { projectId, sessionId } = await context.params;
    const project = await getStore().getProject(projectId);
    if (!project || project.userId !== user.id) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    const payload = await request.json();
    const idempotencyKey = request.headers.get("idempotency-key") ?? payload.idempotencyKey;
    const body = MediaSessionGenerationRequest.parse({ ...payload, idempotencyKey });
    if (body.execute && !body.idempotencyKey) {
      return NextResponse.json({ error: "Missing Idempotency-Key header" }, { status: 400 });
    }
    const session = await getStore().getMediaSession(projectId, sessionId);
    if (!session) {
      return NextResponse.json({ error: "Media session not found" }, { status: 404 });
    }
    const mediaKind = session.kind === "image" || session.kind === "video" || session.kind === "music" || session.kind === "render"
      ? session.kind
      : null;
    if (mediaKind) {
      await assertMediaGenerationAllowed(user, {
        kind: mediaKind,
        provider: body.provider,
        prompt: body.prompt,
        controls: body.controls,
        inputAssetIds: body.inputAssetIds,
        execute: body.execute,
        idempotencyKey: body.idempotencyKey,
        label: body.label,
      }, { projectId, mediaSessionId: sessionId });
    }
    const result = await createMediaSessionGeneration(projectId, sessionId, body);
    if (body.execute) {
      const auditStatus =
        result.generation.status === "success"
          ? "success"
          : result.generation.status === "failed"
            ? "failed"
            : "submitted";
      await getStore().createProviderAuditEvent({
        userId: user.id,
        projectId,
        mediaSessionId: sessionId,
        mediaGenerationId: result.generation.id,
        provider: result.generation.provider,
        model: result.generation.model,
        status: auditStatus,
        estimatedCostCents: 0,
        actualCostCents: result.generation.costCents,
        requestId: result.generation.requestId,
        idempotencyKey: body.idempotencyKey,
        error: result.generation.error,
        metadata: { kind: mediaKind, source: "media_session_generation" },
      });
    }
    const [media, sessions, libraryAssets, libraryCollections] = await Promise.all([
      getStore().listProjectMedia(projectId),
      getStore().listMediaSessions(projectId),
      getStore().listLibraryAssets(user.id),
      getStore().listLibraryCollections(user.id),
    ]);
    return NextResponse.json({ projectId, ...result, media, sessions, libraryAssets, libraryCollections }, { status: 201 });
  } catch (error) {
    if (error instanceof SpendGuardError) {
      return NextResponse.json({ error: error.message, ...error.details }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : "Media session generation failed";
    console.error("POST /api/projects/[projectId]/media-sessions/[sessionId]/generations failed", error);
    return apiErrorResponse(error, message);
  }
}

export async function POST(
  request: Request,
  context: RouteContext<"/api/projects/[projectId]/media-sessions/[sessionId]/generations">,
) {
  return actionRequest(request, () => handlePOST(request, context));
}
