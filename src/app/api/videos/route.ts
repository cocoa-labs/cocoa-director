import { actionRequest, rememberActionResource } from "@/lib/server/action-request";
import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/server/api-error";

import { VideoCreateRequest } from "@/lib/schemas";
import { applySeedDefaults } from "@/lib/seed-policy";
import { getUserContext } from "@/lib/server/auth";
import { getProviderMode } from "@/lib/server/config";
import { SpendGuardError } from "@/lib/server/spend-guard";
import { getStore } from "@/lib/server/store";
import {
  assertVideoActionAllowed,
  estimateCreateVideoCents,
  recordVideoActionSubmitted,
  spendGuardResponse,
} from "@/lib/server/video-action-guard";
import { idempotencyKeyFromRequest } from "@/lib/server/videos";

export const runtime = "nodejs";

async function handlePOST(request: Request) {
  try {
    const user = await getUserContext(request);
    const body = await request.json();
    // Parse, then apply seed-driven defaults (a "YOU" seed forces performer mode) so the
    // guard, estimate, and persisted job all see the effective visual mode. Consent is
    // already enforced structurally: VideoCreateRequest requires affirmed consent on every
    // character subject, so a parse that reaches here has consented seeds.
    const input = applySeedDefaults(VideoCreateRequest.parse(body));
    const idempotencyKey = idempotencyKeyFromRequest(request, body);
    if (!idempotencyKey) {
      return NextResponse.json({ error: "Missing Idempotency-Key header" }, { status: 400 });
    }
    const guard = await assertVideoActionAllowed({
      action: input.autopilot ? "create_video_autopilot" : "create_video_stage",
      estimatedCostCents: estimateCreateVideoCents(input),
      idempotencyKey,
      metadata: { durationSeconds: input.durationSeconds, visualMode: input.visualMode },
      recordSubmitted: false,
      user,
    });
    const existingVideoId = typeof guard.event?.metadata.videoId === "string"
      ? guard.event.metadata.videoId
      : undefined;
    if (guard.replayed && existingVideoId) {
      return NextResponse.json({ videoId: existingVideoId, autopilot: input.autopilot, replayed: true });
    }

    const job = await getStore().createJob(input, user);
    await recordVideoActionSubmitted({
      action: input.autopilot ? "create_video_autopilot" : "create_video_stage",
      estimatedCostCents: estimateCreateVideoCents(input),
      idempotencyKey,
      job,
      metadata: { durationSeconds: input.durationSeconds, videoId: job.id, visualMode: input.visualMode },
      user,
    });
    await rememberActionResource({ videoId: job.id, autopilot: input.autopilot });
    if (input.autopilot) {
      await startAutopilot(job.id);
    } else {
      const { runInitialTreatment } = await import("@/workflow");
      await runInitialTreatment(job.id);
    }
    return NextResponse.json({ videoId: job.id, autopilot: input.autopilot });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof SpendGuardError) return spendGuardResponse(error);
    const message = error instanceof Error ? error.message : "Invalid request";
    console.error("POST /api/videos failed", error);
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
