import { actionRequest } from "@/lib/server/action-request";
import { NextResponse } from "next/server";
import { z } from "zod";

import { VisualBeatKind } from "@/lib/schemas";
import { attachVisualPlanToStoryboard, withUpdatedVisualBeat } from "@/lib/hybrid-visuals";
import { apiErrorResponse } from "@/lib/server/api-error";
import { updateNewsDraft } from "@/lib/server/news-editorial";
import { SpendGuardError } from "@/lib/server/spend-guard";
import { assertVideoActionAllowed, spendGuardResponse } from "@/lib/server/video-action-guard";
import { authorizeVideoRequest, idempotencyKeyFromRequest } from "@/lib/server/videos";

export const runtime = "nodejs";

const BeatUpdate = z.object({
  kind: VisualBeatKind.optional(),
  intent: z.string().trim().min(1).max(1_000).optional(),
  generationPrompt: z.string().trim().min(1).max(2_000).optional(),
  motionDirection: z.string().trim().min(1).max(500).optional(),
  locked: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0, "Supply a visual beat field to update");

async function handlePATCH(request: Request, context: { params: Promise<{ id: string; beatId: string }> }) {
  try {
    const { id, beatId } = await context.params;
    const auth = await authorizeVideoRequest(request, id);
    if (auth.response) return auth.response;
    if (!auth.job.visualPlan || !auth.job.storyboard) throw new Error("This production does not have a hybrid visual plan.");
    const current = auth.job.visualPlan.beats.find((beat) => beat.id === beatId);
    if (!current) return NextResponse.json({ error: "Visual beat not found." }, { status: 404 });
    const patch = BeatUpdate.parse(await request.json());
    if (current.locked && patch.locked !== false) return NextResponse.json({ error: "Unlock this visual beat before editing it." }, { status: 409 });
    const disclosure = patch.kind === "synthetic_reenactment"
      ? { required: true, persistent: true, label: "AI-GENERATED REENACTMENT", reason: "Synthetic current-event reconstruction; illustrative and not source evidence.", publicFigures: current.disclosure.publicFigures, currentEvent: true }
      : patch.kind
        ? { required: false, persistent: false, publicFigures: [], currentEvent: false }
        : undefined;
    const visualPlan = withUpdatedVisualBeat(auth.job.visualPlan, beatId, { ...patch, ...(disclosure ? { disclosure } : {}) });
    const storyboard = attachVisualPlanToStoryboard(auth.job.storyboard, visualPlan);
    const job = await updateNewsDraft({ job: auth.job, visualPlan, storyboard });
    return NextResponse.json({ productionId: job.id, beat: job.visualPlan?.beats.find((beat) => beat.id === beatId), visualPlan: job.visualPlan });
  } catch (error) {
    if (error instanceof Response) return error;
    return apiErrorResponse(error, error instanceof Error ? error.message : "Visual beat update failed");
  }
}

const BeatAction = z.object({ action: z.literal("regenerate") });

async function handlePOST(request: Request, context: { params: Promise<{ id: string; beatId: string }> }) {
  try {
    const { id, beatId } = await context.params;
    const auth = await authorizeVideoRequest(request, id);
    if (auth.response) return auth.response;
    const body = BeatAction.parse(await request.json());
    const beat = auth.job.visualPlan?.beats.find((candidate) => candidate.id === beatId);
    if (!beat) return NextResponse.json({ error: "Visual beat not found." }, { status: 404 });
    const idempotencyKey = idempotencyKeyFromRequest(request, body);
    if (!idempotencyKey) return NextResponse.json({ error: "Missing Idempotency-Key header" }, { status: 400 });
    const guard = await assertVideoActionAllowed({
      action: "regenerate_hybrid_visual_beat",
      estimatedCostCents: beat.costEstimateCents,
      idempotencyKey,
      job: auth.job,
      metadata: { beatId, kind: beat.kind },
      user: auth.user,
    });
    if (guard.replayed) return NextResponse.json({ productionId: id, state: auth.job.status, replayed: true });
    const { runHybridBeatRegenerationWorkflow } = await import("@/workflow/news");
    if (process.env.NODE_ENV === "test") {
      const job = await runHybridBeatRegenerationWorkflow(id, beatId);
      return NextResponse.json({ productionId: id, job });
    }
    const { start } = await import("workflow/api");
    const run = await start(runHybridBeatRegenerationWorkflow, [id, beatId]);
    return NextResponse.json({ productionId: id, runId: run.runId, state: "running" }, { status: 202 });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof SpendGuardError) return spendGuardResponse(error);
    return apiErrorResponse(error, error instanceof Error ? error.message : "Visual beat regeneration failed");
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string; beatId: string }> }) {
  return actionRequest(request, () => handlePOST(request, context));
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string; beatId: string }> }) {
  return actionRequest(request, () => handlePATCH(request, context));
}
