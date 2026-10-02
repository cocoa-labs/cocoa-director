import { actionRequest } from "@/lib/server/action-request";
import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/server/api-error";

import { AdvanceRequest } from "@/lib/schemas";
import { getProviderMode } from "@/lib/server/config";
import { SpendGuardError } from "@/lib/server/spend-guard";
import { getStore } from "@/lib/server/store";
import {
  assertVideoActionAllowed,
  estimateAdvanceCents,
  spendGuardResponse,
} from "@/lib/server/video-action-guard";
import { authorizeVideoRequest, idempotencyKeyFromRequest } from "@/lib/server/videos";

export const runtime = "nodejs";

async function handlePOST(request: Request, context: RouteContext<"/api/videos/[id]/advance">) {
  try {
    const { id } = await context.params;
    const body = await safeJson(request);
    const input = AdvanceRequest.parse(body);
    const auth = await authorizeVideoRequest(request, id);
    if (auth.response) return auth.response;
    const existing = auth.job;
    const idempotencyKey = idempotencyKeyFromRequest(request, input);
    if (!idempotencyKey) {
      return NextResponse.json({ error: "Missing Idempotency-Key header" }, { status: 400 });
    }

    const guard = await assertVideoActionAllowed({
      action: "advance",
      estimatedCostCents: estimateAdvanceCents(existing),
      idempotencyKey,
      job: existing,
      metadata: { currentPhase: existing.currentPhase },
      user: auth.user,
    });
    if (guard.replayed) {
      return NextResponse.json({ videoId: id, state: existing.status, currentPhase: existing.currentPhase, replayed: true });
    }

    if (getProviderMode() === "live") {
      await getStore().updateJob(id, { status: "pending", error: undefined });
      const { start } = await import("workflow/api");
      const { runVideoAdvanceWorkflow } = await import("@/workflow/live");
      await start(runVideoAdvanceWorkflow, [id, existing.currentPhase]);
      return NextResponse.json(
        { videoId: id, state: "pending", currentPhase: existing.currentPhase, queued: true },
        { status: 202 },
      );
    }

    const { advanceVideoToNextGate } = await import("@/workflow");
    const job = await advanceVideoToNextGate(id);
    return NextResponse.json({ videoId: job.id, state: job.status, currentPhase: job.currentPhase });
  } catch (error) {
    if (error instanceof SpendGuardError) return spendGuardResponse(error);
    const message = error instanceof Error ? error.message : "Advance failed";
    console.error("POST /api/videos/[id]/advance failed", error);
    return apiErrorResponse(error, message);
  }
}

async function safeJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

export async function POST(request: Request, context: RouteContext<"/api/videos/[id]/advance">) {
  return actionRequest(request, () => handlePOST(request, context));
}
