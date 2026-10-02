import { actionRequest, rememberActionResource } from "@/lib/server/action-request";
import { NextResponse } from "next/server";

import { ProductionCreateRequest } from "@/lib/schemas";
import { ApiRequestError, apiErrorResponse } from "@/lib/server/api-error";
import { getUserContext } from "@/lib/server/auth";
import { getProviderMode } from "@/lib/server/config";
import { createProduction } from "@/lib/server/productions";
import { SpendGuardError } from "@/lib/server/spend-guard";
import {
  assertVideoActionAllowed,
  estimateCreateVideoCents,
  recordVideoActionSubmitted,
  spendGuardResponse,
} from "@/lib/server/video-action-guard";
import { idempotencyKeyFromRequest } from "@/lib/server/videos";
import { legacyVideoRequestForProduction } from "@/lib/production";

export const runtime = "nodejs";

async function handlePOST(request: Request) {
  try {
    const user = await getUserContext(request);
    const body = await request.json();
    const input = ProductionCreateRequest.parse(body);
    const idempotencyKey = idempotencyKeyFromRequest(request, body);
    if (!idempotencyKey) {
      return NextResponse.json({ error: "Missing Idempotency-Key header" }, { status: 400 });
    }

    const legacyRequest = legacyVideoRequestForProduction(input);
    const estimatedCostCents = input.contentType === "music_video" ? estimateCreateVideoCents(legacyRequest) : input.contentType === "news_digest" || input.contentType === "explainer" ? 200 : 50;
    const action = input.contentType === "music_video"
      ? input.autopilot ? "create_video_autopilot" : "create_video_stage"
      : `create_${input.contentType}_draft`;
    const guard = await assertVideoActionAllowed({
      action,
      estimatedCostCents,
      idempotencyKey,
      metadata: { contentType: input.contentType, durationSeconds: input.targetDurationSeconds },
      recordSubmitted: false,
      user,
    });
    const existingProductionId = typeof guard.event?.metadata.videoId === "string"
      ? guard.event.metadata.videoId
      : undefined;
    if (guard.replayed && existingProductionId) {
      return NextResponse.json({ productionId: existingProductionId, replayed: true });
    }

    const job = await createProduction(input, user);
    await recordVideoActionSubmitted({
      action,
      estimatedCostCents,
      idempotencyKey,
      job,
      metadata: { contentType: input.contentType, durationSeconds: input.targetDurationSeconds, videoId: job.id },
      user,
    });

    await rememberActionResource({ productionId: job.id, videoId: job.id, contentType: input.contentType, workflowVersion: job.workflowVersion, requiresReview: input.contentType !== "music_video" });
    if (input.contentType === "music_video") {
      if (input.autopilot) await startAutopilot(job.id);
      else {
        const { runInitialTreatment } = await import("@/workflow");
        await runInitialTreatment(job.id);
      }
    }

    return NextResponse.json({
      productionId: job.id,
      videoId: job.id,
      contentType: input.contentType,
      workflowVersion: job.workflowVersion,
      requiresReview: input.contentType !== "music_video",
    });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof SpendGuardError) return spendGuardResponse(error);
    const message = error instanceof Error ? error.message : "Invalid request";
    if (!(error instanceof ApiRequestError)) console.error("POST /api/productions failed", error);
    return apiErrorResponse(error, message);
  }
}

async function startAutopilot(videoId: string) {
  const { runVideoAutopilot } = await import("@/workflow/autopilot");
  if (getProviderMode() === "mock") {
    const { runMockAutopilot } = await import("@/workflow");
    await runMockAutopilot(videoId);
    return;
  }
  const { start } = await import("workflow/api");
  await start(runVideoAutopilot, [videoId]);
}

export async function POST(request: Request) {
  return actionRequest(request, () => handlePOST(request));
}
